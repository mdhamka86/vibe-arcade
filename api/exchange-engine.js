// api/exchange-engine.js
// THE EXCHANGE — equities desk brain. Week-long stock ideas, screenshot parsing,
// position health reviews, shadow book and learning loop, all shaped for shares.
// Sibling to terminal-engine.js. State lives in Upstash Redis.
//
// Env vars required on Vercel:
//   ANTHROPIC_API_KEY
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (or KV_REST_API_URL / KV_REST_API_TOKEN)

import { getNews } from './exchange-news.js';

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const MODEL = 'claude-sonnet-4-6';

// ---------- Redis ----------
async function rGet(key) {
  const r = await fetch(`${R_URL}/get/${key}`, { headers: { Authorization: `Bearer ${R_TOK}` } });
  const j = await r.json();
  try { return j.result ? JSON.parse(j.result) : null; } catch { return null; }
}
async function rSet(key, val) {
  await fetch(`${R_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOK}` },
    body: JSON.stringify(val),
  });
}

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
  const text = (j.content || []).map((c) => c.text || '').join('\n');
  const clean = text.replace(/```json|```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : clean);
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
function checkLevels(idea, realPrice) {
  const dir = (idea.direction || '').toUpperCase();
  const entry = num(idea.entry);
  let cur = num(idea.current_price);
  const tp = num(idea.tp);
  const sl = num(idea.sl);
  if (entry == null || tp == null || sl == null) return { ok: false, reason: 'missing a numeric entry, TP or SL' };
  if (dir !== 'BUY' && dir !== 'SELL') return { ok: false, reason: 'direction not BUY/SELL' };

  // 0) REALITY CHECK: if a genuine live price is supplied, the idea's stated current
  // price must match it closely. This catches a gem anchored to a stale/hallucinated
  // price (e.g. claiming 58 when the market is 94). A >6% gap fails outright.
  if (realPrice != null && realPrice > 0) {
    if (cur != null) {
      const gap = Math.abs(cur - realPrice) / realPrice;
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
  const news = await getNews('holdings', tickerParam);

  // freshness memory: names proposed in the last 10 days must not be repeated, and
  // names already held should not be proposed as fresh swing ideas either.
  const recent = s.ledger.filter((r) => r.idea && r.ts > Date.now() - 10 * 86400e3);
  const recentNames = new Set(recent.map((r) => (r.idea.ticker || r.idea.name || '').toUpperCase()).filter(Boolean));
  const heldNames = new Set((s.book.holdings || []).map((h) => (h.ticker || h.name || '').toUpperCase()).filter(Boolean));
  const bannedList = [...new Set([...recentNames, ...heldNames])];

  // names the user has confirmed are NOT available on Phillip Nova: never propose again
  const unavailable = new Set((s.universe.unavailable || []).map((u) => (u || '').toUpperCase()));

  const historyLines = recent.map((r) => `- ${r.date}: ${r.idea.name}${r.idea.ticker ? ' (' + r.idea.ticker + ')' : ''} ${r.idea.direction} (${r.status})`).join('\n') || '- none';
  const priorGuidance = (s.guidance || []).map((g) => `- ${g.text}${g.basis ? ' [' + g.basis + ']' : ''}`).join('\n') || '- none yet; not enough resolved history';
  const recentLessons = (s.lessons || []).slice(-10).map((l) => `- ${l.text}`).join('\n') || '- none yet';

  const prompt = `You are the ideas engine of THE EXCHANGE, the equities desk of a retail investor in Phuket who trades US stocks through Phillip Nova (a "NOVA" account). His long-term convictions are already held in his portfolio; your job is DIFFERENT and specific: hunt SHORT-TERM SWING TRADES to hold for 5-6 days, one week maximum. No long-term plays.

YOUR MANDATE (read carefully):
1. HORIZON: every idea is a 5-6 day swing, one week ceiling. Not a long-term investment. The thesis must be able to play out inside a week (a catalyst, a technical bounce, a post-earnings drift, an insider-buying pop).
2. ROAM ALL INDUSTRIES: actively hunt across the WHOLE market, healthcare, energy, industrials, financials, consumer, materials, utilities, biotech, and yes occasionally tech. DELIBERATELY AVOID semiconductors and chip names: his portfolio is already saturated with them, so a semi idea is near-useless to him. Find gems in corners he is NOT already exposed to.
3. BE ADVENTUROUS: he wants genuine gems, so range into small and mid caps and special situations, not just mega-caps. But see the TRADEABILITY rule below.
4. WEIGH ALL FOUR SIGNAL FAMILIES and prize CONVERGENCE where several align on one name:
   - Insider & congressional buying (an insider or member of Congress recently buying with real money is a strong tell)
   - Value & fundamentals (cheap versus peers, quality at a temporary discount)
   - News & catalysts (earnings beats, upgrades, contract wins, product news, FDA decisions)
   - Technical setups (pullback into support, a clean base, a breakout with volume)
   The best idea is one where 2+ of these point the same way. Name which signals fire in the reason.
5. TRADEABILITY (critical): only propose names that are properly LISTED on a major US exchange (NASDAQ, NYSE, or NYSE American). NEVER propose OTC, pink-sheet, or nano-cap names that a retail broker like Phillip Nova almost certainly cannot trade. When in doubt, prefer the more liquid, clearly-listed name. Mark each idea's availability as "likely" and note it needs his confirmation on the platform.
6. NO DUPLICATES: do NOT propose any name in this banned list (recently proposed or already held): ${bannedList.join(', ') || 'none yet'}.
7. NEVER propose any name he has flagged unavailable on his platform: ${[...unavailable].join(', ') || 'none yet'}.

CURRENT HOLDINGS (context only, do NOT propose these): ${holdingsSummary(s.book)}

RECENT IDEA HISTORY (last 10 days, for freshness):
${historyLines}

SELF-IMPROVEMENT GUIDANCE (from the desk's own tracked record; APPLY these):
${priorGuidance}

LESSONS ARCHIVE:
${recentLessons}

TODAY'S MARKET & COMPANY NEWS WIRE:
${digest(news, 28)}

TASK: Propose exactly 2 fresh week-long swing ideas. Present each EXACTLY in his journal's language: stock name, ticker, entry point, current market price, buy or sell, take profit, stop loss, and the reason (naming the signals that fire). Be genuinely critical and honest: if today offers nothing genuinely worth a week of risk, say so plainly in desk_note and mark ideas at their true lower conviction rather than inflating them.

LEVEL DISCIPLINE (every number is validated after you respond, so get them right):
- entry must sit within ~8% of the current price (a fillable swing entry, not a far-off limit).
- BUY: stop below entry, target above. SELL: stop above entry, target below.
- stop distance sane for a one-week hold: roughly 3-10% from entry, never tighter than ~2% (daily noise) nor wider than ~15%.
- aim for reward:risk of at least 1.5. State real price levels, not round guesses.
- CONVICTION on a four-rung scale: LOW, MED, MED-HIGH, HIGH. Reserve the top two rungs for genuine multi-signal convergence.

Respond ONLY with JSON, no markdown:
{"ideas":[{"name":"Company Name","ticker":"TICK","exchange":"NASDAQ|NYSE|NYSE American","industry":"e.g. Healthcare","direction":"BUY|SELL","current_price":"12.40","entry":"12.00-12.30","tp":"14.20","sl":"11.10","horizon":"5-6 day swing","conviction":"LOW|MED|MED-HIGH|HIGH","signals":["insider","value","catalyst","technical"],"reason":"the thesis, naming which signals fire, max 45 words","availability":"likely — confirm on your NOVA platform"}],"stand_down":false,"desk_note":"one honest paragraph on the session's hunt, max 55 words"}`;

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
      const lc = checkLevels(i, real);
      if (real != null) i.current_price = String(real); // show the true market price
      if (!lc.ok) { i.level_warning = `LEVELS UNVERIFIED: ${lc.reason}. Confirm on your chart before trading.`; i.conviction = 'LOW'; }
      else { i.rr = lc.rr; i.slPct = lc.slPct; i.tpPct = lc.tpPct; }
    });
  } else {
    (ideas.ideas || []).forEach((i) => {
      const real = realFor(i);
      const lc = checkLevels(i, real);
      if (real != null) i.current_price = String(real);
      i.rr = lc.rr; i.slPct = lc.slPct; i.tpPct = lc.tpPct;
    });
  }

  ideas.generatedAt = t.iso;
  ideas.dateKey = t.dateKey;
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
    positions: `This is a screenshot of a Phillip Nova (NOVA) equities account showing stock holdings.
Extract EVERY holding and the account totals.
JSON: {"holdings":[{"name":"Company Name","ticker":"TICK or null","qty":5,"avgCost":192.02,"lastPrice":195.02,"unrealised":11.59,"status":"Open"}],"netLiq":3864.04}
Use null for anything not visible. Numbers as numbers, not strings. Fractional qty is allowed (e.g. 0.1).`,
    history: `This is a screenshot of Phillip Nova (NOVA) trade history / closed positions.
Extract EVERY closed deal visible.
JSON: {"closes":[{"name":"Company Name","ticker":"TICK or null","qty":5,"avgCost":192.02,"exit":198.10,"realised":30.40,"closeDate":"2026.07.02"}]}`,
  }[kind];

  return claude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
    { type: 'text', text: `${spec}\nRespond ONLY with JSON, no markdown, no commentary.` },
  ], 2000);
}

