// api/exchange-engine.js
// THE EXCHANGE — equities desk brain. Week-long stock ideas, screenshot parsing,
// position health reviews, shadow book and learning loop, all shaped for shares.
// Sibling to terminal-engine.js. State lives in Upstash Redis.
//
// Env vars required on Vercel:
//   ANTHROPIC_API_KEY
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (or KV_REST_API_URL / KV_REST_API_TOKEN)

import { getNews } from './exchange-news.js';
import { enrichTickers, signalsBlock } from './exchange-massive.js';

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const MODEL = 'claude-sonnet-4-6';

// ---------- Redis ----------
async function rGet(key) {
  const r = await fetch(`${R_URL}/get/${key}`, { headers: { Authorization: `Bearer ${R_TOK}` } });
  // audit finding 7: a transient failure must NOT masquerade as empty state (which would make
  // the whole book look wiped). Fail loudly so callers abort rather than proceed on phantom data.
  if (!r.ok) throw new Error(`Storage read failed (${r.status}). Your data is safe — a connection issue, not a change. Try again shortly.`);
  const j = await r.json();
  if (j.result == null) return null; // genuinely absent key is fine
  try { return JSON.parse(j.result); }
  catch { throw new Error(`Stored data for "${key}" was unreadable (corrupt value). Not proceeding, to avoid overwriting it.`); }
}
async function rSet(key, val) {
  const r = await fetch(`${R_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOK}` },
    body: JSON.stringify(val),
  });
  // audit finding 7: a failed write must NOT report success, or the UI shows a change that never saved.
  if (!r.ok) throw new Error(`Storage write failed (${r.status}). Your change may not have saved — please retry.`);
  return true;
}

// Best-effort cache adapter for the Massive enrichment layer. Unlike rGet/rSet, this NEVER
// throws: a cached quant-signal bundle is a nice-to-have, and a cache read/write hiccup must
// never abort an ideas hunt or a review. Genuine state (the book, ledger) still uses rGet/rSet.
const massiveCache = {
  get: async (key) => { try { return await rGet(key); } catch { return null; } },
  set: async (key, val) => { try { await rSet(key, val); } catch { /* best-effort */ } },
};

// ---------- Bangkok clock (Hammy trades from Phuket) ----------
function bkk() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t)?.value || '';
  return {
    dateKey: `${g('year')}-${g('month')}-${g('day')}`,
    dmy: `${g('day')}/${g('month')}/${g('year')}`,
    hour: parseInt(g('hour'), 10),
    minute: parseInt(g('minute'), 10),
    weekday: g('weekday'),
    isWeekend: ['Sat', 'Sun'].includes(g('weekday')),
    iso: now.toISOString(),
  };
}
const daysHeld = (openedAt) => Math.max(0, Math.floor((Date.now() - openedAt) / 86400000));

// ---------- Live stock prices (Finnhub free tier, real-time US quotes) ----------
// Gives the desk genuine eyes onto the market so ideas anchor to real prices and the
// validator can catch a mispriced idea. Degrades gracefully: no key, an unreachable
// feed, or an unknown ticker simply returns null and the desk carries on honestly.
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY || '';

async function livePrice(ticker) {
  if (!FINNHUB_KEY || !ticker) return null;
  const sym = String(ticker).toUpperCase().replace(/[^A-Z.]/g, '');
  if (!sym) return null;
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
    if (!r.ok) return null;
    const j = await r.json();
    // Finnhub returns c = current price. 0 means the symbol was not recognised.
    const c = typeof j.c === 'number' ? j.c : null;
    return c && c > 0 ? +c.toFixed(2) : null;
  } catch {
    return null;
  }
}

// Fetch many tickers at once, returning a map keyed by uppercased ticker.
async function livePrices(tickers) {
  const list = [...new Set((tickers || []).map((t) => String(t || '').toUpperCase()).filter(Boolean))];
  const out = {};
  await Promise.all(list.map(async (t) => {
    const p = await livePrice(t);
    if (p != null) out[t] = p;
  }));
  return out;
}

// Guard against a US-focused feed returning a bogus price for a regional ticker (e.g. an
// SGX symbol colliding with a different US listing). Given a feed price and a trusted
// reference (the platform's last price, or avg cost), return the feed price only if it is
// plausibly close; otherwise return the reference. tol is the max fractional disagreement.
function sanePrice(feed, reference, tol = 0.6) {
  const f = num(feed), r = num(reference);
  if (f == null) return { price: r, usedFeed: false, rejected: false };
  if (r == null || r <= 0) return { price: f, usedFeed: true, rejected: false };
  const disagreement = Math.abs(f - r) / r;
  if (disagreement > tol) return { price: r, usedFeed: false, rejected: true };
  return { price: f, usedFeed: true, rejected: false };
}

// ---------- Claude ----------
async function claude(userContent, maxTokens = 2000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Claude API error');
  // if the model hit the token ceiling, the JSON will be truncated; say so clearly
  if (j.stop_reason === 'max_tokens') {
    throw new Error('The desk had more to say than the response could hold (hit the token limit). Try again; if it persists this analysis needs a bigger allowance.');
  }
  const text = (j.content || []).map((c) => c.text || '').join('\n');
  const clean = text.replace(/```json|```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m ? m[0] : clean);
  } catch (e) {
    // a parse failure here almost always means a truncated or malformed response;
    // give a human message rather than a raw "position 7955" JSON error.
    throw new Error('The desk returned an incomplete response and could not be read. Please try again in a moment.');
  }
}