function sameHolding(a, b) {
  const an = (a.ticker || a.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bn = (b.ticker || b.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!an || !bn) return false;
  // match on ticker/name stem; tolerate slight name variations by prefix
  return an === bn || an.startsWith(bn.slice(0, 5)) || bn.startsWith(an.slice(0, 5));
}

// ---------- Book sync: read positions (+ optional history), reconcile, review ----------
async function actSync(positionsImg, historyImg) {
  const t = bkk();
  const s = await loadAll();
  const posParse = positionsImg ? await parseShot(positionsImg, 'positions') : { holdings: [], netLiq: null };
  const histParse = historyImg ? await parseShot(historyImg, 'history') : { closes: [] };

  const seen = posParse.holdings || [];
  const report = { closedDetected: [], newAdded: [], updated: 0, netLiq: posParse.netLiq ?? null };

  // 1) reconcile: holdings in the book but absent on screen => sold; match to history
  const still = [];
  for (const h of (s.book.holdings || [])) {
    const onScreen = seen.find((x) => sameHolding(x, h));
    if (onScreen) {
      h.lastPrice = onScreen.lastPrice ?? h.lastPrice;
      h.unrealised = onScreen.unrealised ?? h.unrealised;
      h.qty = onScreen.qty ?? h.qty;
      report.updated++;
      still.push(h);
    } else {
      const match = (histParse.closes || []).find((c) => sameHolding(c, h));
      report.closedDetected.push({
        id: `close_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        holding: h, close: match || null, detectedAt: t.iso, needsHistory: !match,
      });
    }
  }
  // 2) holdings on screen but not in the book => newly seen, adopt them
  for (const x of seen) {
    if (!(s.book.holdings || []).find((h) => sameHolding(h, x))) {
      const adopted = {
        id: `hold_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: x.name, ticker: x.ticker || null, qty: x.qty, avgCost: x.avgCost,
        lastPrice: x.lastPrice ?? null, unrealised: x.unrealised ?? null,
        openedAt: Date.now(), firstSeen: t.dmy,
      };
      still.push(adopted);
      report.newAdded.push(adopted);
    }
  }
  s.book.holdings = still;

  // 3) net liquidation value + its history trail (the equity equivalent of vitals)
  if (posParse.netLiq != null) {
    s.book.netLiq = posParse.netLiq;
    s.book.netLiqHistory = [...(s.book.netLiqHistory || []), { ts: t.iso, netLiq: posParse.netLiq }].slice(-90);
  }
  s.book.lastSync = t.iso;
  await rSet('exchange:book', s.book);

  return { clock: t, report, book: s.book };
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

  // profit/loss posture against average cost, for honest framing
  const pl = (h.lastPrice != null && h.avgCost != null)
    ? `currently ${h.lastPrice >= h.avgCost ? 'above' : 'below'} cost: paid ${h.avgCost}, now ${h.lastPrice} (${(((h.lastPrice - h.avgCost) / h.avgCost) * 100).toFixed(1)}%)`
    : 'cost basis unclear';

  const verdict = await claude(`You are THE EXCHANGE's position analyst, reviewing ONE long-term equity holding in a Phuket investor's Phillip Nova (NOVA) portfolio. These are his considered long-term convictions, NOT week-long swings, so judge with patience, like a seasoned analyst rather than a jumpy trader. Run a zero-based review (Peter Lynch's test: if he held none of this today, would buying it right now at this price be justified?).

HOLDING UNDER REVIEW:
${h.name}${h.ticker ? ' (' + h.ticker + ')' : ''}, ${h.qty} shares @ avg cost ${h.avgCost}, last price ${h.lastPrice ?? '?'}, unrealised P/L ${h.unrealised ?? '?'}.
Posture: ${pl}. Held roughly ${held} day(s) since first tracked${h.mentalTP || h.mentalSL ? `. Existing levels: TP ${h.mentalTP || 'none'}, SL ${h.mentalSL || 'none'}` : '. No stop or target set yet.'}

FRESH COMPANY & MARKET NEWS:
${digest(news, 16)}

LESSONS ARCHIVE:
${priorLessons}

Your job, four honest judgements:
1. HOLD or CLOSE: is the original reason for owning this still intact? A holding being down is NOT itself a reason to close; a broken thesis is. A holding being up is not itself a reason to sell; a spent thesis or a better use of the capital might be. Default to patience for a long-term conviction, but be honest if the story has genuinely broken.
2. PROPOSED LEVELS: suggest a sensible stop loss and take profit for this holding grounded in the current price and situation, since he often has none set. Give real price levels.
3. HOLDING HORIZON: given it is a long-term conviction, offer a sensible sense of how long to keep holding or what milestone/catalyst to hold toward.
4. REASON: ground every judgement in the current news and the company's actual situation, not generic platitudes.

Respond ONLY with JSON, no markdown:
{"verdict":"HOLD|CLOSE|TRIM","reason":"2-3 sentences grounded in current facts","proposed_sl":"price level","proposed_tp":"price level","hold_guidance":"how long / toward what, one sentence","conviction":"how sure you are, one short phrase"}`, 1400);

  // persist the review and the proposed levels onto the holding
  h.lastReview = {
    verdict: verdict.verdict, reason: verdict.reason,
    proposed_sl: verdict.proposed_sl || null, proposed_tp: verdict.proposed_tp || null,
    hold_guidance: verdict.hold_guidance || null, at: t.iso,
  };
  // if he had no levels set, gently adopt the proposals as the working mental levels
  if (!h.mentalSL && verdict.proposed_sl) h.mentalSL = verdict.proposed_sl;
  if (!h.mentalTP && verdict.proposed_tp) h.mentalTP = verdict.proposed_tp;
  await rSet('exchange:book', s.book);

  return { clock: t, verdict, holding: h };
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
async function actPass(ideaLedgerId) {
  const s = await loadAll();
  const rec = s.ledger.find((r) => r.id === ideaLedgerId);
  if (rec) { rec.status = 'passed'; rec.passedAt = Date.now(); }
  await rSet('exchange:ledger', s.ledger.slice(-400));
  return { ok: true };
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

// ---------- Gather the whole state for the front end ----------
async function actGet() {
  const t = bkk();
  const s = await loadAll();
  const ideas = await rGet(`exchange:ideas:${t.dateKey}`);
  return {
    clock: t,
    book: s.book,
    ledger: s.ledger.slice(-80),
    lessons: s.lessons,
    guidance: s.guidance,
    guidanceMeta: s.guidanceMeta,
    universe: s.universe,
    ideasToday: ideas,
  };
}

// ---------- Seed the genuine NOVA book (one-time) ----------
async function actSeed(seedBook, seedWatchlist) {
  const t = bkk();
  if (!seedBook || !Array.isArray(seedBook.holdings)) throw new Error('No valid seed book provided.');
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
    else if (action === 'sync') out = await actSync(p.positionsImage, p.historyImage);
    else if (action === 'review') out = await actReview(p.holdingId);
    else if (action === 'pass') out = await actPass(p.ideaLedgerId);
    else if (action === 'flag') out = await actFlagUnavailable(p.name, p.available);
    else if (action === 'learn') out = await actLearn(p.priceMap);
    else if (action === 'seed') out = await actSeed(p.seedBook, p.seedWatchlist);
    else return res.status(400).json({ error: `Unknown action: ${action}` });
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