// ---------- Equity level validator ----------
// Guards against nonsensical numbers on a stock idea. Shares differ from forex:
// no pip convention, but percentages still discipline the levels. A one-week swing
// should have a sane stop (not so tight noise triggers it, not so wide it is absurd)
// and an entry near the current price.
function num(v) {
  if (v == null) return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
// When an idea's stated levels are anchored to a wrong price but we KNOW the real live
// price, derive sensible entry/target/stop around the REAL price so the card never shows
// levels that are tens of percent off. Uses conservative swing-trade geometry. Returns the
// recomputed level strings, or null if we cannot (no real price / bad direction).
function recomputeLevels(idea, realPrice) {
  const dir = (idea.direction || '').toUpperCase();
  const px = num(realPrice);
  if (px == null || px <= 0 || (dir !== 'BUY' && dir !== 'SELL')) return null;
  // sensible one-week swing defaults: entry a touch off current, ~5% target, ~4% stop (R:R ~1.25)
  const round = (v) => px >= 20 ? +v.toFixed(2) : +v.toFixed(4);
  if (dir === 'BUY') {
    const entryLo = round(px * 0.995), entryHi = round(px * 1.005);
    return { entry: `${entryLo}-${entryHi}`, tp: String(round(px * 1.05)), sl: String(round(px * 0.96)), recomputed: true };
  }
  const entryLo = round(px * 0.995), entryHi = round(px * 1.005);
  return { entry: `${entryLo}-${entryHi}`, tp: String(round(px * 0.95)), sl: String(round(px * 1.04)), recomputed: true };
}

function checkLevels(idea, realPrice) {
  const dir = (idea.direction || '').toUpperCase();
  const entry = num(idea.entry);
  let cur = num(idea.current_price);
  const tp = num(idea.tp);
  const sl = num(idea.sl);
  if (entry == null || tp == null || sl == null) return { ok: false, reason: 'missing a numeric entry, TP or SL' };
  if (entry <= 0) return { ok: false, reason: `entry ${entry} is not a positive price` };
  if (dir !== 'BUY' && dir !== 'SELL') return { ok: false, reason: 'direction not BUY/SELL' };

  // 0) REALITY CHECK: if a genuine live price is supplied, the idea's stated current
  // price must match it closely. This catches a gem anchored to a stale/hallucinated
  // price (e.g. claiming 58 when the market is 94). A >6% gap fails outright.
  // It ALSO catches a wrong-instrument feed hit: if the model's stated price and the feed
  // price disagree by a huge margin (e.g. a regional ticker colliding with a US listing),
  // we cannot trust EITHER blindly, so we fail and ask for manual confirmation rather than
  // display a figure we cannot stand behind.
  if (realPrice != null && realPrice > 0) {
    if (cur != null) {
      const gap = Math.abs(cur - realPrice) / realPrice;
      if (gap > 0.6) return { ok: false, reason: `the live feed (${realPrice}) and the stated price (${cur}) disagree wildly — likely a wrong-instrument feed hit for this ticker; confirm the real price on your platform`, realPrice, feedSuspect: true };
      if (gap > 0.06) return { ok: false, reason: `stated price ${cur} is ${(gap * 100).toFixed(1)}% off the live price ${realPrice} — levels are anchored to a wrong price`, realPrice };
    }
    // trust the live price as the reference for the entry-proximity check below
    cur = realPrice;
  }

  // 1) entry should sit within ~8% of the current price. A week-long swing
  // entry further out than that is really a limit order that may never fill.
  if (cur != null && cur > 0) {
    const drift = Math.abs(entry - cur) / cur;
    if (drift > 0.08) return { ok: false, reason: `entry ${entry} is ${(drift * 100).toFixed(1)}% from current ${cur} — too far to fill in a week` };
  }
  // 2) geometry: BUY => SL below entry, TP above; SELL => the reverse.
  if (dir === 'BUY' && !(sl < entry && tp > entry)) return { ok: false, reason: `BUY needs SL(${sl}) below and TP(${tp}) above entry(${entry})` };
  if (dir === 'SELL' && !(sl > entry && tp < entry)) return { ok: false, reason: `SELL needs SL(${sl}) above and TP(${tp}) below entry(${entry})` };

  // 3) stop distance sane for a one-week hold: a stock stop tighter than ~2% will be
  // shaken out by normal daily wobble; wider than ~15% is not a one-week swing.
  const slPct = Math.abs(entry - sl) / entry * 100;
  const tpPct = Math.abs(tp - entry) / entry * 100;
  if (slPct < 2) return { ok: false, reason: `stop only ${slPct.toFixed(1)}% away — daily noise will trigger it` };
  if (slPct > 15) return { ok: false, reason: `stop ${slPct.toFixed(1)}% away — too wide for a one-week swing` };
  if (tpPct < 2) return { ok: false, reason: `target only ${tpPct.toFixed(1)}% away — not worth the risk` };

  // 4) reward should beat risk
  const rr = slPct ? +(tpPct / slPct).toFixed(2) : null;
  if (rr != null && rr < 1) return { ok: false, reason: `reward:risk ${rr} below 1 — target closer than stop` };
  return { ok: true, rr, slPct: +slPct.toFixed(1), tpPct: +tpPct.toFixed(1), realPrice: realPrice ?? null };
}

// ---------- State ----------
async function loadAll() {
  const [book, lessons, ledger, guidance, guidanceMeta, universe] = await Promise.all([
    rGet('exchange:book'), rGet('exchange:lessons'), rGet('exchange:ledger'),
    rGet('exchange:guidance'), rGet('exchange:guidanceMeta'), rGet('exchange:universe'),
  ]);
  return {
    book: book || { holdings: [], pendingReview: [], netLiq: null, netLiqHistory: [] },
    lessons: lessons || [],
    ledger: ledger || [],
    guidance: guidance || [],
    guidanceMeta: guidanceMeta || null,
    universe: universe || { tradeable: [], unavailable: [] }, // learned NOVA availability
  };
}

// ---------- helpers for prompts ----------
function digest(items, n = 20) {
  return (items || []).slice(0, n).map((i) => `- [${i.source}]${i.ticker ? ' (' + i.ticker + ')' : ''} ${i.title}`).join('\n');
}
function holdingsSummary(book) {
  const h = book.holdings || [];
  if (!h.length) return 'no holdings synced yet';
  return h.map((x) => `${x.name}${x.ticker ? ' (' + x.ticker + ')' : ''}: ${x.qty} @ ${x.avgCost}, now ${x.lastPrice ?? '?'}, P/L ${x.unrealised ?? '?'}`).join('; ');
}

// ---------- The week-long gem-hunt ideas engine ----------
async function actIdeas(force) {
  const t = bkk();
  const key = `exchange:ideas:${t.dateKey}`;
  const cached = await rGet(key);
  // 8-hour freshness window, same civilised rhythm as The Terminal
  const STALE_MS = 8 * 3600e3;
  const cacheAge = cached && cached.generatedAt ? Date.now() - Date.parse(cached.generatedAt) : Infinity;
  if (cached && !force && cacheAge < STALE_MS) return { clock: t, ideas: cached, cached: true, cacheAgeMs: cacheAge };
  if (t.isWeekend && !force) return { clock: t, weekend: true, ideas: cached || null };

  const s = await loadAll();
  // watchlist for the news trawl: the holdings plus any names the desk has been tracking
  const heldTickers = (s.book.holdings || []).map((h) => h.ticker || h.name).filter(Boolean);
  const tickerParam = heldTickers.join(',');
  // (a) news on CURRENT holdings, and (b) BROAD market news (audit finding 4): so the hunter
  // proposes fresh names from stories it has ACTUALLY seen, not blind. Watchlist names get
  // their own trawl too if the desk has been tracking any.
  const watchTickers = (s.book.watchlist || []).map((w) => w.ticker || w.name).filter(Boolean);
  const [holdNews, marketNews, watchNews] = await Promise.all([
    getNews('holdings', tickerParam),
    getNews('market').catch(() => []),
    watchTickers.length ? getNews('holdings', watchTickers.join(',')).catch(() => []) : Promise.resolve([]),
  ]);
  // merge, de-duped by headline, holdings + market + watchlist
  const news = (() => {
    const seen = new Set(); const out = [];
    for (const it of [...holdNews, ...marketNews, ...watchNews]) {
      const k = (it.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
      if (!k || seen.has(k)) continue; seen.add(k); out.push(it);
    }
    return out;
  })();

  // freshness memory: names proposed in the last 10 days must not be repeated, and
  // names already held should not be proposed as fresh swing ideas either.
  const recent = s.ledger.filter((r) => r.idea && r.ts > Date.now() - 10 * 86400e3);
  const recentNames = new Set(recent.map((r) => (r.idea.ticker || r.idea.name || '').toUpperCase()).filter(Boolean));
  const heldNames = new Set((s.book.holdings || []).map((h) => (h.ticker || h.name || '').toUpperCase()).filter(Boolean));
  const bannedList = [...new Set([...recentNames, ...heldNames])];

  // names the user has confirmed are NOT available on Phillip Nova: never propose again
  const unavailable = new Set((s.universe.unavailable || []).map((u) => (u || '').toUpperCase()));

  // ---- Massive quant enrichment: give the model REAL technicals + insider posture on the
  // names he actively watches, so "signal convergence" is measured, not guessed. US names
  // only; regional (SGX/HKEX) tickers are skipped inside the module. Degrades to empty if
  // the Massive feed is off, so the hunt runs unchanged without a key. Reuses watchTickers
  // declared earlier in this function (do NOT redeclare — same scope). ----
  let watchSignals = { lines: [] };
  try { watchSignals = await enrichTickers(watchTickers, massiveCache); } catch { /* enrichment is a bonus, never fatal */ }

  // ---- financial headroom: what the account can honestly afford to take up ----
  // Drawn from the synced NOVA account summary so ideas are sized to reality, not fantasy.
  const acc = s.book.account || {};
  const buyingPower = num(acc.buyingPowerETD) ?? num(acc.buyingPowerSecurities);
  const netLiq = num(s.book.netLiq) ?? num(acc.netLiquidityValue);
  const initialMargin = num(acc.initialMargin);
  const marginUtilPct = (initialMargin != null && netLiq) ? (initialMargin / netLiq) * 100 : null;
  const affordLine = buyingPower != null
    ? `Your genuine buying power right now is about $${buyingPower.toFixed(0)}${netLiq != null ? ` on net liquidity of $${netLiq.toFixed(0)}` : ''}${marginUtilPct != null ? `, with roughly ${marginUtilPct.toFixed(0)}% of the account already committed as margin` : ''}. EVERY idea you propose must be genuinely affordable inside this buying power at a sensible position size; never recommend something that would need more firepower than he has.`
    : 'Account buying power is not yet synced, so size ideas conservatively and note that he should confirm affordability on his platform before taking anything.';

  const historyLines = recent.map((r) => `- ${r.date}: ${r.idea.name}${r.idea.ticker ? ' (' + r.idea.ticker + ')' : ''} ${r.idea.direction} (${r.status})`).join('\n') || '- none';
  const priorGuidance = (s.guidance || []).map((g) => `- ${g.text}${g.basis ? ' [' + g.basis + ']' : ''}`).join('\n') || '- none yet; not enough resolved history';
  const recentLessons = (s.lessons || []).slice(-10).map((l) => `- ${l.text}`).join('\n') || '- none yet';

  const prompt = `You are the ideas engine of THE EXCHANGE, the equities desk of a retail investor in Phuket who trades through Phillip Nova (a "NOVA" account) across US, Singapore, Hong Kong, Japan, Malaysia and China markets. His long-term convictions are already held; your job is DIFFERENT: hunt SHORT to SHORTER-TERM TRADES, punchy positions held a few days up to about a week. No long-term plays.

BIG PICTURE — THIS HUNT SERVES REBALANCING: his book is badly over-concentrated in US semiconductors. So this hunt is not just for any gem; it should actively help REBALANCE him across sectors AND geographies. Two things matter a lot: (a) diversify AWAY from US chips into under-represented corners, and (b) favour daytime-tradeable regional names (Singapore SGX, Hong Kong HKEX, and other Asian listings on NOVA) because he can only trade US stocks late at night when the US market opens, whereas SG/HK/regional names trade during his Phuket daytime. A great daytime-tradeable regional steal is worth more to him than yet another US name he can only touch at 3am.

YOUR MANDATE (read carefully):
1. HORIZON: every idea is a short to shorter-term trade, a few days out to roughly a week at the ceiling. Not a long-term investment. The thesis must be able to play out quickly (a catalyst, a technical bounce, a post-earnings drift, an insider-buying pop, a momentum move).
2. LEVERAGE & AGGRESSION WELCOME, BUT EARNED: he actively WANTS to be more aggressive on these shorter trades, and CFDs are welcome and often preferred precisely because they are more volatile and leveraged, which suits a punchy short-term style. HOWEVER this aggression must be EARNED, never assumed. Only lean aggressive (a CFD framing, a tighter-to-price entry, a fuller size) when there is genuine NEWS CONVERGENCE (two or more independent signals or sources pointing the same way) or otherwise strong, well-evidenced confidence. Where conviction is merely moderate, stay proportionate and say so honestly. Reckless aggression on a thin thesis is exactly what to avoid; aggression is the reward for conviction, not a default.
3. WITHIN HIS MEANS (critical): ${affordLine} State briefly in each idea's reason that it fits comfortably within his firepower.
4. HUNT STEALS THAT REBALANCE: find genuine STEALS — mispriced, overlooked, cheap-versus-worth names, not crowded obvious ones. Roam ALL industries (healthcare, energy, industrials, financials, consumer, materials, utilities, biotech, and yes occasionally tech). DELIBERATELY AVOID semiconductors and chip names: he is already saturated. Actively prize names that diversify his sector AND geographic mix.
5. MARKET SPREAD: of your ideas, actively try to include at least one daytime-tradeable regional name (SGX Singapore, HKEX Hong Kong, or another Asian NOVA-listed market) when a genuine steal exists there, so he has something to trade in daylight. US names are welcome too, but note the US ones are night-only for him.
6. WEIGH ALL FOUR SIGNAL FAMILIES and prize CONVERGENCE where several align on one name:
   - Insider & congressional buying (an insider or member of Congress recently buying with real money is a strong tell)
   - Value & fundamentals (cheap versus peers, quality at a temporary discount — the essence of a steal)
   - News & catalysts (earnings beats, upgrades, contract wins, product news, FDA decisions)
   - Technical setups (pullback into support, a clean base, a breakout with volume)
   The best idea is one where 2+ of these point the same way. Name which signals fire in the reason. Genuine convergence is what makes a steal a steal, and is precisely what licenses a more aggressive, leveraged framing per rule 2. Do NOT propose a name unless the news and the recommendation genuinely converge.
7. TRADEABILITY (critical): only propose names properly LISTED and liquid on a major exchange NOVA offers — US (NASDAQ, NYSE, NYSE American), Singapore (SGX), Hong Kong (HKEX), or other main Asian boards NOVA supports — tradeable as a share or CFD. NEVER propose OTC, pink-sheet, or nano-cap names a retail broker almost certainly cannot trade. When in doubt, prefer the more liquid, clearly-listed name. Mark each idea's availability as "likely" and note it needs his confirmation on the platform.
8. NO DUPLICATES: do NOT propose any name in this banned list (recently proposed or already held): ${bannedList.join(', ') || 'none yet'}.
9. NEVER propose any name he has flagged unavailable on his platform: ${[...unavailable].join(', ') || 'none yet'}.

CURRENT HOLDINGS (context only, do NOT propose these): ${holdingsSummary(s.book)}

RECENT IDEA HISTORY (last 10 days, for freshness):
${historyLines}

SELF-IMPROVEMENT GUIDANCE (from the desk's own tracked record; APPLY these):
${priorGuidance}

LESSONS ARCHIVE:
${recentLessons}

TODAY'S MARKET & COMPANY NEWS WIRE:
${digest(news, 28)}

QUANTITATIVE SIGNALS on his watchlist (real technicals + insider filings from Massive; use these to MEASURE convergence rather than infer it from headlines — an oversold RSI, a price reclaiming its 50-day, a MACD turning up, or a cluster of insider purchases is exactly the kind of hard evidence that EARNS an aggressive framing per rule 2):
${signalsBlock(watchSignals.lines)}

TASK: Propose exactly 2 fresh short-term STEAL ideas that help rebalance his book across sectors and markets. Try to include at least one daytime-tradeable regional name (SGX/HKEX/Asian) where a genuine steal exists. For each, indicate whether it is best taken as a plain SHARE or a more aggressive CFD, letting that follow the conviction. Present each in his journal's language: stock name, ticker, exchange, entry point, current market price, buy or sell, take profit, stop loss, and the reason (naming the converging signals, how it diversifies him, and that it fits his buying power). Only propose where news and recommendation genuinely converge. Be honest: if nothing is a real steal today, say so in desk_note and mark ideas at their true lower conviction rather than inflating them.

LEVEL DISCIPLINE (every number is validated after you respond, so get them right):
- entry must sit within ~8% of the current price (a fillable swing entry, not a far-off limit).
- BUY: stop below entry, target above. SELL: stop above entry, target below.
- stop distance sane for a one-week hold: roughly 3-10% from entry, never tighter than ~2% (daily noise) nor wider than ~15%.
- aim for reward:risk of at least 1.5. State real price levels, not round guesses.
- CONVICTION on a four-rung scale: LOW, MED, MED-HIGH, HIGH. Reserve the top two rungs for genuine multi-signal convergence.

Respond ONLY with JSON, no markdown:
{"ideas":[{"name":"Company Name","ticker":"TICK","exchange":"NASDAQ|NYSE|NYSE American|SGX|HKEX|other","industry":"e.g. Healthcare","direction":"BUY|SELL","instrument":"SHARE|CFD","current_price":"12.40","entry":"12.00-12.30","tp":"14.20","sl":"11.10","horizon":"e.g. 3-5 day trade","conviction":"LOW|MED|MED-HIGH|HIGH","signals":["insider","value","catalyst","technical"],"diversifies":"how this name helps rebalance his book (sector/geography), short phrase","daytime_tradeable":true,"reason":"the thesis, naming which signals converge and noting it fits his buying power, max 48 words","availability":"likely — confirm on your NOVA platform"}],"stand_down":false,"desk_note":"one honest paragraph on the session's hunt, max 55 words"}`;

  let ideas = await claude(prompt, 2600);

  // fetch genuine live prices for whatever the model proposed, so the validator can
  // check each idea against reality and the cards show the true market price.
  const proposedTickers = (ideas.ideas || []).map((i) => i.ticker || i.name).filter(Boolean);
  let priceMap = await livePrices(proposedTickers);
  const realFor = (i) => priceMap[(i.ticker || i.name || '').toUpperCase()] ?? null;

  // validation + no-dupe + tradeability gate, with one retry, mirroring The Terminal
  const isBanned = (i) => {
    const nm = (i.ticker || i.name || '').toUpperCase();
    return bannedList.map((b) => b.toUpperCase()).includes(nm) || unavailable.has(nm) || heldNames.has(nm);
  };
  const badLevels = (i) => !checkLevels(i, realFor(i)).ok;
  const isBad = (i) => isBanned(i) || badLevels(i);

  if ((ideas.ideas || []).some(isBad)) {
    const dupes = (ideas.ideas || []).filter(isBanned).map((i) => i.ticker || i.name);
    const lvl = (ideas.ideas || []).filter((i) => !isBanned(i) && badLevels(i)).map((i) => `${i.ticker || i.name}: ${checkLevels(i, realFor(i)).reason}`);
    // tell the model the true live prices so its retry is anchored to reality
    const priceHints = Object.entries(priceMap).map(([k, v]) => `${k} is really trading at ~$${v}`).join('; ');
    try {
      const second = await claude(prompt +
        `\n\nREJECTED, fix and resubmit two clean ideas:\n${dupes.length ? 'Duplicate/held/unavailable: ' + dupes.join(', ') + '\n' : ''}${lvl.length ? 'Broken levels: ' + lvl.join('; ') + '\n' : ''}${priceHints ? 'LIVE PRICES (anchor to these exactly): ' + priceHints : ''}`, 2600);
      if (second.ideas) {
        // price the fresh names too before accepting
        const secondTickers = second.ideas.map((i) => i.ticker || i.name).filter(Boolean);
        priceMap = { ...priceMap, ...(await livePrices(secondTickers)) };
        if (!second.ideas.some(isBad)) ideas = second;
      }
    } catch { /* fall through to flagging */ }
    (ideas.ideas || []).forEach((i) => {
      if (isBanned(i)) i.reason = ((i.reason || '') + ' [DUPLICATE/HELD WARNING]').trim();
      const real = realFor(i);
      let lc = checkLevels(i, real);
      // only trust the feed price for display when it is NOT flagged as a wrong-instrument hit
      if (real != null && !lc.feedSuspect) i.current_price = String(real); // show the true market price
      // If levels are anchored to a wrong price (but the ticker itself is fine), RECOMPUTE
      // sensible entry/TP/SL around the real live price rather than showing numbers tens of
      // percent off. These levels are what he acts on manually, so they must be right.
      if (!lc.ok && !lc.feedSuspect && real != null) {
        const rl = recomputeLevels(i, real);
        if (rl) {
          i.entry = rl.entry; i.tp = rl.tp; i.sl = rl.sl; i.levels_recomputed = true;
          lc = checkLevels(i, real);
        }
      }
      if (!lc.ok) { i.level_warning = `LEVELS UNVERIFIED: ${lc.reason}. Confirm on your chart before trading.`; i.conviction = 'LOW'; i.levels_broken = true; }
      else { i.rr = lc.rr; i.slPct = lc.slPct; i.tpPct = lc.tpPct; }
    });
  } else {
    (ideas.ideas || []).forEach((i) => {
      const real = realFor(i);
      let lc = checkLevels(i, real);
      if (real != null && !lc.feedSuspect) i.current_price = String(real);
      if (!lc.ok && !lc.feedSuspect && real != null) {
        const rl = recomputeLevels(i, real);
        if (rl) { i.entry = rl.entry; i.tp = rl.tp; i.sl = rl.sl; i.levels_recomputed = true; lc = checkLevels(i, real); }
      }
      if (!lc.ok) { i.level_warning = `LEVELS UNVERIFIED: ${lc.reason}. Confirm on your chart before trading.`; i.conviction = 'LOW'; i.levels_broken = true; }
      else { i.rr = lc.rr; i.slPct = lc.slPct; i.tpPct = lc.tpPct; }
    });
  }

  ideas.generatedAt = t.iso;
  ideas.dateKey = t.dateKey;

  // CANDIDATE VALIDATION (audit finding 4): the model proposed fresh names — now fetch news
  // for THOSE specific tickers and check the thesis is actually supported, rather than trusting
  // a claim built on news the model never saw. And enforce CONVERGENCE in code (audit finding
  // 1): a MED-HIGH/HIGH idea must have >=2 headlines genuinely mentioning it; otherwise cap it.
  const proposed = (ideas.ideas || []).filter((i) => i.ticker || i.name);
  if (proposed.length) {
    const tickers = proposed.map((i) => i.ticker || i.name).filter(Boolean).join(',');
    // distinguish a genuine "no news on this name" from a FETCH FAILURE — capping an idea for
    // lack of news is only fair if we actually managed to look. On a failed trawl we still cap
    // (cautious), but we say so honestly rather than claiming the name is unsupported.
    let candNews = null, newsFetchOk = true;
    try { candNews = await getNews('holdings', tickers); }
    catch { candNews = []; newsFetchOk = false; }
    const mentions = (idea) => {
      const tick = (idea.ticker || '').toUpperCase();
      const name = (idea.name || '').toLowerCase();
      const nameKey = name.split(/\s+/)[0]; // first word of company name
      return (candNews || []).filter((n) => {
        const hay = ((n.title || '') + ' ' + (n.desc || '')).toLowerCase();
        return (tick && hay.includes(tick.toLowerCase())) || (nameKey && nameKey.length > 3 && hay.includes(nameKey));
      });
    };
    (ideas.ideas || []).forEach((i) => {
      const hits = mentions(i);
      i.candidateNews = hits.slice(0, 4).map((n) => `[${n.source}] ${n.title}`);
      i.newsSupport = hits.length; // how many headlines actually mention this name
      i.newsChecked = newsFetchOk;
      // convergence gate: top-two conviction needs >=2 independent supporting headlines
      if (['MED-HIGH', 'HIGH'].includes((i.conviction || '').toUpperCase()) && hits.length < 2) {
        i.convictionClaimed = i.conviction;
        i.conviction = hits.length === 1 ? 'MED' : 'LOW';
        i.conviction_note = newsFetchOk
          ? `Auto-capped from ${i.convictionClaimed}: only ${hits.length} news item(s) actually mention this name — not enough verified convergence for top conviction.`
          : `Held at ${i.conviction} (claimed ${i.convictionClaimed}): the news check couldn't run this session, so convergence is unverified — treat cautiously and confirm before trading.`;
      }
    });
  }

  const clears = (c) => ['MED-HIGH', 'HIGH'].includes((c || '').toUpperCase());
  (ideas.ideas || []).forEach((i) => { i.qualifies = clears(i.conviction) && !i.level_warning; });
  ideas.qualifyingCount = (ideas.ideas || []).filter((i) => i.qualifies).length;
  await rSet(key, ideas);

  // log offered ideas into the ledger (replacing same-day unacted offers, no double count)
  s.ledger = s.ledger.filter((r) => !(r.status === 'offered' && r.dateKey === t.dateKey));
  for (const idea of ideas.ideas || []) {
    s.ledger.push({ id: `idea_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), date: t.dmy, dateKey: t.dateKey, status: 'offered', idea });
  }
  await rSet('exchange:ledger', s.ledger.slice(-400));

  return { clock: t, ideas, cached: false };
}

// ---------- Vision: parse a NOVA screenshot ----------
async function parseShot(image, kind) {
  const spec = {
    positions: `This is a screenshot of a Phillip Nova (NOVA) equities account showing stock holdings and an account summary bar.
Extract EVERY holding, note whether each is Leveraged (CFD) or Non-Leveraged (EQ/ETF), and read the account summary figures along the bottom.
JSON: {"holdings":[{"name":"Company Name","ticker":"TICK or null","qty":5,"direction":"LONG|SHORT","avgCost":192.02,"lastPrice":195.02,"unrealised":11.59,"assetClass":"CFD|EQ|ETF","leveraged":true,"status":"Open"}],"netLiq":3864.04,"account":{"ledgerBalance":null,"equityBalance":null,"unrealizedPL":null,"initialMargin":null,"buyingPowerETD":null,"netLiquidityValue":null}}
DIRECTION (important for CFDs): most stock holdings are LONG. But a CFD can be SHORT (a sell/short position that profits when price FALLS). Read the direction if the platform shows it (a "sell"/"short" label, a negative quantity, or a short indicator). If it's a plain long-only share holding or you can't tell, use "LONG". This matters: for a SHORT, a price rise is a LOSS, the opposite of a long.
CRITICAL — SIGN OF UNREALISED P/L: the platform shows profit and loss BY COLOUR, often without a printed + or - sign. A figure shown in GREEN (or any up/positive tint) is a PROFIT and MUST be a POSITIVE number. A figure shown in RED is a LOSS and MUST be a NEGATIVE number. Read the colour carefully and set the sign accordingly; never drop or invert it. As a cross-check, if lastPrice is above avgCost on a normal long holding the unrealised is usually positive, and if below it is usually negative (leveraged/CFD and currency effects can shift the magnitude but rarely flip a clear move). When colour and this cross-check disagree, trust the colour but it is worth a second look.
Use null for anything not visible. Numbers as numbers, not strings. Fractional qty is allowed (e.g. 0.1). leveraged is true only for CFD/Leveraged rows.`,
    history: `This is a screenshot of Phillip Nova (NOVA) trade history / closed positions.
Extract EVERY closed deal visible. For realised P/L, GREEN means a positive profit and RED means a negative loss; preserve the sign faithfully.
JSON: {"closes":[{"name":"Company Name","ticker":"TICK or null","qty":5,"avgCost":192.02,"exit":198.10,"realised":30.40,"closeDate":"2026.07.02"}]}`,
  }[kind];

  return claude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
    { type: 'text', text: `${spec}\nRespond ONLY with JSON, no markdown, no commentary.` },
  ], 2000);
}

function sameHolding(a, b) {
  // Prefer TICKER identity: tickers are precise, so equal tickers = same holding, and two
  // DIFFERENT tickers = different holdings, full stop (never fall through to fuzzy name match
  // that could wrongly merge e.g. MicroStrategy with Microsoft). Fixes a real false-match risk.
  const at = (a.ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bt = (b.ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (at && bt) return at === bt;
  // ticker missing on one/both -> fall back to NAME, but require a strong match, not a loose
  // 5-char prefix. Exact normalised name, or one fully contains the other's significant name.
  const an = (a.name || a.ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bn = (b.name || b.ticker || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!an || !bn) return false;
  if (an === bn) return true;
  // containment only when the shorter name is substantial (>=6 chars) AND is a real leading
  // segment of the other — so "MARVELL" matches "MARVELLTECHNOLOGY" but "MICRO..." pairs don't.
  const shorter = an.length <= bn.length ? an : bn;
  const longer = an.length <= bn.length ? bn : an;
  return shorter.length >= 6 && longer.startsWith(shorter);
}

// ---------- Book sync: read positions (+ optional history), reconcile, review ----------
async function actSync(positionsImgs, historyImg) {
  const t = bkk();
  const s = await loadAll();
  // accept either a single image (back-compat) or an array of images (mobile: several
  // partial screenshots covering the whole book). Parse each and merge the holdings.
  const imgs = Array.isArray(positionsImgs) ? positionsImgs.filter(Boolean) : (positionsImgs ? [positionsImgs] : []);
  let mergedHoldings = [];
  let netLiqSeen = null;
  let accountSeen = null;
  for (const img of imgs) {
    const parsed = await parseShot(img, 'positions');
    for (const h of (parsed.holdings || [])) {
      // de-dupe across shots: if the same holding appears in two screenshots, keep one
      if (!mergedHoldings.some((x) => sameHolding(x, h))) mergedHoldings.push(h);
    }
    // the account summary bar may only appear in one shot; capture it where present
    if (parsed.netLiq != null) netLiqSeen = parsed.netLiq;
    if (parsed.account && Object.values(parsed.account).some((v) => v != null)) accountSeen = parsed.account;
  }
  const posParse = { holdings: mergedHoldings, netLiq: netLiqSeen, account: accountSeen };
  const histParse = historyImg ? await parseShot(historyImg, 'history') : { closes: [] };

  const seen = posParse.holdings || [];
  const report = { closedDetected: [], newAdded: [], updated: 0, netLiq: posParse.netLiq ?? null, shotsRead: imgs.length };

  // SAFETY (audit finding 7): an empty parse must NOT wipe a non-empty book. If the vision
  // read returned zero holdings but the book currently holds positions, that's almost
  // certainly a failed/partial screenshot, not a genuine "everything sold" event. Abort and
  // tell the user rather than silently marking every real holding closed.
  if (seen.length === 0 && (s.book.holdings || []).length > 0) {
    return {
      clock: t, aborted: true,
      report: { ...report, aborted: true, note: 'Sync aborted: the screenshot(s) showed no readable holdings, but your book currently holds ' + s.book.holdings.length + '. Treated as a failed read, not a cleared book — nothing was changed. Re-upload a clear positions screenshot.' },
      book: bookView(s.book),
    };
  }

  // 1) reconcile: holdings in the book but absent on screen => sold; match to history
  // Sign sanity check, DIRECTION-AWARE (audit finding 8): for a LONG, price above cost should
  // mean a POSITIVE unrealised; for a SHORT, price above cost should mean a NEGATIVE one (a
  // short profits when price falls). We only FLAG a clear contradiction for the user to eyeball
  // — we do NOT silently flip the number (a wrong flip would turn a real profit into a phantom
  // loss and could wrongly trigger a sell). The platform's shown P/L is kept.
  const signLooksWrong = (h) => {
    const q = num(h.qty), avg = num(h.avgCost), last = num(h.lastPrice), upl = num(h.unrealised);
    if (q == null || avg == null || last == null || upl == null || avg === 0) return false;
    if (Math.abs(upl) < 0.01) return false;
    const gapPct = Math.abs(last - avg) / avg;
    if (gapPct < 0.02) return false; // ignore tiny gaps and leverage/fx noise
    const isShort = (h.direction || 'LONG').toUpperCase() === 'SHORT';
    const priceUp = last > avg;
    // profit expectation: LONG profits when priceUp; SHORT profits when price DOWN
    const shouldBeProfit = isShort ? !priceUp : priceUp;
    return (shouldBeProfit && upl < 0) || (!shouldBeProfit && upl > 0);
  };

  // Consume matched rows so ONE screen holding can't satisfy TWO book holdings (audit finding 6,
  // carried across from the Terminal). And guard PARTIAL screenshots: if the parse saw fewer
  // holdings than the book holds and no history was provided, DEFER the unconfirmed closures
  // (keep them) rather than marking real holdings sold from an incomplete shot.
  const seenPool = [...seen];
  const consumeMatch = (h) => {
    const idx = seenPool.findIndex((x) => sameHolding(x, h));
    if (idx === -1) return null;
    return seenPool.splice(idx, 1)[0];
  };
  const partialShot = seen.length < (s.book.holdings || []).length && (histParse.closes || []).length === 0;
  const deferredClosures = [];
  const still = [];
  report.signFlags = [];
  for (const h of (s.book.holdings || [])) {
    const onScreen = consumeMatch(h);
    if (onScreen) {
      h.lastPrice = onScreen.lastPrice ?? h.lastPrice;
      h.unrealised = onScreen.unrealised ?? h.unrealised;
      h.qty = onScreen.qty ?? h.qty;
      h.direction = onScreen.direction ?? h.direction;
      // if the freshly-read sign contradicts the price move (for this position's DIRECTION),
      // FLAG it for the user — do NOT silently flip it. Keep what the platform showed.
      if (signLooksWrong(h)) {
        report.signFlags.push({ name: h.name, ticker: h.ticker, was: h.unrealised, note: `${h.ticker || h.name} (${(h.direction || 'LONG').toUpperCase()}): shown P/L ${h.unrealised} but price ${num(h.lastPrice) > num(h.avgCost) ? 'above' : 'below'} cost would usually be the opposite sign for a ${(h.direction || 'LONG').toLowerCase()}. Kept the platform value — double-check this one.` });
      }
      report.updated++;
      still.push(h);
    } else {
      const match = (histParse.closes || []).find((c) => sameHolding(c, h));
      if (!match && partialShot) {
        deferredClosures.push(h.ticker || h.name);
        still.push(h);
        continue;
      }
      report.closedDetected.push({
        id: `close_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        holding: h, close: match || null, detectedAt: t.iso, needsHistory: !match,
      });
    }
  }
  if (deferredClosures.length) {
    report.partialShotNote = `Only ${seen.length} holding(s) were readable but your book holds ${s.book.holdings.length}, and no closing history was provided. To avoid a false close from a partial screenshot, these were KEPT and not marked sold: ${deferredClosures.join(', ')}. Re-sync a full holdings screenshot (or add a history shot) to confirm any genuine closures.`;
  }
  // 2) holdings on screen but not matched to any book holding => newly seen, adopt them.
  // Iterate the LEFTOVER pool so a row already matched above is never also adopted.
  const pendingFills = s.book.pendingFills || [];
  report.filledFromGems = [];
  for (const x of seenPool) {
    {
      const adopted = {
        id: `hold_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: x.name, ticker: x.ticker || null, qty: x.qty, avgCost: x.avgCost,
        lastPrice: x.lastPrice ?? null, unrealised: x.unrealised ?? null,
        openedAt: Date.now(), firstSeen: t.dmy,
      };
      // if this newly-appeared holding was a gem you took up, carry its thesis and
      // proposed levels across so the reasoning travels into the book with the position.
      const nm = (x.ticker || x.name || '').toUpperCase();
      const match = pendingFills.find((p) => (p.ticker || '').toUpperCase() === nm || (p.name || '').toUpperCase() === (x.name || '').toUpperCase());
      if (match) {
        adopted.fromGem = true;
        adopted.gemThesis = match.reason || null;
        adopted.mentalTP = match.tp || null;
        adopted.mentalSL = match.sl || null;
        report.filledFromGems.push(adopted.name);
      }
      still.push(adopted);
      report.newAdded.push(adopted);
    }
  }
  s.book.holdings = still;
  // clear any pending fills that have now genuinely appeared in the book
  if (pendingFills.length) {
    s.book.pendingFills = pendingFills.filter((p) =>
      !(s.book.holdings || []).some((h) => (h.ticker || h.name || '').toUpperCase() === (p.ticker || '').toUpperCase() || (h.name || '').toUpperCase() === (p.name || '').toUpperCase()));
  }

  // 3) net liquidation value + its history trail (the equity equivalent of vitals)
  if (posParse.netLiq != null) {
    s.book.netLiq = posParse.netLiq;
    s.book.netLiqHistory = [...(s.book.netLiqHistory || []), { ts: t.iso, netLiq: posParse.netLiq }].slice(-90);
  }
  // capture the richer NOVA account vitals if the parser saw them
  if (posParse.account) {
    s.book.account = { ...(s.book.account || {}), ...posParse.account, ts: t.iso };
  }
  s.book.lastSync = t.iso;
  await rSet('exchange:book', s.book);

  return { clock: t, report, book: s.book };
}

// ---------- Proof of close: reconcile after a rebalancing exit ----------
// You submit a screenshot after closing a position on NOVA. The desk confirms the close,
// reconciles margin and balance, then applies your cash rule: if there is enough freed
// buying power to make a sensible new position it proposes the next rebalancing buy
// (fully framed: entry, current, SL, TP, reason); if not, it waits and just shows the
// reconciled balance until several closes have banked enough powder.
const MIN_DEPLOY = 150; // a sensible floor of freed buying power before proposing a buy

async function actProofOfClose(positionsImg) {
  const t = bkk();
  if (!positionsImg) throw new Error('A positions screenshot is needed to confirm the close and reconcile.');
  const s = await loadAll();
  const before = {
    holdings: (s.book.holdings || []).length,
    buyingPower: num((s.book.account || {}).buyingPowerETD),
    netLiq: num(s.book.netLiq),
  };

  // read the fresh screenshot and reconcile the book (reuses the proven sync machinery)
  const sync = await actSync(positionsImg, null);
  const after = await loadAll();
  const closed = (sync.report && sync.report.closedDetected) || [];
  const nowBuyingPower = num((after.book.account || {}).buyingPowerETD) ?? before.buyingPower;
  const nowNetLiq = num(after.book.netLiq) ?? before.netLiq;
  const freed = (before.buyingPower != null && nowBuyingPower != null) ? +(nowBuyingPower - before.buyingPower).toFixed(2) : null;

  const balancePicture = {
    holdingsBefore: before.holdings, holdingsNow: (after.book.holdings || []).length,
    buyingPowerBefore: before.buyingPower, buyingPowerNow: nowBuyingPower,
    netLiqBefore: before.netLiq, netLiqNow: nowNetLiq,
    freedThisClose: freed, closesDetected: closed.map((c) => c.holding && (c.holding.ticker || c.holding.name)).filter(Boolean),
  };

  // decide whether there is enough powder to sensibly deploy now
  const deployable = nowBuyingPower != null ? nowBuyingPower : 0;
  const enough = deployable >= MIN_DEPLOY;

  let nextBuy = null;
  let waiting = null;
  if (enough) {
    // propose the next rebalancing buy, FULLY FRAMED like a gem card, and price-validated
    const held = new Set((after.book.holdings || []).map((h) => (h.ticker || h.name || '').toUpperCase()));
    const unavailable = new Set((after.universe.unavailable || []).map((u) => (u || '').toUpperCase()));
    const reb = after.book.rebalance ? JSON.stringify(after.book.rebalance.plan?.target || {}) : 'no saved target yet';
    const news = await getNews('market');

    let prop = await claude(`You are THE EXCHANGE proposing the NEXT rebalancing BUY after the investor freed up about $${deployable.toFixed(0)} of buying power by closing a position. The goal is to move his book toward a more balanced, less chip-heavy, more geographically spread shape. Favour a name that genuinely diversifies him (away from US semiconductors), and prefer a Singapore/Hong Kong/regional name where sensible since those trade during his Phuket daytime.

SAVED REBALANCE TARGET: ${reb}
ALREADY HELD (do not propose): ${[...held].join(', ') || 'none'}
UNAVAILABLE ON HIS PLATFORM (never propose): ${[...unavailable].join(', ') || 'none'}
FREED BUYING POWER: about $${deployable.toFixed(0)} — the position must fit comfortably inside this.
MARKET NEWS:\n${digest(news, 16)}

Propose exactly ONE buy, fully framed like a proper trade idea, that fits the freed buying power and improves his diversification. Give real, sensible price levels (entry within ~8% of current; BUY = stop below entry, target above; stop ~3-10% from entry; reward:risk >= 1.5).

Respond ONLY with JSON, no markdown:
{"name":"Company","ticker":"TICK","exchange":"NASDAQ|NYSE|SGX|HKEX","industry":"e.g. Consumer","instrument":"SHARE|CFD","direction":"BUY","current_price":"12.40","entry":"12.00-12.30","tp":"14.20","sl":"11.10","conviction":"LOW|MED|MED-HIGH|HIGH","reason":"why this name diversifies the book and fits the freed cash, max 45 words","availability":"likely — confirm on your NOVA platform","fits_budget":"one line on how it fits ~$${deployable.toFixed(0)}"}`, 1400);

    // validate the proposed levels against a genuine live price, exactly like the gem hunt
    if (prop && prop.ticker) {
      const real = (await livePrices([prop.ticker]))[prop.ticker.toUpperCase()] ?? null;
      const lc = checkLevels(prop, real);
      if (real != null && !lc.feedSuspect) prop.current_price = String(real);
      if (!lc.ok) { prop.level_warning = `LEVELS UNVERIFIED: ${lc.reason}. Confirm on your chart before trading.`; }
      else { prop.rr = lc.rr; prop.slPct = lc.slPct; prop.tpPct = lc.tpPct; }
    }
    nextBuy = prop;
  } else {
    waiting = `Freed buying power is about $${deployable.toFixed(0)}, below the ~$${MIN_DEPLOY} floor for a sensible new position. Close another one or two names first, then the desk will propose a buy worth making. Dribbling tiny amounts into new positions is inefficient.`;
  }

  return { clock: t, reconciled: true, balancePicture, enoughToDeployNow: enough, nextBuy, waiting, closesDetected: balancePicture.closesDetected };
}

// ---------- Rebalance: judge the whole book and design a balanced target ----------
// One tap pulls live prices for every holding, measures the real concentration, then
// judges each position (HOLD/TRIM/CLOSE) with a sensible exit price and reasoning, and
// designs a more balanced, less chip-heavy, more geographically spread target book.
async function actRebalance() {
  const t = bkk();
  const s = await loadAll();
  const holdings = s.book.holdings || [];
  if (!holdings.length) return { clock: t, empty: true, note: 'No holdings to rebalance. Seed or sync your book first.' };

  // 1) pull genuine live prices for every held name, so every judgement is current
  const tickers = holdings.map((h) => h.ticker || h.name).filter(Boolean);
  const priceMap = await livePrices(tickers);
  // fold live prices into a working copy so weights and P/L reflect the real market.
  // SANITY GUARD: the feed (Finnhub) is US-focused and can return a bogus price for a
  // regional ticker (e.g. an SGX symbol like C6L that collides with a different US listing).
  // If the "live" price wildly disagrees with the platform's last synced price, DISTRUST the
  // feed and keep the platform price — the platform is the truth for what he actually holds.
  const live = holdings.map((h) => {
    const feed = priceMap[(h.ticker || h.name || '').toUpperCase()];
    const synced = num(h.lastPrice);
    const avg = num(h.avgCost);
    // reference is the platform's last price, or failing that avg cost
    const sp = sanePrice(feed, synced != null ? synced : avg);
    const lastPrice = sp.price;
    const qty = num(h.qty) || 0;
    const plPct = (avg && lastPrice) ? ((lastPrice - avg) / avg) * 100 : null;
    return { ...h, lastPrice, _sector: sectorOf(h), _value: Math.abs(qty * (lastPrice || avg || 0)), _plPct: plPct, _hasLive: sp.usedFeed, _feedRejected: sp.rejected };
  });

  // 2) measure concentration: by sector, by chip-exposure, by geography (exchange)
  const totalValue = live.reduce((a, h) => a + h._value, 0) || 1;
  const bySector = {};
  const byGeo = {};
  let chipValue = 0;
  for (const h of live) {
    bySector[h._sector] = (bySector[h._sector] || 0) + h._value;
    const geo = /SGX/i.test(h.exchange || '') ? 'Singapore' : /HK|HONG/i.test(h.exchange || '') ? 'Hong Kong' : 'US';
    byGeo[geo] = (byGeo[geo] || 0) + h._value;
    if (isChipExposed(h._sector)) chipValue += h._value;
  }
  const pct = (v) => +((v / totalValue) * 100).toFixed(1);
  const sectorLines = Object.entries(bySector).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${pct(v)}%`).join(', ');
  const geoLines = Object.entries(byGeo).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${pct(v)}%`).join(', ');
  const chipPct = pct(chipValue);

  // classify each holding's tradeable WINDOW from its exchange, so the plan never asks him
  // to trade a US name during his daytime (US only trades in his late night).
  const tradeWindow = (h) => {
    const ex = (h.exchange || '').toUpperCase();
    if (/SGX/.test(ex)) return 'DAYTIME (SGX, Phuket daytime)';
    if (/HK|HONG/.test(ex)) return 'DAYTIME (HKEX, Phuket daytime)';
    if (/NASDAQ|NYSE|US|NQ/.test(ex) || !ex) return 'NIGHT ONLY (US market, his late night)';
    return 'check platform hours';
  };

  // 3) per-holding lines with live price, weight, P/L posture, and tradeable window
  const holdingLines = live.map((h) => {
    const w = pct(h._value);
    const pl = h._plPct != null ? `${h._plPct >= 0 ? '+' : ''}${h._plPct.toFixed(1)}% vs cost` : 'cost unclear';
    const src = h._feedRejected ? ' (platform price; live feed gave an implausible value and was rejected)' : h._hasLive ? '' : ' (platform price, no live feed)';
    return `${h.name}${h.ticker ? ' (' + h.ticker + ')' : ''} [${h._sector}, ${h.exchange || '?'}] — tradeable: ${tradeWindow(h)}: ${h.qty} @ cost ${h.avgCost}, price ${h.lastPrice ?? '?'}${src}, weight ${w}%, ${pl}`;
  }).join('\n');

  const acc = s.book.account || {};
  const buyingPower = num(acc.buyingPowerETD) ?? num(acc.buyingPowerSecurities);
  const netLiq = num(s.book.netLiq) ?? num(acc.netLiquidityValue);

  // pull fresh market + per-holding news so every verdict is grounded in what the market
  // is actually saying right now, not price and concentration alone.
  const newsQuery = live.map((h) => h.ticker ? `${h.ticker}|${h.name}` : h.name).filter(Boolean).join(',');
  const news = await getNews('holdings', newsQuery);

  const plan = await claude(`You are THE EXCHANGE's rebalancing strategist for a retail investor in Phuket trading via Phillip Nova (NOVA). His book is heavily concentrated in US semiconductors and you are helping him rebalance toward a healthier, more diversified portfolio, spread across sectors AND geographies. NOVA lets him trade US, Singapore, Hong Kong, Japan, Malaysia and China names.

CRITICAL TRADING-HOURS CONSTRAINT (get this right, it is a hard rule): he can ONLY trade a US-listed name (NASDAQ/NYSE) when the US market is open, which is his LATE NIGHT in Phuket. He can ONLY trade SG (SGX) and HK (HKEX) names during his Phuket DAYTIME. Every holding above is tagged with its tradeable window. So:
- To close or trim a US name (e.g. MBLY/Mobileye, CAMT/Camtek, MRVL, TSLA, COHR, AMD, most of his book) he must do it AT NIGHT during US hours. NEVER tell him to close a US name during SGX/daytime hours — that is impossible.
- To close or trim an SGX name (e.g. C6L/Singapore Airlines, ES3) or an HK name, he does it during his Phuket DAYTIME.
- When you write the next_step, CHECK each ticker's tagged window and only pair an action with a window that ticker can actually trade in. Getting a market wrong makes the whole plan untrustworthy.

CURRENT BOOK (live prices pulled just now where available; each tagged with its tradeable window):
${holdingLines}

CONCENTRATION RIGHT NOW:
By sector: ${sectorLines}
By geography: ${geoLines}
Total semiconductor/chip exposure: ${chipPct}% of position value (this is the core problem to reduce).
Account: net liquidity ~${netLiq ?? '?'}, buying power ~${buyingPower ?? '?'}.

FRESH MARKET & COMPANY NEWS (each item source-tagged in [brackets] — real finance/market outlets; ground every verdict in this, not just price and weight — if a name has a live catalyst, a broken story, or news that changes its outlook, that must shape the HOLD/TRIM/CLOSE call and the exit price):
${digest(news, 24)}

YOUR TASK, in two parts:

PART 1 — TARGET BALANCE: Decide and EXPLAIN the best target shape for his book. Give sensible target weights by sector and by geography that meaningfully cut the chip concentration and add daytime-tradeable regional exposure, following sound diversification principles (no single stock dominating, no single sector above ~25-30%, genuine geographic spread). Explain WHY in plain, warm language.

PART 2 — PER-HOLDING VERDICT: For EACH current holding, judge HOLD, TRIM, or CLOSE in service of that target. For any TRIM or CLOSE, give ONE sensible exit price (a single clean number) and a SHORT one-line reason (max 18 words, telegram style). Base the exit price on the real current level and a sensible technical/valuation judgement; where he is underwater but the story is intact, it is fine to suggest holding or waiting for a better level rather than crystallising a loss, and where a name is a genuine winner or a broken story, say so. Ground verdicts in the concentration problem: over-weight chip names are prime trim/close candidates; genuine diversifiers and winners are keepers. Keep every field tight; brevity matters. WHERE A VERDICT TURNS ON NEWS (a catalyst, a broken or confirmed story), validate it against CONVERGENCE and cite the specific sources in that holding's "sources" as ["[Source] point"] from MULTIPLE outlets where the wire allows; leave "sources" empty for a purely weight/valuation-driven call. Never fabricate sources.

Respond ONLY with JSON, no markdown:
{"target":{"summary":"2-3 sentence plain explanation of the target shape and why","sectors":[{"name":"Semiconductors","current":"X%","target":"Y%"}],"geography":[{"name":"US","current":"X%","target":"Y%"}]},"verdicts":[{"ticker":"TICK","name":"Company","verdict":"HOLD|TRIM|CLOSE","exit_price":"single number or null for HOLD","reason":"one line","sources":["[Source] point — only when the verdict turns on news, from multiple outlets; else empty"],"sector":"...","weight":"X%"}],"headline":"one honest sentence on the book's biggest imbalance","next_step":"what to do first, one line — and it MUST pair each named action with a window that ticker can actually trade in (US names at night, SGX/HK names in daytime); double-check every ticker's tagged window before writing this"}`, 8000);

  const result = {
    clock: t,
    pulledPrices: Object.keys(priceMap).length,
    totalHoldings: holdings.length,
    concentration: { bySector: Object.fromEntries(Object.entries(bySector).map(([k, v]) => [k, pct(v)])), byGeo: Object.fromEntries(Object.entries(byGeo).map(([k, v]) => [k, pct(v)])), chipPct },
    plan,
    generatedAt: t.iso,
  };
  // remember the latest rebalance plan so the screen can show it and proof-of-close can reconcile against it
  // BOUNDARY: the rebalance is DELIBERATELY separate from the Reviews tab. It writes ONLY to
  // book.rebalance and never to any holding's reviewHistory or lastReview. The two produce
  // different judgements for different purposes, so a rebalance verdict must never overwrite
  // or pollute the per-holding review record. Do not wire rebalance verdicts into review fields.
  s.book.rebalance = { plan, concentration: result.concentration, at: t.iso };
  await rSet('exchange:book', s.book);
  return result;
}

// ---------- Position health review: hold or close, with proposed levels ----------
// The equity cousin of The Terminal's red flag review. Judges a single holding like a
// patient analyst: is the story intact, how long held, how much longer is sensible,
// and what stop/target framework makes sense. Grounded in fresh company news.
async function actReview(holdingId) {
  const t = bkk();
  const s = await loadAll();
  const h = (s.book.holdings || []).find((x) => x.id === holdingId);
  if (!h) throw new Error('Holding not found.');

  const held = daysHeld(h.openedAt);
  const query = h.ticker ? `${h.ticker}|${h.name}` : h.name;
  const news = await getNews('holdings', query);
  const priorLessons = (s.lessons || []).slice(-8).map((l) => `- ${l.text}`).join('\n') || '- none yet';

  // fetch the genuine live price so proposed levels can be checked against reality
  const live = await livePrice(h.ticker);
  // guard against a bogus feed price for a regional ticker; the platform price is the truth
  const sp = sanePrice(live, num(h.lastPrice) != null ? num(h.lastPrice) : num(h.avgCost));
  const priceNow = sp.price != null ? sp.price : num(h.lastPrice);

  // Massive quant enrichment for THIS holding: real technicals + insider posture, so the
  // hold/trim/close call is validated against hard data, not only the news wire. US names
  // only (regional tickers are skipped inside the module); empty if the feed is off.
  let holdingSignals = { lines: [] };
  try { holdingSignals = await enrichTickers([h.ticker], massiveCache); } catch { /* bonus, never fatal */ }

  // profit/loss posture against average cost, for honest framing
  const pl = (priceNow != null && h.avgCost != null)
    ? `currently ${priceNow >= h.avgCost ? 'above' : 'below'} cost: paid ${h.avgCost}, now ${priceNow} (${(((priceNow - h.avgCost) / h.avgCost) * 100).toFixed(1)}%)`
    : 'cost basis unclear';

  // ---- financial mindfulness: the account's health and this holding's margin nature ----
  const acc = s.book.account || {};
  const rvBuyingPower = num(acc.buyingPowerETD) ?? num(acc.buyingPowerSecurities);
  const rvNetLiq = num(s.book.netLiq) ?? num(acc.netLiquidityValue);
  const rvInitialMargin = num(acc.initialMargin);
  const rvMarginUtil = (rvInitialMargin != null && rvNetLiq) ? (rvInitialMargin / rvNetLiq) * 100 : null;
  const isLeveraged = !!(h.leveraged || h.assetClass === 'CFD');
  const financeBlock = `Account posture: ${rvNetLiq != null ? `net liquidity about $${rvNetLiq.toFixed(0)}` : 'net liquidity not synced'}${rvBuyingPower != null ? `, buying power about $${rvBuyingPower.toFixed(0)}` : ''}${rvMarginUtil != null ? `, roughly ${rvMarginUtil.toFixed(0)}% of the account committed as margin` : ''}. This holding is a ${isLeveraged ? 'LEVERAGED CFD position, which consumes margin and carries financing/swap costs, so holding it on has an ongoing cost and closing it frees up margin and buying power' : 'non-leveraged owned position (share/ETF), which ties up capital but not margin in the same way'}. Weigh this in your call: if margin is stretched, be readier to free it by trimming or closing a weak leveraged holding; if there is ample room, financial pressure is not itself a reason to act.`;

  // ---- the running history of prior reviews, so each review builds on the last ----
  const history = h.reviewHistory || [];
  const priorReviewsBlock = history.length
    ? history.slice(-4).map((r, i) => `Review ${history.length - Math.min(4, history.length) + i + 1} (${r.at ? r.at.slice(0, 10) : '?'}): ${r.verdict} — ${r.reason}`).join('\n')
    : 'No prior reviews. This is the first review of this holding.';

  // ---- LOCKED levels: set once on the first review, then immutable (only a manual
  // override by the user can change them). Reviews never re-propose them. ----
  const lockedSL = num(h.lockedSL);
  const lockedTP = num(h.lockedTP);
  const hasLocked = lockedSL != null || lockedTP != null;
  const isFirstReview = !hasLocked;

  // ---- has a LOCKED level actually been hit? (NOVA has no auto SL/TP, so this note is
  // his manual trigger to act) ----
  let levelEvent;
  let levelHit = null; // { type:'SL'|'TP', level, price } for persisting a flag on the holding
  if (!hasLocked) {
    levelEvent = 'This is the FIRST review: propose the stop-loss and take-profit now. They will be LOCKED permanently after this — you will never set them again, only judge hold or close against them.';
  } else if (priceNow != null) {
    const events = [];
    if (lockedTP != null && priceNow >= lockedTP) { events.push(`the LOCKED take-profit of ${lockedTP} has been REACHED (live ${priceNow})`); levelHit = { type: 'TP', level: lockedTP, price: priceNow }; }
    if (lockedSL != null && priceNow <= lockedSL) { events.push(`the LOCKED stop-loss of ${lockedSL} has been BREACHED (live ${priceNow})`); levelHit = { type: 'SL', level: lockedSL, price: priceNow }; }
    if (events.length) levelEvent = 'IMPORTANT — ' + events.join('; ') + '. NOVA has no automatic stop/target, so nothing closed this for him. Advise clearly and directly: hold on regardless, or close now, with your reasoning.';
    else levelEvent = `Locked levels (SL ${lockedSL ?? 'none'}, TP ${lockedTP ?? 'none'}); live ${priceNow}. Neither has been hit yet.`;
  } else {
    levelEvent = `Locked levels (SL ${lockedSL ?? 'none'}, TP ${lockedTP ?? 'none'}); no live price to check against right now.`;
  }

  const verdict = await claude(`You are THE EXCHANGE's position analyst, reviewing ONE long-term equity holding in a Phuket investor's Phillip Nova (NOVA) portfolio. These are his considered long-term convictions, NOT week-long swings, so judge with patience, like a seasoned analyst rather than a jumpy trader. Run a zero-based review (Peter Lynch's test: if he held none of this today, would buying it right now at this price be justified?).

HOLDING UNDER REVIEW:
${h.name}${h.ticker ? ' (' + h.ticker + ')' : ''}, ${h.qty} shares @ avg cost ${h.avgCost}, live price ${priceNow ?? '?'}, unrealised P/L ${h.unrealised ?? '?'}.
Posture: ${pl}. Held roughly ${held} day(s) since first tracked${hasLocked ? `. LOCKED levels (immutable): SL ${lockedSL ?? 'none'}, TP ${lockedTP ?? 'none'}` : '. No stop or target locked yet — this first review sets them.'}

YOUR OWN PRIOR REVIEWS OF THIS HOLDING (build on these; note what has changed, whether your prior call played out, and evolve the view rather than starting fresh):
${priorReviewsBlock}

LEVEL CHECK:
${levelEvent}

FINANCIAL MINDFULNESS (weigh the account's health, not just this stock in isolation):
${financeBlock}

FRESH COMPANY & MARKET NEWS (each item is source-tagged in [brackets] — real finance/market outlets):
${digest(news, 20)}

QUANTITATIVE SIGNALS (real technicals + insider filings from Massive; treat these as hard evidence to validate your hold/trim/close call against — e.g. a deeply oversold RSI may argue against closing at the low, insider selling may corroborate a broken thesis, price back above its 50-day may confirm the story holds):
${signalsBlock(holdingSignals.lines)}

LESSONS ARCHIVE:
${priorLessons}

Your job, honest judgements that CONTINUE the story from your prior reviews:
1. HOLD, TRIM or CLOSE: is the original reason for owning this still intact? A holding being down is NOT itself a reason to close; a broken thesis is. A holding being up is not itself a reason to sell; a spent thesis, a hit target, or a better use of the capital might be. If a LOCKED level was hit (see the level check above), give a direct hold-or-close call on that basis — NOVA won't have closed it automatically. Weigh the financial mindfulness above: a weak leveraged holding eating margin is a stronger candidate to free up than an owned position when the account is tight. Be honest if the story has genuinely broken or evolved since your last review.
${isFirstReview
  ? '2. SET THE LEVELS (first review only): propose ONE sensible stop loss and take profit grounded in the current live price. These will be LOCKED permanently — you are setting them once, for good, so choose carefully. Give real price levels.'
  : '2. DO NOT propose or change any stop or target. The levels are LOCKED and are shown above. Your job is only to judge hold or close against them and the story. Do NOT output new levels.'}
3. WHAT'S CHANGED: explicitly note how your view has shifted (or held firm) since the last review, referencing it.
4. HOLDING HORIZON & FINANCES: offer a sensible sense of how long to keep holding or what milestone/catalyst to hold toward, and note briefly whether holding on or closing helps or hurts his margin and buying power.
5. SOURCE VALIDATION (mandatory): your HOLD/TRIM/CLOSE verdict must be validated against the market news above and grounded in CONVERGENCE — MULTIPLE independent sources pointing the same way, not a single headline. In "sources", list the SPECIFIC items you relied on, each as "[Source] the specific point", drawn from DIFFERENT outlets where possible. State honesty in "source_convergence": STRONG if several independent sources agree, MODERATE if some, WEAK/THIN if only one or the wire is quiet on this name — and let a thin read temper confidence. Do NOT fabricate sources or attribute claims to outlets that did not make them; if the wire is quiet on this name, say so plainly.

Respond ONLY with JSON, no markdown:
${isFirstReview
  ? '{"verdict":"HOLD|CLOSE|TRIM","reason":"2-3 sentences grounded in current facts","proposed_sl":"price level to LOCK","proposed_tp":"price level to LOCK","level_note":"","change_note":"one sentence on your initial read","hold_guidance":"how long / toward what, one sentence","sources":["[Source] specific point relied on, from MULTIPLE outlets where the wire allows"],"source_convergence":"STRONG|MODERATE|WEAK/THIN","conviction":"how sure you are, one short phrase"}'
  : '{"verdict":"HOLD|CLOSE|TRIM","reason":"2-3 sentences grounded in current facts, referencing how the view has evolved since the last review","level_note":"one sentence on whether a LOCKED level was hit and what to do, or empty if none","change_note":"one sentence on what has changed since the last review","hold_guidance":"how long / toward what, one sentence","sources":["[Source] specific point relied on, from MULTIPLE outlets where the wire allows"],"source_convergence":"STRONG|MODERATE|WEAK/THIN","conviction":"how sure you are, one short phrase"}'}`, 1500);

  // build this review record
  const record = {
    verdict: verdict.verdict, reason: verdict.reason,
    level_note: verdict.level_note || null, change_note: verdict.change_note || null,
    hold_guidance: verdict.hold_guidance || null,
    sources: Array.isArray(verdict.sources) ? verdict.sources : [],
    source_convergence: verdict.source_convergence || null,
    priceAtReview: priceNow ?? null, at: t.iso,
    lockedSL: hasLocked ? lockedSL : (num(verdict.proposed_sl) ?? null),
    lockedTP: hasLocked ? lockedTP : (num(verdict.proposed_tp) ?? null),
  };

  // append to the running history (cap to keep the record tidy), and keep lastReview
  h.reviewHistory = [...history, record].slice(-12);
  h.lastReview = record;

  // LOCK the levels on the FIRST review only. Thereafter they are immutable here; the
  // ONLY way to change them is the deliberate manual override action. A review NEVER moves them.
  if (isFirstReview) {
    if (num(verdict.proposed_sl) != null) { h.lockedSL = num(verdict.proposed_sl); h.mentalSL = h.lockedSL; }
    if (num(verdict.proposed_tp) != null) { h.lockedTP = num(verdict.proposed_tp); h.mentalTP = h.lockedTP; }
    h.levelsLockedAt = t.iso;
  }

  // persist whether a locked level has been hit, so the Book/holding view can flag it
  // prominently (NOVA has no auto SL/TP, so this is his manual trigger to act).
  h.levelHit = levelHit ? { ...levelHit, at: t.iso } : null;

  await rSet('exchange:book', s.book);
  return { clock: t, verdict, holding: h, levelHit };
}

// ---------- Manual override: deliberately reset a holding's LOCKED levels ----------
// The only way locked levels can change. A review never moves them; only this explicit,
// conscious human action does. Pass new sl/tp (either may be null to clear one).
async function actSetLevels(holdingId, sl, tp) {
  const s = await loadAll();
  const h = (s.book.holdings || []).find((x) => x.id === holdingId);
  if (!h) throw new Error('Holding not found.');
  const t = bkk();
  const nsl = num(sl), ntp = num(tp);
  h.lockedSL = nsl != null ? nsl : null;
  h.lockedTP = ntp != null ? ntp : null;
  h.mentalSL = h.lockedSL; h.mentalTP = h.lockedTP;
  h.levelsLockedAt = t.iso;
  h.levelsManuallySet = true;
  h.levelHit = null; // recheck against the new levels on the next review
  await rSet('exchange:book', s.book);
  return { ok: true, holding: h };
}

// ---------- Self-improvement: shadow scorecard + reflection loop ----------
// Studies the desk's own resolved record of passed gem ideas and distils standing
// guidance that shapes future hunts. The equity cousin of The Terminal's learning loop.
function shadowScorecard(ledger) {
  const resolved = ledger.filter((r) => r.status === 'passed' && r.shadowVerdict && r.shadowVerdict.grade);
  const tally = { win: 0, loss: 0, soft: 0, other: 0, total: resolved.length };
  const byIndustry = {};
  const bySignal = {};
  for (const r of resolved) {
    const g = r.shadowVerdict.grade;
    const isWin = g === 'WIN' || g === 'SOFT_WIN';
    const isLoss = g === 'LOSS' || g === 'SOFT_LOSS';
    if (g === 'WIN') tally.win++; else if (g === 'LOSS') tally.loss++;
    else if (g === 'SOFT_WIN' || g === 'SOFT_LOSS') tally.soft++; else tally.other++;
    // group performance by industry and by the signal families that fired
    const ind = (r.idea.industry || 'unknown').toLowerCase();
    byIndustry[ind] = byIndustry[ind] || { w: 0, l: 0 };
    if (isWin) byIndustry[ind].w++; else if (isLoss) byIndustry[ind].l++;
    for (const sig of (r.idea.signals || [])) {
      const k = String(sig).toLowerCase();
      bySignal[k] = bySignal[k] || { w: 0, l: 0 };
      if (isWin) bySignal[k].w++; else if (isLoss) bySignal[k].l++;
    }
  }
  return { tally, byIndustry, bySignal, resolved };
}

async function reflectAndLearn(s, t) {
  const card = shadowScorecard(s.ledger);
  // need a genuine sample before drawing conclusions; avoid jumping at noise
  if (card.resolved.length < 6) return null;

  const indLines = Object.entries(card.byIndustry)
    .filter(([, v]) => v.w + v.l >= 2)
    .map(([k, v]) => `${k}: ${v.w}W-${v.l}L`).join(', ') || 'no industry has 2+ resolved yet';
  const sigLines = Object.entries(card.bySignal)
    .filter(([, v]) => v.w + v.l >= 2)
    .map(([k, v]) => `${k}: ${v.w}W-${v.l}L`).join(', ') || 'no signal has 2+ resolved yet';
  const priorGuidance = (s.guidance || []).map((g) => `- ${g.text}`).join('\n') || '- none yet';

  const reflection = await claude(`You are THE EXCHANGE's performance analyst. Study the desk's own record of week-long gem ideas it proposed (and the user passed on), tracked to resolution, and distil what it should DO DIFFERENTLY to hunt better. Judge decision quality, not just outcomes.

SHADOW BOOK (passed ideas, tracked over their ~1 week life):
Overall: ${card.tally.win} clean wins, ${card.tally.loss} clean losses, ${card.tally.soft} soft calls, from ${card.tally.total} resolved.
By industry: ${indLines}
By signal family: ${sigLines}

GUIDANCE ALREADY STANDING (refine or replace, do not just repeat):
${priorGuidance}

Produce 2-4 concrete, actionable guidance notes for future gem hunts. Each must be specific and testable, e.g. "insider-buying names are 4W-1L; weight that signal more heavily" or "consumer-discretionary swings keep failing; demand a stronger catalyst there". If a signal family or industry genuinely outperforms, say to lean into it. If the sample is too thin for a claim, do not force it.
JSON only: {"guidance":[{"text":"concrete actionable note, max 22 words","basis":"the record that supports it, max 10 words"}],"hitrate_note":"one honest line on overall performance so far"}`, 1000);

  if (reflection && Array.isArray(reflection.guidance) && reflection.guidance.length) {
    s.guidance = reflection.guidance.map((g) => ({ text: g.text, basis: g.basis || null, date: t.dmy }));
    s.guidanceMeta = { at: t.iso, sample: card.tally.total, hitrate_note: reflection.hitrate_note || null,
      wins: card.tally.win, losses: card.tally.loss, soft: card.tally.soft };
    await rSet('exchange:guidance', s.guidance);
    await rSet('exchange:guidanceMeta', s.guidanceMeta);
  }
  return reflection;
}

// ---------- Pass an idea (begin shadow tracking) ----------
async function actPass(ideaLedgerId, idea) {
  const s = await loadAll();
  let rec = ideaLedgerId ? s.ledger.find((r) => r.id === ideaLedgerId) : null;
  // fall back: if no ledger record (the idea wasn't tracked with an id), create one from
  // the idea passed in, so passing ALWAYS registers rather than silently doing nothing.
  if (!rec && idea) {
    rec = { id: `idea_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, idea, status: 'offered', at: new Date().toISOString() };
    s.ledger.push(rec);
  }
  if (rec) { rec.status = 'passed'; rec.passedAt = Date.now(); }
  await rSet('exchange:ledger', s.ledger.slice(-400));
  return { ok: true, passed: !!rec };
}

// ---------- Take up an idea (commit to it, awaiting confirmation on next sync) ----------
// The first half of a two-stage flow: you signal intent here, then when you next sync
// your NOVA book and the position genuinely appears, actSync links it back to this gem
// so its thesis and proposed levels travel into the holding rather than being lost.
async function actTakeUp(ideaLedgerId, idea) {
  const s = await loadAll();
  let rec = ideaLedgerId ? s.ledger.find((r) => r.id === ideaLedgerId) : null;
  // fall back: create a ledger record from the idea itself if none was tracked, so taking
  // a position ALWAYS works rather than throwing "idea not found".
  if (!rec && idea) {
    rec = { id: `idea_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, idea, status: 'offered', at: new Date().toISOString() };
    s.ledger.push(rec);
  }
  if (!rec) throw new Error('Idea not found to take up.');
  rec.status = 'taken';
  rec.takenAt = Date.now();
  // record it in a pending-fills list so the desk watches for it on the next sync
  s.book.pendingFills = s.book.pendingFills || [];
  if (!s.book.pendingFills.some((p) => p.ticker === (rec.idea.ticker || rec.idea.name))) {
    s.book.pendingFills.push({
      ticker: rec.idea.ticker || rec.idea.name,
      name: rec.idea.name,
      ideaLedgerId: rec.id,
      entry: rec.idea.entry, tp: rec.idea.tp, sl: rec.idea.sl,
      direction: rec.idea.direction, reason: rec.idea.reason,
      takenAt: Date.now(),
    });
  }
  await rSet('exchange:ledger', s.ledger.slice(-400));
  await rSet('exchange:book', s.book);
  return { ok: true, pending: s.book.pendingFills.length };
}

// ---------- Resolve passed ideas across their week-long window ----------
// priceMap (optional) lets a caller (or our web-search-enriched sessions) supply
// current prices keyed by uppercased ticker/name, so verdicts can be grounded in
// real quotes. Where no price is available, the idea stays honestly unresolved.
function resolveShadow(s, t, priceMap = {}) {
  const graded = [];
  const WINDOW_MS = 7 * 86400e3; // one week, matching the swing horizon
  for (const rec of s.ledger) {
    if (rec.status !== 'passed' || rec.shadowResolved) continue;
    const key = (rec.idea.ticker || rec.idea.name || '').toUpperCase();
    const px = priceMap[key] != null ? num(priceMap[key]) : null;

    const entry = num(rec.idea.entry);
    const tp = num(rec.idea.tp);
    const sl = num(rec.idea.sl);
    const dir = (rec.idea.direction || '').toUpperCase();
    if (entry == null || tp == null || sl == null) { rec.shadowResolved = true; rec.shadowVerdict = { grade: 'UNGRADEABLE', note: 'idea lacked clean levels' }; continue; }

    // append today's observed price to the trail, if we have one
    if (px != null) {
      rec.shadowTrail = rec.shadowTrail || [];
      if (!rec.shadowTrail.some((m) => m.date === t.dmy)) rec.shadowTrail.push({ date: t.dmy, px, ts: Date.now() });
    }

    const trail = rec.shadowTrail || [];
    const hitTP = trail.some((m) => dir === 'BUY' ? m.px >= tp : m.px <= tp);
    const hitSL = trail.some((m) => dir === 'BUY' ? m.px <= sl : m.px >= sl);
    const windowClosed = Date.now() - (rec.passedAt || rec.ts) > WINDOW_MS;

    if (hitTP && !hitSL) { rec.shadowResolved = true; rec.shadowVerdict = { grade: 'WIN', note: 'reached target within the week', resolvedOn: t.dmy }; }
    else if (hitSL && !hitTP) { rec.shadowResolved = true; rec.shadowVerdict = { grade: 'LOSS', note: 'hit stop within the week', resolvedOn: t.dmy }; }
    else if (hitTP && hitSL) { rec.shadowResolved = true; rec.shadowVerdict = { grade: 'AMBIGUOUS', note: 'both levels touched; true order unknown', resolvedOn: t.dmy }; }
    else if (windowClosed && trail.length > 0) {
      const last = trail[trail.length - 1].px;
      const moved = dir === 'BUY' ? last > entry : last < entry;
      rec.shadowResolved = true;
      rec.shadowVerdict = { grade: moved ? 'SOFT_WIN' : 'SOFT_LOSS', note: 'neither level hit in the week; graded on final drift', resolvedOn: t.dmy };
    } else if (windowClosed) {
      // week elapsed but we never observed a price: honest about the gap
      rec.shadowResolved = true;
      rec.shadowVerdict = { grade: 'UNOBSERVED', note: 'week elapsed with no price observed; cannot grade', resolvedOn: t.dmy };
    }
    // else: still within the week and open, leave for a later run

    if (rec.shadowVerdict) graded.push(`${rec.idea.ticker || rec.idea.name}: ${rec.shadowVerdict.grade}`);
  }
  return graded;
}

// ---------- Portfolio analytics helpers ----------
// A light sector map for the names this book actually holds and is likely to hold.
// Grounded in real classifications; extend as new names appear. Unknown falls to 'Other'.
const SECTOR_MAP = {
  MARVELL: 'Semiconductors', MRVL: 'Semiconductors', NETAPP: 'Technology', NTAP: 'Technology',
  AMBA: 'Semiconductors', AMD: 'Semiconductors', CAMT: 'Semiconductors', CRDO: 'Semiconductors',
  MBLY: 'Semiconductors', MGNI: 'Advertising Tech', SPCX: 'Aerospace/Space', COHR: 'Semiconductors',
  ONTO: 'Semiconductors', C6L: 'Airlines', TSLA: 'Autos/EV', NEM: 'Materials/Gold', AR: 'Energy',
  VOO: 'Broad Index ETF', AIQ: 'Tech Thematic ETF', SMH: 'Semiconductor ETF', ES3: 'Broad Index ETF',
};
const sectorOf = (h) => {
  const k = (h.ticker || h.name || '').toUpperCase();
  if (SECTOR_MAP[k]) return SECTOR_MAP[k];
  // ETFs that are clearly semis by name
  if (/semi/i.test(h.name || '')) return 'Semiconductor ETF';
  if ((h.assetClass || '') === 'ETF') return 'Broad Index ETF';
  return 'Other';
};
// A holding's market value (owned) or notional (leveraged), for weighting.
const posValue = (h) => Math.abs((num(h.qty) || 0) * (num(h.lastPrice) || num(h.avgCost) || 0));
// Group semis-adjacent sectors so hidden chip concentration is exposed honestly.
const isChipExposed = (sector) => /semiconductor/i.test(sector);

// ---------- Gather the whole state for the front end ----------
// ---------- Vitals: gather the account figures and interpret them with insight ----------
// The equity cousin of The Terminal's Vitals. Beyond listing balances, it reads what
// the numbers MEAN together: margin utilisation, leverage exposure, cash cushion, and
// the health of the book, each with a plain-language read and a status colour.
function computeVitals(book) {
  if (!book) return null;
  const acc = book.account || {};
  const holdings = book.holdings || [];
  const netLiq = num(book.netLiq) ?? num(acc.netLiquidityValue);
  const initialMargin = num(acc.initialMargin);
  const buyingPower = num(acc.buyingPowerETD);
  const equityBalance = num(acc.equityBalance);
  const ledgerBalance = num(acc.ledgerBalance);
  const unrealizedPL = num(acc.unrealizedPL);

  const reads = []; // each: { label, value, status, note }

  // 1) margin utilisation: how much of the account is committed to holding leverage
  if (initialMargin != null && netLiq != null && netLiq > 0) {
    const util = (initialMargin / netLiq) * 100;
    const status = util > 60 ? 'RED' : util > 35 ? 'AMBER' : 'GREEN';
    reads.push({
      label: 'Margin utilisation', value: `${util.toFixed(1)}%`, status,
      note: status === 'GREEN'
        ? `Only ${util.toFixed(0)}% of your net liquidity is tied up as margin. A comfortable, conservative posture with ample room to breathe.`
        : status === 'AMBER'
        ? `${util.toFixed(0)}% of your account is committed to margin. Workable, but a sharp move against the leveraged names would bite. Tread thoughtfully before adding more.`
        : `${util.toFixed(0)}% of your account is consumed by margin. This is stretched; a drawdown on the CFDs could force action. Consider trimming leverage.`,
    });
  }

  // 2) leverage exposure: what share of the book rides on CFDs vs owned shares
  const levHoldings = holdings.filter((h) => h.leveraged || h.assetClass === 'CFD');
  if (holdings.length) {
    // value falls back to avgCost when no live price is synced, so a leveraged holding
    // without a fresh price is NOT silently dropped (which would understate leverage).
    const posVal = (h) => Math.abs((num(h.qty) || 0) * (num(h.lastPrice) || num(h.avgCost) || 0));
    const levValue = levHoldings.reduce((sum, h) => sum + posVal(h), 0);
    const totalValue = holdings.reduce((sum, h) => sum + posVal(h), 0);
    const levPct = totalValue > 0 ? (levValue / totalValue) * 100 : 0;
    const status = levPct > 50 ? 'AMBER' : 'GREEN';
    reads.push({
      label: 'Leverage exposure', value: `${levHoldings.length} of ${holdings.length} positions`, status,
      note: `Your leveraged CFD positions (${levHoldings.map((h) => h.ticker || h.name).join(', ') || 'none'}) carry financing costs and amplify both gains and losses. They make up roughly ${levPct.toFixed(0)}% of your position value. ${status === 'AMBER' ? 'That is a meaningful tilt toward leverage; keep a close eye on those.' : 'A modest, sensible share riding on leverage.'}`,
    });
  }

  // 3) cash cushion: buying power as dry powder
  if (buyingPower != null && netLiq != null && netLiq > 0) {
    const cushion = (buyingPower / netLiq) * 100;
    reads.push({
      label: 'Dry powder', value: `${buyingPower.toFixed(2)}`, status: cushion < 10 ? 'AMBER' : 'GREEN',
      note: `You have ${buyingPower.toFixed(0)} of buying power, about ${cushion.toFixed(0)}% of your net liquidity, ready to deploy on a fresh gem should one truly convince you.`,
    });
  }

  // 4) book health: unrealised P/L posture
  if (unrealizedPL != null) {
    const winners = holdings.filter((h) => (num(h.unrealised) || 0) > 0).length;
    const laggards = holdings.filter((h) => (num(h.unrealised) || 0) < 0).length;
    reads.push({
      label: 'Open P/L', value: `${unrealizedPL >= 0 ? '+' : ''}${unrealizedPL.toFixed(2)}`, status: unrealizedPL >= 0 ? 'GREEN' : 'AMBER',
      note: `Across the book, ${winners} position${winners !== 1 ? 's' : ''} in the green and ${laggards} in the red, for a net unrealised ${unrealizedPL >= 0 ? 'gain' : 'loss'} of ${Math.abs(unrealizedPL).toFixed(2)}. ${unrealizedPL >= 0 ? 'The book is carrying itself nicely.' : 'A drawdown, but unrealised losses are only paper until you act; let the reviews guide which laggards still have an intact story.'}`,
    });
  }

  // net liquidity trend from the history trail
  let trend = null;
  const hist = book.netLiqHistory || [];
  if (hist.length >= 2) {
    const first = num(hist[0].netLiq), last = num(hist[hist.length - 1].netLiq);
    if (first != null && last != null && first > 0) {
      const chg = ((last - first) / first) * 100;
      trend = { from: first, to: last, pct: +chg.toFixed(1), points: hist.length };
    }
  }

  // ---- richer portfolio analytics (the expanded insights) ----
  const val = (h) => Math.abs((num(h.qty) || 0) * (num(h.lastPrice) || num(h.avgCost) || 0));
  const totVal = holdings.reduce((a, h) => a + val(h), 0) || 1;

  // sector concentration + hidden chip exposure
  const sectorAgg = {};
  let chipVal = 0;
  for (const h of holdings) {
    const sec = sectorOf(h);
    sectorAgg[sec] = (sectorAgg[sec] || 0) + val(h);
    if (isChipExposed(sec)) chipVal += val(h);
  }
  const sectors = Object.entries(sectorAgg).map(([name, v]) => ({ name, pct: +((v / totVal) * 100).toFixed(1) })).sort((a, b) => b.pct - a.pct);
  const chipPct = +((chipVal / totVal) * 100).toFixed(1);
  const topSector = sectors[0] || null;

  // geographic spread
  const geoAgg = {};
  for (const h of holdings) {
    const geo = /SGX/i.test(h.exchange || '') ? 'Singapore' : /HK|HONG/i.test(h.exchange || '') ? 'Hong Kong' : 'US';
    geoAgg[geo] = (geoAgg[geo] || 0) + val(h);
  }
  const geography = Object.entries(geoAgg).map(([name, v]) => ({ name, pct: +((v / totVal) * 100).toFixed(1) })).sort((a, b) => b.pct - a.pct);

  // single-name concentration: is any one position too large a share?
  const nameWeights = holdings.map((h) => ({ name: h.ticker || h.name, pct: +((val(h) / totVal) * 100).toFixed(1) })).sort((a, b) => b.pct - a.pct);
  const topName = nameWeights[0] || null;

  // winner / laggard attribution: which positions actually drive the book
  const withPL = holdings.filter((h) => num(h.unrealised) != null);
  const sortedPL = [...withPL].sort((a, b) => (num(b.unrealised) || 0) - (num(a.unrealised) || 0));
  const topWinners = sortedPL.filter((h) => (num(h.unrealised) || 0) > 0).slice(0, 3).map((h) => ({ name: h.ticker || h.name, pl: +num(h.unrealised).toFixed(2) }));
  const topLaggards = sortedPL.filter((h) => (num(h.unrealised) || 0) < 0).slice(-3).reverse().map((h) => ({ name: h.ticker || h.name, pl: +num(h.unrealised).toFixed(2) }));

  // concentration reads folded in with status colours + healthy thresholds from the research
  if (topSector) {
    const st = topSector.pct > 40 ? 'RED' : topSector.pct > 30 ? 'AMBER' : 'GREEN';
    reads.push({
      label: 'Sector concentration', value: `${topSector.name} ${topSector.pct}%`, status: st,
      note: st === 'GREEN'
        ? `Your largest sector, ${topSector.name}, is ${topSector.pct}% of the book, within a healthy spread (a common guide is no single sector above ~30%).`
        : `Your book leans heavily on ${topSector.name} at ${topSector.pct}%. A common healthy guide is no single sector above ~25-30%, so this is a concentration worth easing via the Balance tab.`,
    });
  }
  if (chipPct > 0) {
    const st = chipPct > 45 ? 'RED' : chipPct > 30 ? 'AMBER' : 'GREEN';
    reads.push({
      label: 'Chip exposure (hidden)', value: `${chipPct}%`, status: st,
      note: st === 'GREEN'
        ? `About ${chipPct}% of your book is semiconductor-exposed once you look through the ETFs. A reasonable level.`
        : `Roughly ${chipPct}% of your book rides on semiconductors once you look through the ETFs and separate names. They tend to move together, so this is real hidden concentration; the Balance tab is built to reduce it.`,
    });
  }
  if (topName && topName.pct > 10) {
    reads.push({
      label: 'Single-name risk', value: `${topName.name} ${topName.pct}%`, status: topName.pct > 20 ? 'AMBER' : 'GREEN',
      note: `${topName.name} is ${topName.pct}% of your book. A common guide keeps any single stock under ~5-10%; a shock to one large name hits the whole book hardest.`,
    });
  }
  if (geography.length) {
    const usPct = (geography.find((g) => g.name === 'US') || {}).pct || 0;
    reads.push({
      label: 'Geographic spread', value: geography.map((g) => `${g.name} ${g.pct}%`).join(' · '), status: usPct > 85 ? 'AMBER' : 'GREEN',
      note: usPct > 85
        ? `About ${usPct}% of your book is US-listed, which you can only trade late at night. Adding SG/HK/regional daytime-tradeable names spreads both geography and trading hours.`
        : `A genuine geographic spread across ${geography.map((g) => g.name).join(', ')}, which helps both diversification and daytime tradeability.`,
    });
  }

  return {
    figures: {
      netLiq, ledgerBalance, equityBalance, unrealizedPL, initialMargin, buyingPower,
    },
    reads, trend,
    analytics: { sectors, chipPct, geography, nameWeights: nameWeights.slice(0, 6), topWinners, topLaggards, holdingsCount: holdings.length },
    leveraged: levHoldings.map((h) => h.ticker || h.name),
    lastSync: book.lastSync || null,
  };
}

// ---------- Coaching progression: notice improvements, praise, advance ----------
// Derives a small set of book-health goals from the vitals analytics, checks each
// against a healthy threshold, and by comparing to the last saved snapshot, notices
// when a goal has newly been MET so it can praise the win and surface the next focus.
function computeCoaching(book, vitals, prevGoals) {
  if (!vitals || !vitals.analytics) return null;
  const a = vitals.analytics;
  const goals = [];

  // goal 1: cut chip concentration below 30%
  if (a.chipPct != null) goals.push({ id: 'chip', label: 'Reduce chip exposure below 30%', met: a.chipPct <= 30, detail: `${a.chipPct}% chip-exposed`, target: '≤30%' });
  // goal 2: no single sector above 30%
  const top = (a.sectors || [])[0];
  if (top) goals.push({ id: 'sector', label: 'No single sector above 30%', met: top.pct <= 30, detail: `${top.name} ${top.pct}%`, target: '≤30%' });
  // goal 3: no single stock above 20%
  const topName = (a.nameWeights || [])[0];
  if (topName) goals.push({ id: 'name', label: 'No single stock above 20%', met: topName.pct <= 20, detail: `${topName.name} ${topName.pct}%`, target: '≤20%' });
  // goal 4: some geographic spread (US under 85%)
  const us = (a.geography || []).find((g) => g.name === 'US');
  if (us) goals.push({ id: 'geo', label: 'Spread beyond US (US under 85%)', met: us.pct < 85, detail: `US ${us.pct}%`, target: '<85%' });

  // compare to previous snapshot to detect NEWLY met goals (progress to praise)
  const prevMap = {};
  (prevGoals || []).forEach((g) => { prevMap[g.id] = g.met; });
  const justAchieved = goals.filter((g) => g.met && prevMap[g.id] === false).map((g) => g.label);

  const metCount = goals.filter((g) => g.met).length;
  const nextFocus = goals.find((g) => !g.met) || null;

  return {
    goals, metCount, total: goals.length,
    justAchieved,
    nextFocus: nextFocus ? { label: nextFocus.label, detail: nextFocus.detail, target: nextFocus.target } : null,
    allMet: metCount === goals.length && goals.length > 0,
  };
}

async function actGet() {
  const t = bkk();
  const s = await loadAll();
  const ideas = await rGet(`exchange:ideas:${t.dateKey}`);
  const vitals = computeVitals(s.book);
  // coaching: compare current goals to the last saved snapshot to notice improvements
  const coaching = computeCoaching(s.book, vitals, (s.book.coachGoals || []));
  if (coaching) {
    // persist the current goal states so next time we can detect newly-met goals
    s.book.coachGoals = coaching.goals.map((g) => ({ id: g.id, met: g.met }));
    await rSet('exchange:book', s.book);
  }
  return {
    clock: t,
    book: s.book,
    ledger: s.ledger.slice(-80),
    lessons: s.lessons,
    guidance: s.guidance,
    guidanceMeta: s.guidanceMeta,
    universe: s.universe,
    ideasToday: ideas,
    vitals,
    coaching,
  };
}

// ---------- Seed the genuine NOVA book (one-time) ----------
async function actSeed(seedBook, seedWatchlist, force) {
  const t = bkk();
  if (!seedBook || !Array.isArray(seedBook.holdings)) throw new Error('No valid seed book provided.');
  // SAFETY (audit finding 6 / P0): seed is a first-run BOOTSTRAP for an EMPTY book. It must
  // NOT silently overwrite a real, populated portfolio — that was a one-call total wipe. If a
  // book with holdings already exists, refuse unless the caller explicitly forces it, and
  // return the current book untouched so the UI can warn instead of destroying data.
  const existing = await rGet('exchange:book').catch(() => null);
  if (existing && Array.isArray(existing.holdings) && existing.holdings.length > 0 && !force) {
    return {
      ok: false, refused: true, existingHoldings: existing.holdings.length,
      note: `Seed refused: your book already holds ${existing.holdings.length} position(s). Seeding would overwrite them. This is a first-run bootstrap only. To replace a real book, sync a screenshot instead, or re-seed explicitly with force.`,
      clock: t,
    };
  }
  const book = {
    holdings: seedBook.holdings,
    pendingReview: [],
    netLiq: seedBook.netLiq ?? null,
    netLiqHistory: seedBook.netLiqHistory || (seedBook.netLiq != null ? [{ ts: t.iso, netLiq: seedBook.netLiq }] : []),
    account: seedBook.account || null,
    lastSync: seedBook.lastSync || t.iso,
    seededFrom: seedBook.seededFrom || 'seed',
    watchlist: seedWatchlist || [],
  };
  await rSet('exchange:book', book);
  return { ok: true, seeded: book.holdings.length, clock: t };
}

// ---------- Flag a name unavailable on the NOVA platform (never propose again) ----------
async function actFlagUnavailable(name, available) {
  const s = await loadAll();
  const key = (name || '').toUpperCase().trim();
  if (!key) throw new Error('No name given to flag.');
  const u = s.universe || { tradeable: [], unavailable: [] };
  u.tradeable = (u.tradeable || []).filter((x) => x.toUpperCase() !== key);
  u.unavailable = (u.unavailable || []).filter((x) => x.toUpperCase() !== key);
  if (available) u.tradeable.push(key); else u.unavailable.push(key);
  await rSet('exchange:universe', u);
  return { ok: true, universe: u };
}

// ---------- Resolve passed ideas + run the daily reflection ----------
async function actLearn(priceMap) {
  const t = bkk();
  const s = await loadAll();
  // fetch live prices for any passed gems still being tracked, so the shadow book
  // resolves against the real market. Caller-supplied prices take precedence.
  const trackedTickers = s.ledger
    .filter((r) => r.status === 'passed' && !r.shadowResolved)
    .map((r) => r.idea.ticker || r.idea.name).filter(Boolean);
  const livePriceMap = trackedTickers.length ? await livePrices(trackedTickers) : {};
  const merged = { ...livePriceMap, ...(priceMap || {}) };
  const graded = resolveShadow(s, t, merged);
  await rSet('exchange:ledger', s.ledger.slice(-400));
  let reflection = null;
  const alreadyReflectedToday = s.guidanceMeta && s.guidanceMeta.at && s.guidanceMeta.at.slice(0, 10) === t.iso.slice(0, 10);
  if (!alreadyReflectedToday) {
    try { reflection = await reflectAndLearn(s, t); } catch { /* reflection is a bonus, never fatal */ }
  }
  return { clock: t, graded, reflection, guidance: s.guidance, guidanceMeta: s.guidanceMeta };
}

// ---------- Request handler: the single front door ----------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { action, ...p } = req.body || {};
    let out;
    if (action === 'get') out = await actGet();
    else if (action === 'ideas') out = await actIdeas(!!p.force);
    else if (action === 'sync') out = await actSync(p.positionsImages || p.positionsImage, p.historyImage);
    else if (action === 'review') out = await actReview(p.holdingId);
    else if (action === 'setlevels') out = await actSetLevels(p.holdingId, p.sl, p.tp);
    else if (action === 'rebalance') out = await actRebalance();
    else if (action === 'proofofclose') out = await actProofOfClose(p.positionsImage);
    else if (action === 'pass') out = await actPass(p.ideaLedgerId, p.idea);
    else if (action === 'takeup') out = await actTakeUp(p.ideaLedgerId, p.idea);
    else if (action === 'flag') out = await actFlagUnavailable(p.name, p.available);
    else if (action === 'learn') out = await actLearn(p.priceMap);
    else if (action === 'seed') out = await actSeed(p.seedBook, p.seedWatchlist, p.force);
    else return res.status(400).json({ error: `Unknown action: ${action}` });
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}





