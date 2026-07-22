// api/terminal-engine.js
// THE TERMINAL — desk brain. Ideas engine, screenshot parsing, reconciliation,
// aging ladder, red flag reviews, AAR, lessons archive. State lives in Upstash Redis.
//
// Env vars required on Vercel:
//   ANTHROPIC_API_KEY            (console.anthropic.com)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (or KV_REST_API_URL / KV_REST_API_TOKEN)

import { getNews, getSymbolIdeas } from './terminal-news.js';

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const MODEL = 'claude-sonnet-4-6';

// ---------- Redis ----------
async function rGet(key) {
  const r = await fetch(`${R_URL}/get/${key}`, { headers: { Authorization: `Bearer ${R_TOK}` } });
  // audit finding 3: a transient Redis/network failure must NOT masquerade as "empty state",
  // which would make the whole book look wiped. Fail loudly so the caller aborts rather than
  // proceeding on phantom-empty data.
  if (!r.ok) throw new Error(`Storage read failed (${r.status}). Your data is safe — this was a connection issue, not a change. Try again in a moment.`);
  const j = await r.json();
  // j.result === null means the key genuinely doesn't exist yet (fine); a parse error on a
  // present value is a real problem, so surface it rather than swallowing to null.
  if (j.result == null) return null;
  try { return JSON.parse(j.result); }
  catch { throw new Error(`Stored data for "${key}" was unreadable (corrupt value). Not proceeding, to avoid overwriting it.`); }
}
async function rSet(key, val) {
  const r = await fetch(`${R_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOK}` },
    body: JSON.stringify(val),
  });
  // audit finding 3: a failed write must NOT report success, or the UI shows a change that
  // never persisted. Throw so the caller knows the save didn't land.
  if (!r.ok) throw new Error(`Storage write failed (${r.status}). Your change may not have saved — please retry.`);
  return true;
}

// ---------- Bangkok clock ----------
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
    weekday: g('weekday'), // Mon..Sun
    isWeekend: ['Sat', 'Sun'].includes(g('weekday')),
    isFriday: g('weekday') === 'Fri',
    iso: now.toISOString(),
  };
}
const daysHeld = (openedAt) => Math.max(0, Math.floor((Date.now() - openedAt) / 86400000));
// Aging ladder tuned to the one-day horizon doctrine: a one-day trade still open
// on day 3 has materially overstayed its intended life, so the red review unlocks there.
const ageFlag = (d) => (d >= 3 ? 'RED' : d >= 2 ? 'AMBER' : d >= 1 ? 'NOTE' : 'OK');

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
  if (j.stop_reason === 'max_tokens') {
    throw new Error('The desk had more to say than the response could hold (hit the token limit). Try again in a moment.');
  }
  const text = (j.content || []).map((c) => c.text || '').join('\n');
  const clean = text.replace(/```json|```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(m ? m[0] : clean);
  } catch (e) {
    throw new Error('The desk returned an incomplete response and could not be read. Please try again in a moment.');
  }
}

// ---------- Economic calendar (Forex Factory weekly feed, Redis-cached 6h to
// respect their rate limit of ~2 pulls per 5 minutes) ----------
async function getCalendar() {
  const cached = await rGet('terminal:cal');
  if (cached && Date.now() - cached.ts < 6 * 3600 * 1000) return cached.events;
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0 (TheTerminal/1.0)' },
    });
    const xml = await r.text();
    if (!xml.includes('<weeklyevents')) return cached ? cached.events : [];
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const events = [];
    for (const b of xml.match(/<event>[\s\S]*?<\/event>/g) || []) {
      const g = (n) => {
        const m = b.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`));
        return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
      };
      const impact = g('impact');
      if (!/High|Medium|Holiday/i.test(impact)) continue;
      const [mm, dd, yy] = g('date').split('-').map(Number);
      const tm = g('time').match(/(\d+):(\d+)(am|pm)/i);
      let h = 0, mi = 0;
      if (tm) { h = (+tm[1] % 12) + (tm[3].toLowerCase() === 'pm' ? 12 : 0); mi = +tm[2]; }
      const utc = Date.UTC(yy, mm - 1, dd, h, mi); // feed times are GMT
      if (utc < Date.now() - 3600e3 || utc > Date.now() + 56 * 3600e3) continue;
      const bkk = new Date(utc + 7 * 3600e3);
      events.push({
        title: g('title'), ccy: g('country'), impact, forecast: g('forecast'), previous: g('previous'), utc,
        when: `${days[bkk.getUTCDay()]} ${String(bkk.getUTCHours()).padStart(2, '0')}:${String(bkk.getUTCMinutes()).padStart(2, '0')} BKK`,
      });
    }
    events.sort((a, b) => a.utc - b.utc);
    await rSet('terminal:cal', { ts: Date.now(), events });
    return events;
  } catch {
    return cached ? cached.events : [];
  }
}
function calLines(events, ccys) {
  const f = ccys && ccys.length ? events.filter((e) => ccys.includes(e.ccy)) : events;
  return f.slice(0, 14).map((e) =>
    `- ${e.when} · ${e.ccy} ${e.title} [${e.impact}]${e.forecast ? ` (fc ${e.forecast}, prev ${e.previous})` : ''}`
  ).join('\n') || '- nothing High/Medium in the next 48h window';
}
const normPair = (p) => (p || '').replace(/[^A-Za-z]/g, '').toUpperCase();

// ---------- Self-improvement reflection ----------
// Studies the resolved shadow scorecard plus taken-trade AARs and distils a standing
// set of concrete guidance notes that shape future idea generation. This is the
// learning loop: the desk gets measurably better by reflecting on its own record.
function shadowScorecard(ledger) {
  const resolved = ledger.filter((r) => r.status === 'passed' && r.shadowVerdict && r.shadowVerdict.grade);
  const taken = ledger.filter((r) => r.aar && r.aar.bucket);
  const tally = { win: 0, loss: 0, soft: 0, other: 0, total: resolved.length };
  const byPair = {};
  for (const r of resolved) {
    const g = r.shadowVerdict.grade;
    const isWin = g === 'WIN' || g === 'SOFT_WIN';
    const isLoss = g === 'LOSS' || g === 'SOFT_LOSS';
    if (g === 'WIN') tally.win++; else if (g === 'LOSS') tally.loss++;
    else if (g === 'SOFT_WIN' || g === 'SOFT_LOSS') tally.soft++; else tally.other++;
    const p = normPair(r.idea.pair);
    byPair[p] = byPair[p] || { w: 0, l: 0 };
    if (isWin) byPair[p].w++; else if (isLoss) byPair[p].l++;
  }
  return { tally, byPair, resolved, taken };
}

async function reflectAndLearn(s, t) {
  const card = shadowScorecard(s.ledger);
  // need a reasonable sample before drawing conclusions; avoid jumping at noise
  if (card.resolved.length < 6) return null;

  const pairLines = Object.entries(card.byPair)
    .filter(([, v]) => v.w + v.l >= 2)
    .map(([p, v]) => `${p}: ${v.w}W-${v.l}L`).join(', ') || 'no pair has 2+ resolved yet';
  const takenLines = card.taken.slice(-10)
    .map((r) => `${r.idea?.pair || r.close?.pair} ${r.aar.bucket}`).join(', ') || 'none';
  const priorGuidance = (s.guidance || []).map((g) => `- ${g.text}`).join('\n') || '- none yet';

  const reflection = await claude(`You are THE TERMINAL's performance analyst. Study the desk's own track record and distil what it should DO DIFFERENTLY to generate better ideas. Judge decision quality, not just outcomes.

SHADOW BOOK (ideas he passed on, tracked to resolution over 3 days):
Overall: ${card.tally.win} clean wins, ${card.tally.loss} clean losses, ${card.tally.soft} soft calls, from ${card.tally.total} resolved.
By pair: ${pairLines}

TAKEN TRADES (his, with AAR verdicts): ${takenLines}

GUIDANCE ALREADY STANDING (refine or replace, do not just repeat):
${priorGuidance}

Produce 2-4 concrete, actionable guidance notes for future idea generation. Each must be specific and testable, e.g. "NZD ideas are 1W-4L; require a stronger catalyst before proposing NZD" or "event-anchored ideas outperform; prioritise setups tied to the calendar". Avoid vague platitudes. If the record genuinely supports a pair or setup type working well, say to lean into it. If the sample is too thin for a claim, do not force it.
JSON only: {"guidance":[{"text":"concrete actionable note, max 22 words","basis":"the record that supports it, max 10 words"}],"hitrate_note":"one honest line on overall performance so far"}`, 1000);

  if (reflection && Array.isArray(reflection.guidance) && reflection.guidance.length) {
    s.guidance = reflection.guidance.map((g) => ({ text: g.text, basis: g.basis || null, date: t.dmy }));
    s.guidanceMeta = { at: t.iso, sample: card.tally.total, hitrate_note: reflection.hitrate_note || null,
      wins: card.tally.win, losses: card.tally.loss, soft: card.tally.soft };
    await rSet('terminal:guidance', s.guidance);
    await rSet('terminal:guidanceMeta', s.guidanceMeta);
  }
  return reflection;
}

// ---------- Idea level sanity check ----------
// Guards against the engine hallucinating an impossible level (e.g. a 1.5635 stop
// on NZDUSD, which trades near 0.5685). Returns {ok, reason, fixedFloating}.
// Parses the first number out of entry_zone / tp / sl and checks geometry vs a
// live reference price for the pair.
function num(v) {
  if (v == null) return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
// pip size: pairs quoted to 2 decimals (JPY and a few other crosses) use 0.01; the rest
// use 0.0001. We key off the QUOTE currency (the second half of the pair) where possible,
// and only fall back to the price magnitude when the pair string is unavailable.
function pipSize(pair, refPx) {
  const p = normPair(pair);
  // quote currencies that conventionally price to 2 decimals against majors
  const twoDecimalQuotes = ['JPY']; // JPY is the dominant 2-decimal quote for these majors
  const quote = p.length >= 6 ? p.slice(3, 6) : '';
  if (twoDecimalQuotes.includes(quote) || p.includes('JPY')) return 0.01;
  // fallback only when we cannot read the pair: a genuine FX rate above ~20 is almost
  // certainly a 2-decimal quote (e.g. USDMXN, USDZAR), otherwise 4-decimal.
  if (!quote && refPx != null && refPx > 20) return 0.01;
  return 0.0001;
}
function checkLevels(idea, refPx) {
  const dir = (idea.direction || '').toUpperCase();
  const entry = num(idea.entry_zone);
  const tp = num(idea.tp);
  const sl = num(idea.sl);
  if (entry == null || tp == null || sl == null) return { ok: false, reason: 'missing a numeric entry, TP or SL' };
  if (dir !== 'BUY' && dir !== 'SELL') return { ok: false, reason: 'direction not BUY/SELL' };

  // 1) entry must live near the real market. For one-day trades an entry more than
  // ~1.5% from live is really a limit order that may never fill in the horizon.
  if (refPx) {
    const drift = Math.abs(entry - refPx) / refPx;
    if (drift > 0.015) return { ok: false, reason: `entry ${entry} is ${(drift * 100).toFixed(1)}% off live ${refPx.toFixed(4)} — too far to fill in a one-day window` };
    // every level should share the market's order of magnitude
    for (const [name, lvl] of [['TP', tp], ['SL', sl]]) {
      const d = Math.abs(lvl - refPx) / refPx;
      if (d > 0.06) return { ok: false, reason: `${name} ${lvl} is ${(d * 100).toFixed(1)}% from live ${refPx.toFixed(4)} — implausible for a one-day trade` };
    }
  }
  // 2) geometry: BUY => SL below entry, TP above; SELL => the reverse.
  if (dir === 'BUY' && !(sl < entry && tp > entry)) return { ok: false, reason: `BUY needs SL(${sl}) below and TP(${tp}) above entry(${entry})` };
  if (dir === 'SELL' && !(sl > entry && tp < entry)) return { ok: false, reason: `SELL needs SL(${sl}) above and TP(${tp}) below entry(${entry})` };

  // 3) stop distance must be sane for a short-term trade: not so tight that normal
  // noise stops it out, not so wide it ties up absurd risk for a one-day horizon.
  const pip = pipSize(idea.pair, refPx);
  const slPips = Math.abs(entry - sl) / pip;
  const tpPips = Math.abs(tp - entry) / pip;
  if (slPips < 8) return { ok: false, reason: `stop is only ${slPips.toFixed(0)} pips from entry — market noise will stop it out; needs room to breathe` };
  if (slPips > 150) return { ok: false, reason: `stop is ${slPips.toFixed(0)} pips away — far too wide for a one-day trade` };
  if (tpPips < 8) return { ok: false, reason: `target is only ${tpPips.toFixed(0)} pips from entry — not worth the spread and risk` };

  // 4) risk:reward should not be upside-down; reject if reward < risk
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk ? +(reward / risk).toFixed(2) : null;
  if (rr != null && rr < 1) return { ok: false, reason: `reward:risk ${rr} is below 1 — target closer than stop` };
  return { ok: true, rr, slPips: Math.round(slPips), tpPips: Math.round(tpPips) };
}
function refFor(pair, rates, live) {
  const p = normPair(pair);
  // PREFER the live quote (audit finding 10), but ONLY if it's a genuinely valid positive
  // number — a glitchy 0/NaN/negative must fall through to the daily rate, never poison level
  // validation (every stop/target would look catastrophically wrong against a zero reference).
  if (live && live[p] && Number.isFinite(live[p].price) && live[p].price > 0) return live[p].price;
  if (!rates) return null;
  if (rates[p] != null) return rates[p];
  const inv = p.slice(3, 6) + p.slice(0, 3);
  if (rates[inv] != null) return +(1 / rates[inv]).toFixed(5);
  return null;
}

// ---------- LIVE FX pricing + volatility (Yahoo, near-live; ATR from OHLC) ----------
// Audit finding 10: the desk needs CURRENT executable-grade prices and REAL volatility to
// validate one-day entries and size stops, not just yesterday's ECB daily fix. Yahoo's chart
// endpoint (keyless) gives a live indicative mid-price plus daily OHLC, from which we compute
// ATR(14) — the standard volatility measure — and the recent range. Indicative mid, not your
// broker's exact bid/ask, so it's for validation and stop-sizing, not the precise fill.
const YF_SYMBOL = { // pair -> Yahoo FX symbol
  EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'JPY=X', USDCHF: 'CHF=X', AUDUSD: 'AUDUSD=X',
  NZDUSD: 'NZDUSD=X', USDCAD: 'CAD=X', EURGBP: 'EURGBP=X', EURJPY: 'EURJPY=X', GBPJPY: 'GBPJPY=X',
  EURAUD: 'EURAUD=X', GBPAUD: 'GBPAUD=X', AUDJPY: 'AUDJPY=X', NZDJPY: 'NZDJPY=X', CADJPY: 'CADJPY=X',
  CHFJPY: 'CHFJPY=X', EURCHF: 'EURCHF=X', GBPCHF: 'GBPCHF=X', AUDCAD: 'AUDCAD=X', AUDNZD: 'AUDNZD=X',
  DXY: 'DX-Y.NYB',
};
async function yahooQuote(pair) {
  const sym = YF_SYMBOL[normPair(pair)];
  if (!sym) return null;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1mo`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (TheTerminal/1.0)' } });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res || !res.meta) return null;
    const m = res.meta, q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    const price = m.regularMarketPrice;
    if (!Number.isFinite(price) || price <= 0) return null; // reject null/0/NaN/negative at source
    // ATR(14) from daily OHLC
    let trs = [];
    const H = q.high || [], L = q.low || [], C = q.close || [];
    for (let i = 1; i < C.length; i++) {
      if (H[i] == null || L[i] == null || C[i - 1] == null) continue;
      trs.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
    }
    const atr = trs.length ? trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length) : null;
    const pip = pipSize(pair, price);
    // FRESHNESS (audit finding 5): don't call a quote "live" just because the price is positive.
    // Check how old regularMarketTime is. FX trades ~24/5, so a quote more than ~6h old (or with
    // no timestamp) is treated as STALE — usable as a rough reference, but NOT trusted to validate
    // a one-day entry to the pip. Weekend/cached data therefore can't masquerade as current.
    const mt = m.regularMarketTime ? m.regularMarketTime * 1000 : null;
    const ageMs = mt ? Date.now() - mt : null;
    const FRESH_MS = 6 * 3600 * 1000;
    const isFresh = ageMs != null && ageMs >= 0 && ageMs <= FRESH_MS;
    return {
      pair: normPair(pair), price: +price, asOf: mt ? new Date(mt).toISOString() : null,
      ageMinutes: ageMs != null ? Math.round(ageMs / 60000) : null,
      dayLow: m.regularMarketDayLow ?? null, dayHigh: m.regularMarketDayHigh ?? null,
      atr: atr != null ? +atr.toFixed(6) : null, atrPips: atr != null && pip ? Math.round(atr / pip) : null,
      live: isFresh, stale: !isFresh,
    };
  } catch { return null; }
}
// Fetch live quotes+volatility for a set of pairs, with honest per-pair fallback to daily rates.
async function livePrices(pairs, fallbackRates) {
  const uniq = [...new Set(pairs.map(normPair).filter((p) => YF_SYMBOL[p]))];
  const quotes = await Promise.all(uniq.map((p) => yahooQuote(p).catch(() => null)));
  const out = {};
  uniq.forEach((p, i) => {
    if (quotes[i]) out[p] = quotes[i];
    else if (fallbackRates && fallbackRates[p] != null) out[p] = { pair: p, price: fallbackRates[p], atr: null, atrPips: null, live: false, asOf: fallbackRates.asOf || null };
  });
  return out;
}
// A compact, HONEST text block for prompts: live where we have it, flagged stale where we don't.
function formatPrices(prices) {
  const rows = Object.values(prices || {});
  if (!rows.length) return 'no live pricing available this run';
  return rows.map((r) => {
    if (r.live) return `${r.pair}: ${r.price} (LIVE ${r.asOf ? r.asOf.slice(11, 16) + 'Z' : ''}${r.atrPips != null ? `, daily ATR ~${r.atrPips} pips` : ''}${r.dayLow != null ? `, today ${r.dayLow}-${r.dayHigh}` : ''})`;
    // stale-but-present Yahoo quote vs a pure daily-rate fallback: describe honestly
    if (r.stale && r.price != null) return `${r.pair}: ${r.price} (⚠ STALE${r.ageMinutes != null ? ` ~${Math.round(r.ageMinutes / 60)}h old` : ''}${r.atrPips != null ? `, ATR ~${r.atrPips} pips` : ''} — not current, likely weekend/closed; validate levels on your own chart)`;
    return `${r.pair}: ${r.price} (⚠ daily ref only — no live quote this run, treat cautiously)`;
  }).join('\n');
}

// ---------- Reference FX rates (frankfurter.dev, ECB daily, no key) — FALLBACK layer ----------
async function refRates() {
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY,CHF,AUD,NZD,CAD');
    const j = await r.json();
    const R = j.rates;
    const inv = (x) => (x ? +(1 / x).toFixed(5) : null);
    const cross = (a, b) => (R[a] && R[b] ? +(R[b] / R[a]).toFixed(5) : null); // A/B where both are USD-based
    return {
      asOf: j.date,
      // USD majors
      EURUSD: inv(R.EUR), GBPUSD: inv(R.GBP), USDJPY: R.JPY, USDCHF: R.CHF,
      AUDUSD: inv(R.AUD), NZDUSD: inv(R.NZD), USDCAD: R.CAD,
      // common crosses (value of A/B)
      EURGBP: cross('EUR', 'GBP'), EURJPY: R.JPY ? +(R.JPY / R.EUR).toFixed(5) : null,
      GBPJPY: R.JPY ? +(R.JPY / R.GBP).toFixed(5) : null, EURAUD: cross('EUR', 'AUD'),
      GBPAUD: cross('GBP', 'AUD'), AUDJPY: R.JPY ? +(R.JPY / R.AUD).toFixed(5) : null,
      NZDJPY: R.JPY ? +(R.JPY / R.NZD).toFixed(5) : null, AUDNZD: cross('AUD', 'NZD'),
      CADJPY: R.JPY ? +(R.JPY / R.CAD).toFixed(5) : null, CHFJPY: R.JPY ? +(R.JPY / R.CHF).toFixed(5) : null,
      EURCHF: cross('EUR', 'CHF'), GBPCHF: cross('GBP', 'CHF'), AUDCAD: cross('AUD', 'CAD'),
    };
  } catch { return null; }
}

// ---------- State ----------
async function loadAll() {
  const [book, lessons, ledger, guidance, guidanceMeta] = await Promise.all([
    rGet('terminal:book'), rGet('terminal:lessons'), rGet('terminal:ledger'),
    rGet('terminal:guidance'), rGet('terminal:guidanceMeta'),
  ]);
  return {
    book: book || { positions: [], pendingAAR: [], vitals: null, vitalsHistory: [] },
    lessons: lessons || [],
    ledger: ledger || [], // ideas offered/taken/passed + completed AARs
    guidance: guidance || [], // standing self-improvement notes from reflection
    guidanceMeta: guidanceMeta || null,
  };
}
function bookView(book) {
  const now = Date.now();
  return {
    ...book,
    positions: (book.positions || []).map((p) => {
      const base = p.ageResetAt || p.openedAt;
      const d = daysHeld(base);
      const isLongTerm = !!p.longTerm || /long/i.test(p.proposedHorizon || '');
      // precise held duration matters for a zero-day desk: hours, not just whole days.
      const hoursHeld = p.openedAt ? Math.max(0, (now - p.openedAt) / 3600e3) : null;
      // is the open time anchored to the platform's own record, or only "since first seen"?
      const openTimeReliable = !!(p.mt5OpenTs || p.openTimeKnown || p.ideaId);
      return {
        ...p,
        daysHeld: daysHeld(p.openedAt), ageDays: d, ageFlag: isLongTerm ? 'OK' : ageFlag(d),
        longTerm: isLongTerm, hoursHeld: hoursHeld != null ? +hoursHeld.toFixed(1) : null,
        openTimeReliable,
      };
    }),
  };
}
// Normalise an outlet name to its publisher FAMILY, so two feeds from the same publisher
// (e.g. "ForexLive" and "ForexLive CB") count as ONE independent source, not two. Used by
// the convergence gate to prevent same-publisher syndication from faking convergence.
function outletFamily(name) {
  if (!name || typeof name !== 'string') return null;
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return null;
  const families = ['forexlive', 'fxstreet', 'actionforex', 'dailyforex', 'myfxbook', 'reuters', 'bloomberg', 'investing', 'wsj', 'cnbc', 'ft', 'marketwatch', 'seekingalpha'];
  for (const f of families) { if (n.includes(f)) return f; }
  return n.slice(0, 12); // fallback: first chunk as its own family
}
// Honest, dynamic list of which news feeds ACTUALLY delivered this run (audit finding 5).
// Reads the health attached to the news array — never claims a dead feed is present.
function liveSourceLine(news) {
  const health = (news && news.health) || [];
  if (!health.length) {
    // no health info: report the distinct outlets that genuinely appear in the items
    const outlets = [...new Set((news || []).map((n) => n.source).filter(Boolean))].slice(0, 12);
    return outlets.length ? outlets.join(', ') : 'Google News aggregate';
  }
  const live = health.filter((h) => h.ok && h.count > 0).map((h) => h.source);
  const down = health.filter((h) => !h.ok || h.count === 0).map((h) => h.source);
  let line = live.length ? live.join(', ') : 'Google News aggregate only';
  if (down.length) line += ` (down/empty this run: ${down.join(', ')})`;
  return line;
}
// Compact but INFORMATIVE digest: each item shows source, how long ago it published (recency
// is critical for a one-day trade), the headline, and a short snippet of the actual reporting
// so the model can tell analysis from a flash and judge context — not just a bare headline
// (audit finding 4). Age is computed from the item's real publish timestamp.
function ageLabel(ts) {
  if (!ts) return '?';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 0) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function digest(items, n = 16) {
  return (items || []).slice(0, n).map((i) => {
    const age = ageLabel(i.ts);
    const snip = (i.desc || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return `- [${i.source} · ${age}] ${i.title}${snip ? `\n    ${snip}` : ''}`;
  }).join('\n');
}
function pasteRow(cells) { return cells.map((c) => (c ?? '')).join('\t'); }

// ---------- Prompts ----------
function deskContext(t, book, lessons, vitals, rates) {
  const bv = bookView(book);
  return `CONTEXT
Now (Bangkok): ${t.dmy} ${t.weekday} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}
Account vitals: ${vitals ? `balance ${vitals.balance}, equity ${vitals.equity}, margin in use ${vitals.margin ?? 'n/a'}, free margin ${vitals.freeMargin ?? 'n/a'}, margin level ${vitals.marginLevel}%` : 'not yet synced'}
Open book: ${bv.positions.length ? bv.positions.map((p) => `${p.pair} ${p.direction} ${p.lots} lots @ ${p.entry}, SL ${p.sl || 'none'}, TP ${p.tp || 'none'}, floating ${p.floating ?? '?'}, held ${p.daysHeld}d [${p.ageFlag}]`).join('; ') : 'FLAT, no open positions'}
Reference rates (ECB daily, ${rates?.asOf || 'n/a'}): ${rates ? Object.entries(rates).filter(([k]) => k !== 'asOf').map(([k, v]) => `${k} ${v}`).join(', ') : 'unavailable'}
Lessons archive (scar tissue, most recent first):
${lessons.slice(-12).reverse().map((l) => `- ${l.text} (${l.date})`).join('\n') || '- none yet'}`;
}

// ---------- Actions ----------

async function actGet() {
  const t = bkk();
  const s = await loadAll();
  const ideas = await rGet(`terminal:ideas:${t.dateKey}`);
  return { clock: t, book: bookView(s.book), lessons: s.lessons, ledger: s.ledger.slice(-60), ideasToday: ideas, guidance: s.guidance, guidanceMeta: s.guidanceMeta };
}

async function actIdeas(force) {
  const t = bkk();
  const key = `terminal:ideas:${t.dateKey}`;
  const cached = await rGet(key);
  // Serve the cached read unless it is stale. An 8-hour freshness window means the
  // desk note and ideas keep pace with the three shifts of the trading day rather than
  // freezing at whatever hour they were first generated. A manual refresh always wins.
  const STALE_MS = 8 * 3600e3;
  const cacheAge = cached && cached.generatedAt ? Date.now() - Date.parse(cached.generatedAt) : Infinity;
  if (cached && !force && cacheAge < STALE_MS) return { clock: t, ideas: cached, cached: true, cacheAgeMs: cacheAge };
  if (t.isWeekend && !force) return { clock: t, weekend: true, ideas: cached || null };

  const s = await loadAll();
  // major pairs to pull real per-symbol pattern setups for (TradingView trader ideas).
  // This gives the desk genuine technical/pattern context, not just news headlines.
  // TradingView pattern feeds: kept to the liquid majors + DXY to control request volume.
  const PATTERN_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD', 'DXY'];
  // LIVE-PRICE coverage is WIDER (audit finding 4): the prompt surveys crosses too, so they
  // must get live prices + ATR, not just the daily ECB fallback. These are batched Yahoo calls,
  // all verified fetchable, so covering them doesn't balloon the pattern-feed request count.
  const PRICE_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD', 'DXY',
    'EURGBP', 'EURJPY', 'GBPJPY', 'EURAUD', 'GBPAUD', 'AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY', 'EURCHF', 'GBPCHF', 'AUDCAD', 'AUDNZD'];
  const [news, rates, cal, patternSets] = await Promise.all([
    getNews('forex'), refRates(), getCalendar(),
    Promise.all(PATTERN_PAIRS.map(async (sym) => ({ sym, ideas: await getSymbolIdeas(sym).catch(() => []) }))),
  ]);
  // LIVE prices + volatility across majors AND crosses (audit finding 4/10).
  const live = await livePrices(PRICE_PAIRS, rates);
  // build a compact pattern-desk digest: a few freshest trader setups per pair
  const patternDigest = patternSets
    .filter((p) => p.ideas.length)
    .map((p) => `${p.sym}: ${p.ideas.slice(0, 3).map((i) => i.title.trim()).join(' | ')}`)
    .join('\n') || 'no pattern feed available this run';

  // freshness memory: last 7 days of offered/taken ideas, and a banned set of
  // pair+direction combos from the last 3 days plus anything already open
  const recent = s.ledger.filter((r) => r.idea && r.ts > Date.now() - 7 * 86400e3);
  const historyLines = recent.map((r) => `- ${r.date}: ${r.idea.pair} ${r.idea.direction} (${r.status}${r.aar ? ', ' + r.aar.bucket : ''})`).join('\n') || '- none';
  const banned = new Set(recent.filter((r) => r.ts > Date.now() - 3 * 86400e3 && r.dateKey !== t.dateKey)
    .map((r) => normPair(r.idea.pair) + '|' + r.idea.direction));
  const openPairs = s.book.positions.map((p) => normPair(p.pair));

  // Shadow book tracking: resolve passed ideas across a proper 3-day window.
  // Each generation we append today's reference price to the idea's trail, then check
  // whether the TP or SL level was reached by any daily mark within the window.
  // Honest limitation: daily closes only, so a verdict is a well-founded estimate,
  // not a tick-perfect certainty. Labelled as such.
  const graded = [];
  const WINDOW_MS = 3 * 86400e3;
  for (const rec of s.ledger) {
    if (rec.status !== 'passed' || rec.shadowResolved) continue;
    const px = refFor(rec.idea.pair, rates);
    if (px == null) continue;
    const entry = num(rec.idea.entry_zone);
    const tp = num(rec.idea.tp);
    const sl = num(rec.idea.sl);
    const dir = (rec.idea.direction || '').toUpperCase();
    if (entry == null || tp == null || sl == null) { rec.shadowResolved = true; rec.shadowVerdict = { grade: 'UNGRADEABLE', note: 'idea lacked clean levels' }; continue; }

    // append today's mark to the trail (once per day)
    rec.shadowTrail = rec.shadowTrail || [];
    if (!rec.shadowTrail.some((m) => m.date === t.dmy)) rec.shadowTrail.push({ date: t.dmy, px, ts: Date.now() });

    // did any mark in the trail reach TP or SL?
    const hitTP = rec.shadowTrail.some((m) => dir === 'BUY' ? m.px >= tp : m.px <= tp);
    const hitSL = rec.shadowTrail.some((m) => dir === 'BUY' ? m.px <= sl : m.px >= sl);
    const windowClosed = Date.now() - rec.ts > WINDOW_MS;

    if (hitTP && !hitSL) { rec.shadowResolved = true; rec.shadowVerdict = { grade: 'WIN', note: 'reached target within window (daily closes)', resolvedOn: t.dmy }; }
    else if (hitSL && !hitTP) { rec.shadowResolved = true; rec.shadowVerdict = { grade: 'LOSS', note: 'hit stop within window (daily closes)', resolvedOn: t.dmy }; }
    else if (hitTP && hitSL) { rec.shadowResolved = true; rec.shadowVerdict = { grade: 'AMBIGUOUS', note: 'both levels touched on daily closes; true order unknown', resolvedOn: t.dmy }; }
    else if (windowClosed) {
      // neither hit in 3 days: judge by final direction vs entry, marked as a soft call
      const moved = dir === 'BUY' ? px > entry : px < entry;
      rec.shadowResolved = true;
      rec.shadowVerdict = { grade: moved ? 'SOFT_WIN' : 'SOFT_LOSS', note: 'neither level reached in 3d; graded on final drift', resolvedOn: t.dmy };
    }
    // else: still open, leave unresolved for next generation

    if (rec.shadowVerdict) graded.push(`${rec.idea.pair} ${rec.idea.direction} (passed ${rec.date}): ${rec.shadowVerdict.grade}`);
    // keep legacy field populated for any older UI expectations
    if (rec.shadowVerdict && !rec.passedEval) {
      const g = rec.shadowVerdict.grade;
      rec.passedEval = { grade: g === 'WIN' || g === 'SOFT_WIN' ? 'WOULD_BE_GREEN' : g === 'LOSS' || g === 'SOFT_LOSS' ? 'WOULD_BE_RED' : 'WOULD_BE_FLAT', note: rec.shadowVerdict.note };
    }
  }

  const recentAAR = s.ledger.filter((r) => r.aar).slice(-6)
    .map((r) => `${r.idea?.pair || r.close?.pair} ${r.aar.bucket}: ${r.aar.headline}`).join('\n');

  // Prefer the LIVE prices + volatility; fall back to the daily-rate string only if live is empty.
  const priceBlock = Object.keys(live).length
    ? formatPrices(live)
    : (rates
        ? Object.entries(rates).filter(([k]) => k !== 'asOf' && rates[k] != null).map(([k, v]) => `${k} ${v} (⚠ daily ref, not live)`).join(', ')
        : 'live prices unavailable, be conservative');

  // session awareness: the desk is used both at the 21:20 night session and in the
  // The desk is used at any hour, so read the actual clock and tailor the brief to the
  // three genuine phases of the global forex day rather than a rigid morning/night split.
  const phase = t.hour >= 5 && t.hour < 11 ? 'morning'
    : t.hour >= 11 && t.hour < 17 ? 'day'
    : 'evening';
  const clockStr = `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} BKK`;
  const sessionBrief =
    phase === 'morning'
      ? `MORNING (${clockStr}). The active markets now are the Asian session (Tokyo, Sydney, Singapore) rolling into the European open. Do NOT default to US-session dollar pairs whose catalysts have already passed overnight. Hunt where the liquidity and news flow actually are right now: JPY crosses, AUD and NZD (RBA/RBNZ, Chinese data, commodities), EUR and GBP as Europe wakes. Build a one-day trade around today's Asian/European catalysts, not last night's New York move.`
      : phase === 'day'
      ? `DAYTIME (${clockStr}). The European session is in full flow, London liquidity is deep, and the US pre-market is stirring. Hunt EUR, GBP, CHF and the European crosses where the action genuinely is, and mind any US data due in the coming hours that could reprice the dollar. Build the trade around what is live now, not a stale overnight story.`
      : `EVENING (${clockStr}), around the London/New York overlap, the most liquid and directional window of the day. US data has typically settled by now; trade the genuine trend of the session and mind late US releases that could still move things.`;

  const prompt = `You are the ideas engine of THE TERMINAL, the forex desk of a retail trader in Phuket (broker: Phillip MT5). He trades at any hour he chooses, morning, day or evening, whenever opportunity calls. Typical sizing 0.02-0.10 lots. Account is small; capital preservation beats bravado.

${sessionBrief}

${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}

LIVE REFERENCE PRICES + VOLATILITY (anchor EVERY level to these; entries must sit within ~0.5% of the LIVE price, not at invented round numbers. Where a pair shows a daily ATR, size the stop RELATIVE to it — a one-day stop is typically ~0.6-1.2x the daily ATR: tighter than ATR gets stopped by normal noise, much wider than ATR risks too much. Do NOT use a hardcoded pip count when a real ATR is shown):
${priceBlock}

Recent AAR verdicts:
${recentAAR || '- none yet'}
Passed-idea shadow grades (his filter vs the engine):
${graded.join('\n') || '- none new'}

SELF-IMPROVEMENT GUIDANCE (distilled from the desk's own tracked track record; APPLY these):
${(s.guidance || []).map((g) => `- ${g.text}${g.basis ? ' [' + g.basis + ']' : ''}`).join('\n') || '- none yet; not enough resolved history to draw conclusions'}

IDEA HISTORY, last 7 days (for freshness, not repetition):
${historyLines}

ECONOMIC CALENDAR, next 48h, High/Medium impact, Bangkok times (validated Forex Factory data):
${calLines(cal)}

Tonight's forex news wire (sources that actually delivered this run — ${liveSourceLine(news)}):
${digest(news, 30)}

PATTERN DESK — real trader setups from TradingView, per pair (technical/chart-pattern context to weigh ALONGSIDE the news; these are crowd ideas, not gospel, but they show where technical attention sits):
${patternDigest}

TASK: Propose exactly 2 short-term ideas built as ONE-DAY positions: opened tonight, targeted to close within ~24h, 48h absolute ceiling.

TRAWL HARD, NEVER SHRUG (critical): Your job is to find the two best genuine opportunities anywhere on the board, and you must always work hard to find them. Before concluding anything, survey the FULL universe of liquid pairs, not just the obvious dollar majors: the majors (EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, NZDUSD, USDCAD) AND the liquid crosses (EURGBP, EURJPY, GBPJPY, EURAUD, AUDJPY, NZDJPY, AUDNZD, CADJPY, CHFJPY, EURCHF, GBPCHF, AUDCAD). Read the whole news wire below, weigh the calendar, consider each session's active markets, and hunt for where genuine opportunity actually is tonight. Rotate your hunting ground across sessions; do not keep returning to the same two pairs. Laziness is not permitted: "nothing to do" is only acceptable AFTER a real search of the whole board, never as a first resort. There is almost always a reasonable setup somewhere in a universe this large.

HONESTY STILL HOLDS: trawling hard means finding the best genuine setups, NOT inflating their conviction. Always surface your two best finds, but rate each one's conviction truthfully (see the conviction rule below). Working hard and rating honestly are both required: relentless effort, honest grading. Rules:

SIZING DOCTRINE (aggressive, margin-bounded):
- These are one-day trades, so size them as AGGRESSIVELY as the margin arithmetic honestly allows. Do not default to timid clips when headroom is generous; equally, never let bravado outrun the maths.
- Account leverage is approximately 1:20 (observed live: 0.10 lots EURUSD consumes ~$570 of margin; scale by notional for other pairs and lot sizes).
- For EACH idea, compute the projected margin level if taken = equity / (current margin in use + estimated new margin) x 100. HARD FLOOR: projected margin level must stay above 150%. Prefer above 200% if BOTH ideas were taken together. State the projected figure explicitly in sizing_note.
- Account for ACTIVE trades: margin already committed and correlation with open pairs both shrink the honest maximum. If the book is already heavy, say so plainly and size down; aggression means maximum JUSTIFIED size, not reckless size.
- FRESHNESS IS MANDATORY: do NOT propose any pair+direction combo from the idea history above that appeared in the last 3 days, unless a specific NEW named catalyst justifies it (name it explicitly in the thesis). Rotate the hunting ground; the market has dozens of pairs.
- NEVER propose a pair that is already open in the book: that is adding, not a fresh idea.
- Anchor at least one idea to the calendar above: trade the setup around a specific scheduled event, or explicitly position clear of it, and say which.
- BREVITY, telegram style, zero filler: thesis max 40 words; risks max 25; sizing_note max 25; correlation_note max 15; desk_note max 50 words naming the session's single priority.
- CONVICTION HONESTY: rate conviction on a four-rung scale, LOW, MED, MED-HIGH, HIGH. Reserve MED-HIGH and HIGH for setups with genuine convergence: a clear catalyst, multiple sources agreeing, and clean levels. Do NOT inflate conviction to seem useful. If the honest read is that nothing tonight clears MED-HIGH, say so in desk_note and mark the ideas at their true lower conviction. A quiet, honest LOW night is more valuable to him than a falsely confident one.
- Never duplicate or heavily correlate with open book exposure; if any correlation exists, state it in correlation_note.
- ${t.isFriday ? 'It is FRIDAY: intraday-only ideas, nothing planned to hold over the weekend gap.' : 'Respect the 48h horizon.'}
- Estimate margin cost at suggested lots and sanity-check against free margin.
- Prefer R:R of at least 1.5. LEVEL DISCIPLINE (critical, every number is validated after you respond): entry_zone must sit within ~0.5% of the live reference price. SL and TP on the correct sides (BUY: SL below entry, TP above; SELL: SL above, TP below). Stop distance must be sane for a one-day trade: roughly 15-70 pips on majors, never tighter than ~8 pips (noise will stop it) nor wider than ~150 pips. Size levels to recent volatility, NOT arbitrary round numbers. Every level must share the pair's order of magnitude (e.g. NZDUSD levels are ~0.56xx, never 1.5xxx). Double-check each number against the live price before finalising.
- Weigh the lessons archive; do not repeat known mistakes.

Respond ONLY with JSON, no markdown:
{"ideas":[{"pair":"EUR/USD","direction":"BUY|SELL","entry_zone":"1.1440-1.1455","tp":"1.1520","sl":"1.1400","lots":"0.05","horizon":"one-day (close within 24h)","conviction":"LOW|MED|MED-HIGH|HIGH","thesis":"...","sources":[{"outlet":"the publication name EXACTLY as tagged in the wire above, e.g. ForexLive, FXStreet, ActionForex, Reuters","point":"the specific claim from that outlet that supports this idea"}],"risks":"...","sizing_note":"why THIS lot size: the margin arithmetic, projected margin level if taken, and what capped or freed the size","correlation_note":"..."}],"stand_down":false,"desk_note":"one-paragraph read of the session"}
CONVERGENCE RULE (enforced in code, not just requested): MED-HIGH and HIGH conviction REQUIRE at least TWO sources in the "sources" array from DIFFERENT outlets that both appear in the wire above. An idea that cites fewer than two independent wire outlets will be AUTOMATICALLY DOWNGRADED to at most MED, no matter what conviction you write. So only claim MED-HIGH/HIGH when you can genuinely name two or more different outlets from the wire that converge. Do not invent outlets or cite ones not present above.
Reminder: every price you output is checked against live rates after you respond. An impossible level (wrong magnitude, or SL/TP on the wrong side) will be rejected, so verify each number now.`;

  let ideas = await claude(prompt, 2200);

  // combined gate: reject on duplicate/open exposure OR broken levels, retry once
  const isDupe = (i) => banned.has(normPair(i.pair) + '|' + i.direction) || openPairs.includes(normPair(i.pair));
  const levelCheck = (i) => checkLevels(i, refFor(i.pair, rates, live));
  const isBad = (i) => isDupe(i) || !levelCheck(i).ok;

  if ((ideas.ideas || []).some(isBad)) {
    const dupeList = (ideas.ideas || []).filter(isDupe).map((i) => `${i.pair} ${i.direction} (repeat/open)`);
    const lvlList = (ideas.ideas || []).filter((i) => !isDupe(i) && !levelCheck(i).ok)
      .map((i) => `${i.pair} ${i.direction}: ${levelCheck(i).reason}`);
    try {
      const second = await claude(prompt +
        `\n\nREJECTED, fix and resubmit two clean ideas:\n${dupeList.length ? 'Repeat/open exposure: ' + dupeList.join('; ') + '\n' : ''}${lvlList.length ? 'Broken levels (check against the LIVE REFERENCE PRICES above): ' + lvlList.join('; ') : ''}\nBanned pairs+direction tonight: ${[...banned].map((b) => b.replace('|', ' ')).join(', ') || 'none'}. Open book: ${openPairs.join(', ') || 'none'}.`, 2200);
      if (second.ideas && !second.ideas.some(isBad)) ideas = second;
    } catch { /* fall through to flagging */ }

    // final safety net: nothing broken reaches the screen unflagged
    (ideas.ideas || []).forEach((i) => {
      if (isDupe(i)) i.correlation_note = ((i.correlation_note || '') + ' REPEAT WARNING: overlaps recent or open exposure.').trim();
      const lc = levelCheck(i);
      if (!lc.ok) { i.level_warning = `LEVELS UNVERIFIED: ${lc.reason}. Do not trade these numbers as-is; confirm on your chart first.`; i.conviction = 'LOW'; }
      else { i.rr = lc.rr; i.slPips = lc.slPips; i.tpPips = lc.tpPips; }
    });
  } else {
    (ideas.ideas || []).forEach((i) => { const lc = levelCheck(i); i.rr = lc.rr; i.slPips = lc.slPips; i.tpPips = lc.tpPips; });
  }
  ideas.generatedAt = t.iso;
  ideas.dateKey = t.dateKey;

  // CONVERGENCE GATE (audit findings 1 + 2): "MED-HIGH"/"HIGH" is not taken on trust. We now
  // verify EVIDENCE, not just outlet names. For each cited source, we require a REAL article in
  // tonight's wire that (a) is from that outlet family, AND (b) genuinely concerns the proposed
  // pair — its text mentions the pair or at least one of its two currencies / central banks.
  // Two such articles from DIFFERENT families = genuine convergence. This blocks the previous
  // hole where two unrelated outlets, cited about anything, kept HIGH conviction.
  // HONEST LIMIT: we verify the article is real, from the cited outlet, and on-topic for the
  // pair; we do NOT fully verify it supports the stated DIRECTION (bull vs bear is a nuance no
  // keyword check settles reliably) — that judgement still rests with the model, so we surface
  // the matched headlines for the user rather than claiming directional proof.
  const CCY_TERMS = {
    EUR: ['eur', 'euro', 'ecb', 'lagarde', 'eurozone'], USD: ['usd', 'dollar', 'fed', 'fomc', 'powell', 'warsh'],
    GBP: ['gbp', 'pound', 'sterling', 'boe', 'bailey'], JPY: ['jpy', 'yen', 'boj', 'ueda', 'japan'],
    CHF: ['chf', 'franc', 'snb', 'swiss'], AUD: ['aud', 'aussie', 'rba', 'australia'],
    NZD: ['nzd', 'kiwi', 'rbnz', 'zealand'], CAD: ['cad', 'loonie', 'boc', 'canada'], DXY: ['dxy', 'dollar index'],
  };
  const pairTerms = (pair) => {
    const p = normPair(pair);
    const a = p.slice(0, 3), b = p.slice(3, 6);
    const terms = new Set([p.toLowerCase(), `${a}/${b}`.toLowerCase(), `${a}${b}`.toLowerCase()]);
    for (const t of (CCY_TERMS[a] || [])) terms.add(t);
    for (const t of (CCY_TERMS[b] || [])) terms.add(t);
    return [...terms];
  };
  const articleConcernsPair = (article, pair) => {
    const hay = ((article.title || '') + ' ' + (article.desc || '')).toLowerCase();
    const p = normPair(pair);
    const a = p.slice(0, 3), b = p.slice(3, 6);
    // strongest: the pair itself named. Then: both currencies present. Then: one currency.
    const namesPair = hay.includes(p.toLowerCase()) || hay.includes(`${a}/${b}`.toLowerCase());
    const aHit = (CCY_TERMS[a] || []).some((tm) => hay.includes(tm));
    const bHit = (CCY_TERMS[b] || []).some((tm) => hay.includes(tm));
    if (namesPair || (aHit && bHit)) return 'strong';
    if (aHit || bHit) return 'weak';
    return null;
  };
  const convergenceOf = (i) => {
    const cited = Array.isArray(i.sources) ? i.sources : [];
    const verifiedFamilies = new Set();
    const evidence = [];
    let strongCount = 0;
    for (const s of cited) {
      const fam = outletFamily(s && s.outlet);
      if (!fam || verifiedFamilies.has(fam)) continue;
      // find the BEST real article from this outlet family for the proposed pair
      let best = null, bestStrength = null;
      for (const n of (news || [])) {
        if (outletFamily(n.source) !== fam) continue;
        const str = articleConcernsPair(n, i.pair);
        if (str === 'strong') { best = n; bestStrength = 'strong'; break; }
        if (str === 'weak' && !best) { best = n; bestStrength = 'weak'; }
      }
      if (best) {
        verifiedFamilies.add(fam);
        if (bestStrength === 'strong') strongCount++;
        evidence.push({ outlet: fam, strength: bestStrength, headline: (best.title || '').slice(0, 90), age: ageLabel(best.ts) });
      }
    }
    return { verified: verifiedFamilies, evidence, strongCount };
  };
  const realOutlets = new Set((news || []).map((n) => outletFamily(n.source)).filter(Boolean));
  (ideas.ideas || []).forEach((i) => {
    const { verified, evidence, strongCount } = convergenceOf(i);
    i.verifiedSources = [...verified];
    i.evidence = evidence; // the actual matched headlines, shown to the user
    // genuine convergence = 2+ independent outlets AND at least one STRONG match (pair or both
    // currencies named), so two weak single-currency brushes can't alone mint top conviction.
    const trulyConvergent = verified.size >= 2 && strongCount >= 1;
    i.sourceConvergence = trulyConvergent ? 'CONVERGENT' : verified.size >= 1 ? 'SINGLE/WEAK' : 'UNSOURCED';
    if (['MED-HIGH', 'HIGH'].includes((i.conviction || '').toUpperCase()) && !trulyConvergent) {
      i.convictionClaimed = i.conviction;
      i.conviction = 'MED';
      i.conviction_note = `Auto-capped to MED: claimed ${i.convictionClaimed}, but verified evidence is thin (${verified.size} outlet(s), ${strongCount} strong match on this pair). Top conviction needs 2+ independent outlets with at least one solidly on this pair.`;
    }
  });

  // conviction gating: mark which ideas clear the MED-HIGH bar. Full set is kept for
  // the record and the shadow book; the frontend shows only the qualifying ones.
  const clears = (c) => ['MED-HIGH', 'HIGH'].includes((c || '').toUpperCase());
  (ideas.ideas || []).forEach((i) => { i.qualifies = clears(i.conviction) && !i.level_warning; });
  ideas.qualifyingCount = (ideas.ideas || []).filter((i) => i.qualifies).length;
  ideas.session = phase;
  await rSet(key, ideas);

  // log offered ideas into ledger (replacing any same-day offers not yet acted on,
  // so a force-regenerate never double-counts the shadow book)
  s.ledger = s.ledger.filter((r) => !(r.status === 'offered' && r.dateKey === t.dateKey));
  for (const idea of ideas.ideas || []) {
    s.ledger.push({ id: `idea_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), date: t.dmy, dateKey: t.dateKey, status: 'offered', idea });
  }
  await rSet('terminal:ledger', s.ledger.slice(-400));

  // Market lesson distillation: once per day, ask the desk to reflect on the news
  // flow and bank at most ONE durable, transferable principle, if genuinely present.
  // This lets the desk learn from the wider market, not only from its own scars.
  try {
    const lastMarketLesson = s.lessons.filter((l) => l.source === 'market').slice(-1)[0];
    const alreadyToday = lastMarketLesson && lastMarketLesson.date === t.dmy;
    if (!alreadyToday) {
      const priorMarket = s.lessons.filter((l) => l.source === 'market').slice(-10).map((l) => `- ${l.text}`).join('\n') || '- none yet';
      const reflection = await claude(`You are THE TERMINAL's market historian. Read today's forex news flow and decide whether it contains ONE genuinely transferable trading lesson: a durable principle a disciplined trader could carry forward, not a fleeting headline or a price factoid.

Good lessons are principles: e.g. "crowded consensus trades unwind violently when a central banker leans against them" or "thin holiday liquidity exaggerates moves, so size down around holidays". Bad lessons are ephemera: e.g. "EURUSD rose 0.2% on Tuesday".

Market lessons ALREADY banked (do NOT repeat these or minor variants):
${priorMarket}

Today's news wire:
${digest(news, 18)}

If, and only if, there is a genuinely instructive and non-duplicate principle today, return it. If the news is routine and teaches nothing durable, return NONE. Honesty over noise: most days should return NONE.
JSON only: {"lesson":"one durable transferable principle, max 25 words, OR the literal word NONE","trigger":"the news that prompted it, max 12 words"}`, 700);
      if (reflection && reflection.lesson && reflection.lesson.toUpperCase() !== 'NONE') {
        s.lessons.push({ text: reflection.lesson, date: t.dmy, source: 'market', trigger: reflection.trigger || null });
        s.lessons = s.lessons.slice(-60);
        await rSet('terminal:lessons', s.lessons);
      }
    }
  } catch { /* market lesson is a bonus; never let it break idea generation */ }

  // Self-improvement reflection: once per day, study the resolved shadow scorecard and
  // refresh the standing guidance that shapes future ideas. Fail-safe like the market lesson.
  try {
    const alreadyReflectedToday = s.guidanceMeta && s.guidanceMeta.at && s.guidanceMeta.at.slice(0, 10) === t.iso.slice(0, 10);
    if (!alreadyReflectedToday) await reflectAndLearn(s, t);
  } catch { /* reflection is a bonus; never let it break idea generation */ }

  return { clock: t, ideas, cached: false };
}

// Vision parse of an MT5 screenshot
async function parseShot(image, kind) {
  const spec = {
    positions: `Extract ALL open positions AND the account vitals from this MT5 screenshot.
JSON: {"positions":[{"ticket":"12743484","pair":"EURAUD","direction":"BUY|SELL","lots":0.1,"entry":1.63669,"current":1.6450,"sl":1.62,"tp":1.6289,"floating":16.23,"openTime":"2026.07.20 03:38"}],"vitals":{"balance":0,"equity":0,"margin":0,"freeMargin":0,"marginLevel":0}}
TICKET ID (read it when present): MT5's desktop position view usually has a "Ticket" column — a long number like 12743484 unique to each trade. Read it into "ticket" EXACTLY as shown. The mobile app often HIDES this column; if there is no ticket column visible for a row, set "ticket" to null — do NOT invent or guess one. When present it is the most reliable identity of a trade.
CRITICAL — READ THE PAIR EXACTLY: read all SIX letters of each symbol carefully. Do NOT confuse similar currency codes — AUD vs USD, CHF vs CAD, NZD vs NOK. A common error is misreading EURAUD as EURUSD. SANITY-CHECK EACH PAIR AGAINST ITS ENTRY PRICE: the entry must be plausible for the pair. Rough live ranges: EURUSD ~1.0-1.2, EURAUD ~1.5-1.7, EURCHF ~0.9-1.0, USDCHF ~0.8-0.95, GBPUSD ~1.2-1.4, USDJPY ~140-165, AUDUSD ~0.6-0.7. If your read of the pair makes the entry price implausible (e.g. "EURUSD" at 1.63 — impossible, EURUSD never trades there; that is EURAUD), you have MISREAD the pair — re-read it and correct it. The price is usually right; fix the pair to match it.
OPEN TIME (important): MT5 usually shows each position's OPEN TIME/date (often in a "Time" column, format like "2026.07.20 03:38"). Read it into openTime EXACTLY as shown if visible. If no open time is visible for a row, set openTime to null — do NOT guess it.
CRITICAL — SIGN OF FLOATING P/L: MT5 shows profit and loss BY COLOUR. A figure shown in GREEN (or blue/positive tint) is a PROFIT and MUST be a POSITIVE number; a figure shown in RED is a LOSS and MUST be a NEGATIVE number. Read the colour carefully and set the sign accordingly; never drop or invert it. Cross-check: for a BUY, if current price is above entry the floating is usually positive (below entry, negative); for a SELL it is the reverse. When colour and this cross-check disagree, trust the colour but read carefully.
If a field is not visible use null. marginLevel as a number (percent). Numbers as numbers, not strings.`,
    history: `Extract ALL closed deals visible in this MT5 history screenshot.
JSON: {"closes":[{"ticket":"12743484","pair":"EURUSD","direction":"BUY|SELL","lots":0.1,"entry":1.14388,"exit":1.15,"profit":24.2,"closeTime":"2026.07.02 19:41"}]}
TICKET: if a ticket/order number column is visible, read it into "ticket" (helps match a closure to the exact open position); else null.
CRITICAL — SIGN OF PROFIT: GREEN/positive means a POSITIVE profit, RED means a NEGATIVE loss. Preserve the sign faithfully; never invert it.`,
    fill: `Extract the single confirmed position (the newest/most relevant) plus account vitals if visible from this MT5 screenshot.
JSON: {"fill":{"pair":"EURUSD","direction":"BUY|SELL","lots":0.1,"entry":1.14388,"sl":1.116,"tp":1.18},"vitals":{"balance":null,"equity":null,"freeMargin":null,"marginLevel":null}}`,
  }[kind];

  return claude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
    { type: 'text', text: `${spec}\nRespond ONLY with JSON, no markdown, no commentary.` },
  ], 1600);
}

// Recognise whether two position records are the SAME live trade. Forex positions are
// identified by pair + direction, with lots as a strong confirmer. Entry price is used
// only as a TIE-BREAKER when there are genuinely multiple same-pair/same-direction trades,
// because the vision model can read an entry with slight imprecision between syncs and we
// must NOT let a one-digit misread flush a held position to closures and re-adopt it as a
// thesis-less orphan. tolerant=true widens the entry tolerance for the reconcile step.
function samePos(a, b, tolerant) {
  // GOLD STANDARD (audit finding 9): if BOTH sides carry a real MT5 ticket, the ticket is the
  // unambiguous identity of the trade. Equal tickets = same trade, full stop. Different tickets
  // = different trades, even if pair/direction/lots/entry all match (this is exactly the case
  // Kepler flagged: two EURUSD buys at 1.1438 and 1.1445 are now correctly kept distinct).
  const ta = ticketId(a), tb = ticketId(b);
  if (ta && tb) return ta === tb;
  // FALLBACK (ticket missing on one/both — e.g. a mobile screenshot that hid the column):
  // identify by pair + direction + lots, with entry as a tie-breaker. Resilient, never breaks
  // when the ticket isn't in the shot.
  if (normPair(a.pair) !== normPair(b.pair)) return false;
  if ((a.direction || '').toUpperCase() !== (b.direction || '').toUpperCase()) return false;
  // lots should match closely; a real position keeps its size
  const lotsClose = Math.abs((a.lots || 0) - (b.lots || 0)) < 0.011; // allow tiny read wobble
  if (!lotsClose) return false;
  // entry: within 0.2% is a confident same-trade; when tolerant (reconcile), accept up to
  // ~1.5% so an imprecise re-read of the entry never breaks the match. Same pair+direction
  // +lots is already a very strong identity for a live book.
  const ea = num(a.entry), eb = num(b.entry);
  if (ea == null || eb == null || ea === 0) return true; // can't compare entries -> trust the rest
  const drift = Math.abs(ea - eb) / ea;
  return drift < (tolerant ? 0.015 : 0.002);
}
// normalise a ticket to a clean digit string, or null if absent/implausible
function ticketId(p) {
  const raw = p && (p.ticket ?? p.ticketId);
  if (raw == null) return null;
  const s = String(raw).replace(/[^0-9]/g, '');
  return s.length >= 6 ? s : null; // MT5 tickets are long; ignore stray short numbers
}

// Parse an MT5 open-time string like "2026.07.08 21:14" (or with seconds) into a timestamp.
// Returns null if unparseable, so we never fabricate a held duration from a bad read.
function parseMT5Time(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/(\d{4})[.\-/](\d{2})[.\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  // reject impossible field values up front (Date.UTC would silently roll them over,
  // e.g. month 13 / day 45 -> a valid future date). Only accept genuine calendar values.
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || (se || 0) > 59) return null;
  const ts = Date.UTC(y, mo - 1, d, h, mi, se || 0);
  if (!Number.isFinite(ts)) return null;
  // verify no rollover happened (e.g. Feb 30 -> Mar 2): the reconstructed date must match.
  const dt = new Date(ts);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return ts;
}


// PAIR-PLAUSIBILITY GUARD: the vision parser can misread a currency code (classically
// EURAUD read as EURUSD). We use GENEROUS ranges (wide enough that a real price near a
// pair's normal band is never wrongly condemned) and, per audit, we DO NOT silently rewrite
// a position — a wrong "correction" is as dangerous as a wrong read. We FLAG the mismatch
// for the user to confirm, and only auto-correct in the single unambiguous misread case:
// the base currency matches and EXACTLY ONE other pair fits, AND the gap is large (a true
// impossibility, not an edge-of-band rounding). Even then we flag it loudly.
//
// THESE BANDS GO STALE, AND A STALE BAND IS A FALSE ALARM ON A REAL POSITION. Eight were
// re-centred on 22/07/2026 against ECB daily rates (the same frankfurter.dev feed refRates()
// uses as its fallback layer, dated 21/07/2026), because four had been overtaken by the
// market outright — GBPJPY spot 218.08 against a 215 ceiling, EURJPY 185.82 against 185,
// CHFJPY 200.69 against 195, AUDNZD 1.2001 against 1.18 — and four more sat within ~6% of
// theirs. A guard that fires on the real book teaches the user to click past it, which is
// how the EURAUD misread this whole mechanism exists to catch gets waved through.
//
// Each re-centred band is spot ±15%, which is the headroom the untouched bands already
// carried. When you next touch this table, re-derive from live rates rather than nudging
// the edge that happened to trip — nudging is what left four of them breached at once.
const PAIR_RANGES = {
  EURUSD: [0.95, 1.30], EURAUD: [1.40, 1.80], EURCHF: [0.85, 1.05], EURGBP: [0.78, 0.95],
  EURJPY: [158, 214], USDCHF: [0.75, 1.00], USDJPY: [138, 187], USDCAD: [1.25, 1.52],
  GBPUSD: [1.15, 1.45], AUDUSD: [0.55, 0.75], NZDUSD: [0.52, 0.70], AUDJPY: [97, 131],
  NZDJPY: [78, 104], CADJPY: [96, 126], GBPJPY: [185, 251], CHFJPY: [170, 231],
  AUDNZD: [1.02, 1.38], EURNZD: [1.66, 2.25], GBPAUD: [1.80, 2.10], AUDCAD: [0.84, 1.14],
};
const plausible = (pair, px) => { const r = PAIR_RANGES[normPair(pair)]; return !r || (px >= r[0] && px <= r[1]); };

// Run the guard across a parsed book. MUTATES `positions` — an auto-correction rewrites
// pos.pair, a flag sets pos.pairSuspect — and returns the list of what it did.
//
// Every entry carries `auto`, and the distinction is the whole point: auto:true means the
// pair WAS changed, auto:false means it was NOT and the user must check it. They are
// different claims and the UI must not merge them into one "corrected N pairs" count.
//
// Lives at module scope, not inline in actSync, so the safety suite can exercise the
// SHIPPED logic — including the flag-only branch — instead of a hand-copied duplicate.
function pairGuard(positions) {
  const fixes = [];
  for (const pos of positions || []) {
    const px = num(pos.entry);
    if (px == null) continue;
    if (plausible(pos.pair, px)) continue;
    const base = normPair(pos.pair).slice(0, 3);
    const candidates = Object.keys(PAIR_RANGES).filter((k) => px >= PAIR_RANGES[k][0] && px <= PAIR_RANGES[k][1]);
    const sameBase = candidates.filter((k) => k.startsWith(base));
    // Auto-correct ONLY the unambiguous classic misread: same base currency, exactly one
    // candidate, and the read pair is genuinely far outside its band (not a rounding edge).
    const r = PAIR_RANGES[normPair(pos.pair)];
    const farOutside = r ? (px < r[0] * 0.9 || px > r[1] * 1.1) : true;
    if (sameBase.length === 1 && farOutside) {
      fixes.push({ was: pos.pair, now: sameBase[0], entry: px, auto: true, note: `${pos.pair} entry ${px} is far outside its range and matches ${sameBase[0]} exactly (same base currency) — auto-corrected as a likely screenshot misread. VERIFY on your platform.` });
      pos.pair = sameBase[0];
    } else {
      // ambiguous or edge case: FLAG, never mutate. Let the user confirm.
      pos.pairSuspect = true;
      fixes.push({ was: pos.pair, now: null, entry: px, auto: false, note: `${pos.pair} entry ${px} looks unusual for ${pos.pair}${candidates.length ? ` (fits ${candidates.join('/')})` : ''}. NOT changed — verify the pair on your platform; the desk will hold judgement on it.` });
    }
  }
  return fixes;
}

// Morning sync: positions shot (+ optional history shot) -> reconcile
async function actSync(positionsImgs, historyImg) {
  const t = bkk();
  const s = await loadAll();
  // accept either a single image (back-compat) or an array (mobile: several partial
  // screenshots covering the whole book). Parse each and merge positions, using samePos
  // to drop true duplicates that appear at the overlapping edges of scrolled screenshots
  // while preserving genuinely distinct positions (e.g. two EURUSD buys at different entries).
  const imgs = Array.isArray(positionsImgs) ? positionsImgs.filter(Boolean) : (positionsImgs ? [positionsImgs] : []);
  let mergedPositions = [];
  let vitalsSeen = null;
  for (const img of imgs) {
    const parsed = await parseShot(img, 'positions');
    for (const p of (parsed.positions || [])) {
      if (!mergedPositions.some((x) => samePos(x, p))) mergedPositions.push(p);
    }
    // the account/vitals bar may appear in only one shot; capture it where present
    if (parsed.vitals && Object.values(parsed.vitals).some((v) => v != null)) vitalsSeen = parsed.vitals;
  }
  const posParse = { positions: mergedPositions, vitals: vitalsSeen };
  const histParse = historyImg ? await parseShot(historyImg, 'history') : { closes: [] };

  const seen = posParse.positions || [];
  const report = { closedDetected: [], orphansAdded: [], updated: 0, agingFlags: [], vitalsAlert: null, shotsRead: imgs.length, signFlags: [], pairFixes: [] };

  // SAFETY (audit finding 2): an empty parse must NOT wipe a non-empty book. If the vision
  // parse returned zero positions but we currently HOLD positions, that is almost certainly a
  // failed/partial read (blurry shot, wrong screen, model hiccup), not a genuine "everything
  // closed" event. Refuse the sync and tell the user, rather than silently marking every real
  // position closed. A genuinely flat account is confirmed by the user via an explicit action,
  // not inferred from an empty read.
  if (seen.length === 0 && (s.book.positions || []).length > 0) {
    return {
      clock: t, aborted: true,
      // aborted ALSO goes inside report, because the front end keeps only r.report and checks
      // report.aborted (audit finding 8 — a top-level-only flag rendered as success).
      report: { ...report, aborted: true, note: 'Sync aborted: the screenshot(s) showed no readable positions, but your book currently holds ' + s.book.positions.length + '. This is treated as a failed read, not a cleared book — nothing was changed. Re-upload a clear open-positions screenshot.' },
      book: bookView(s.book),
    };
  }

  // PAIR-PLAUSIBILITY GUARD (see pairGuard / PAIR_RANGES above). Auto-corrections and
  // flag-only entries both land in report.pairFixes, each tagged with `auto` so the UI can
  // keep "we changed this" separate from "please check this".
  report.pairFixes.push(...pairGuard(seen));

  // Sign sanity check for floating P/L: for a BUY, price above entry should mean a POSITIVE
  // float (below entry, negative); for a SELL the reverse. A clear contradiction likely means
  // a misread colour/sign on the screenshot, so we correct it and report it transparently.
  const floatSignWrong = (pos, screen) => {
    const dir = (screen.direction || pos.direction || '').toUpperCase();
    const entry = num(screen.entry ?? pos.entry);
    const cur = num(screen.current);
    const fl = num(screen.floating);
    if (dir !== 'BUY' && dir !== 'SELL') return false;
    if (entry == null || cur == null || fl == null || entry === 0) return false;
    if (Math.abs(fl) < 0.01) return false;
    const move = Math.abs(cur - entry) / entry;
    if (move < 0.0005) return false; // price basically at entry: sign is noise, don't touch
    const inProfit = dir === 'BUY' ? cur > entry : cur < entry;
    return (inProfit && fl < 0) || (!inProfit && fl > 0);
  };

  // 1) positions in book but missing on screen -> closed; match against history.
  // Use TOLERANT matching: a held position must be recognised as itself even if the entry
  // price was re-read slightly differently, so we never flush a live trade to closures.
  // Track which seen rows have been consumed, so ONE screen row can't satisfy TWO different
  // book positions (audit finding 6). Once a row matches a position it's removed from the pool.
  const seenPool = [...seen];
  const consumeMatch = (p) => {
    const idx = seenPool.findIndex((x) => samePos(p, x, true));
    if (idx === -1) return null;
    return seenPool.splice(idx, 1)[0]; // remove and return, so it can't match again
  };
  // PARTIAL-SCREENSHOT GUARD (audit finding 6): a shot showing only SOME of the book (e.g. 1 of
  // 3 rows) would otherwise mark the unseen positions closed. A closure is only trustworthy when
  // EITHER a history screenshot confirms it, OR the parse plausibly covered the whole book. If
  // the parse saw fewer rows than the book holds AND no history was provided, we DEFER the
  // unconfirmed closures (hold the positions, flag for review) rather than closing them blind.
  const partialShot = seen.length < (s.book.positions || []).length && (histParse.closes || []).length === 0;
  const still = [];
  const deferredClosures = [];
  for (const p of s.book.positions) {
    const onScreen = consumeMatch(p);
    if (onScreen) {
      let fl = onScreen.floating ?? p.floating;
      // The parser reads the P/L sign from COLOUR (green=profit, red=loss), which is MT5's
      // ground truth. If the price relationship seems to disagree, we do NOT silently flip the
      // number — a wrong flip would turn a real profit into a displayed loss and could make a
      // healthy position look BROKEN. Instead we FLAG the discrepancy for the user to eyeball,
      // and KEEP the colour-read value. (A missing current price never triggers this.)
      if (onScreen.floating != null && floatSignWrong(p, onScreen)) {
        report.signFlags.push({ pair: p.pair, was: onScreen.floating, note: `${p.pair}: shown P/L ${onScreen.floating} but ${onScreen.direction || p.direction} with price ${num(onScreen.current) > num(onScreen.entry ?? p.entry) ? 'above' : 'below'} entry would usually be the opposite sign. Kept the value MT5's colour showed — double-check this one on your platform.` });
      }
      p.floating = fl;
      p.sl = onScreen.sl ?? p.sl; p.tp = onScreen.tp ?? p.tp;
      const screenTs = parseMT5Time(onScreen.openTime);
      if (screenTs != null) {
        p.mt5OpenTs = screenTs;
        p.openTime = onScreen.openTime;
        p.openedAt = screenTs; // anchor held-duration to the platform truth
      }
      report.updated++;
      still.push(p);
    } else {
      const match = (histParse.closes || []).find((c) => samePos(c, p));
      if (!match && partialShot) {
        // unconfirmed closure on a partial screenshot — DEFER, don't close. Keep the position.
        deferredClosures.push(p.pair);
        still.push(p);
        continue;
      }
      const closure = {
        id: `close_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        position: p,
        close: match || null,
        detectedAt: t.iso,
        needsHistory: !match,
      };
      s.book.pendingAAR = [...(s.book.pendingAAR || []), closure];
      report.closedDetected.push(closure);
    }
  }
  if (deferredClosures.length) {
    report.partialShotNote = `Only ${seen.length} position(s) were readable but your book holds ${s.book.positions.length}, and no closing history was provided. To avoid a false close from a partial screenshot, these were KEPT and not marked closed: ${deferredClosures.join(', ')}. Re-sync a full positions screenshot (or add a history shot) to confirm any genuine closures.`;
  }
  // 2) on screen but not matched to any book position -> genuine off-book orphan, adopt it.
  // We iterate the LEFTOVER pool (rows not consumed by any position above), so a row already
  // matched to a held position can never also be adopted as an orphan (audit finding 6).
  for (const x of seenPool) {
    {
      // anchor the open time to the platform's own record if the screenshot showed it;
      // otherwise fall back to now, but flag that the held duration is only "since first seen".
      const screenTs = parseMT5Time(x.openTime);
      // THESIS RECOVERY: before calling this off-book, see if it matches a recently TAKEN
      // idea in the ledger (same pair+direction, entry close). If so, this is a filled desk
      // idea that lost its book link — reconnect its thesis rather than stamping "no thesis".
      const takenMatch = (s.ledger || []).filter((r) => r.status === 'taken' && r.idea).find((r) => {
        const ri = r.fill || r.idea;
        if (normPair(ri.pair || r.idea.pair) !== normPair(x.pair)) return false;
        if ((r.idea.direction || '').toUpperCase() !== (x.direction || '').toUpperCase()) return false;
        const re = num(r.fill && r.fill.entry) ?? num(r.idea.entry_zone);
        if (re == null || !x.entry) return true; // pair+direction match is enough to reconnect
        return Math.abs(re - num(x.entry)) / re < 0.02;
      });
      const orphan = {
        id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ...x, pair: x.pair.replace('/', ''),
        openedAt: screenTs != null ? screenTs : Date.now(),
        mt5OpenTs: screenTs != null ? screenTs : null,
        openTimeKnown: screenTs != null, // true = real platform time; false = since-first-seen
        orphan: !takenMatch,
        ideaId: takenMatch ? takenMatch.id : null,
        thesis: takenMatch ? (takenMatch.idea.thesis || 'Taken desk idea (thesis reconnected).') : 'Off-book entry, no engine thesis on record.',
        proposedHorizon: takenMatch ? (takenMatch.idea.horizon || 'one-day (close within 24h)') : undefined,
        proposedConviction: takenMatch ? (takenMatch.idea.conviction || null) : undefined,
      };
      still.push(orphan);
      report.orphansAdded.push(orphan);
    }
  }
  s.book.positions = still;

  // 3) vitals
  if (posParse.vitals && posParse.vitals.equity) {
    s.book.vitals = { ...posParse.vitals, ts: t.iso };
    s.book.vitalsHistory = [...(s.book.vitalsHistory || []), { ts: t.iso, marginLevel: posParse.vitals.marginLevel, equity: posParse.vitals.equity }].slice(-90);
    const ml = posParse.vitals.marginLevel;
    if (ml && ml < 150) report.vitalsAlert = { level: 'RED', msg: `Margin level ${ml}% — broker stop-out territory approaches. Reduce exposure.` };
    else if (ml && ml < 250) report.vitalsAlert = { level: 'AMBER', msg: `Margin level ${ml}% — thin for correlated positions. Size tonight's ideas down.` };
  }

  // 4) aging ladder
  for (const p of bookView(s.book).positions) {
    if (p.ageFlag !== 'OK') report.agingFlags.push({ id: p.id, pair: p.pair, days: p.ageDays, flag: p.ageFlag });
  }

  await rSet('terminal:book', s.book);

  // 5) morning note from Claude on open lines, with fresh news
  let morningNote = null;
  if (s.book.positions.length || report.closedDetected.length) {
    const [news, rates, cal] = await Promise.all([getNews('forex'), refRates(), getCalendar()]);
    const posDetail = bookView(s.book).positions.map((p) => {
      const ref = refFor(p.pair, rates);
      const hoursOpen = p.hoursHeld;
      const fromDesk = !!p.ideaId;
      const isLongTerm = !!p.longTerm || /long/i.test(p.proposedHorizon || '');
      // held-duration phrasing: hours for young trades, days for older, with a reliability note
      const heldStr = hoursOpen == null ? 'unknown' : hoursOpen < 24 ? `${hoursOpen.toFixed(1)}h` : `${p.ageDays}d`;
      const relNote = p.openTimeReliable ? '' : ' (held-time estimated since first seen, not from platform open time)';
      let tag = '';
      if (isLongTerm) tag = ' [LONG-TERM HOLD: judge on the durable multi-week thesis and higher-timeframe trend, NOT one-day noise; only mark BROKEN on a real structural break].';
      else if (fromDesk && hoursOpen != null && hoursOpen < 20) tag = ` [FRESH DESK-PROPOSED TRADE, opened ${hoursOpen < 1 ? Math.round(hoursOpen * 60) + 'min' : hoursOpen.toFixed(1) + 'h'} ago, well within its ${p.proposedHorizon || 'one-day'} horizon: the desk proposed this itself, so do NOT flip to BROKEN on ordinary intraday noise or a modest adverse move; mark BROKEN only if the specific catalyst it was built on has genuinely reversed or a written invalidation level has actually triggered].`;
      return `${p.pair} ${p.direction} ${p.lots} @ ${p.entry}, now ~${ref ?? '?'}, floating ${p.floating ?? '?'}, held ${heldStr}${relNote}.${tag} ${p.thesis && p.thesis !== 'Off-book entry, no engine thesis on record.' ? 'Thesis on record: ' + p.thesis : 'NO thesis on record (off-book entry): infer the most likely reason a trader took this direction here, then judge it.'}`;
    }).join('\n');

    morningNote = await claude(`You are THE TERMINAL's morning desk analyst. Your most important job is to re-examine every open position against CURRENT conditions and judge, honestly, whether its thesis still holds or whether it is time to think about closing. Do not rubber-stamp; a position being green does not mean the thesis is intact, and a position being red does not mean it is broken.

${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}

OPEN POSITIONS TO RE-EXAMINE (one verdict each):
${posDetail}

Closures detected this sync: ${report.closedDetected.map((c) => `${c.position.pair} ${c.position.direction} ${c.close ? `closed ${c.close.profit >= 0 ? '+' : ''}${c.close.profit}` : 'closed, awaiting history screenshot'}`).join('; ') || 'none'}
TODAY'S ECONOMIC CALENDAR, High/Medium impact, Bangkok times (validated Forex Factory data, do not invent events beyond it):
${calLines(cal)}
Fresh wire (each item source-tagged in [brackets] — sources live this run: ${liveSourceLine(news)}):\n${digest(news, 18)}

For EACH open position, decide a thesis status: HOLDING (original reasoning intact, stay the course), WOBBLING (thesis under strain, watch closely, be ready to act), or BROKEN (the reason for the trade no longer applies, actively consider closing). Ground the verdict in the fresh news, the calendar and the price move since entry. CALIBRATE TO HORIZON: a position tagged FRESH DESK-PROPOSED must not be flipped to BROKEN on ordinary noise minutes after the desk itself proposed it, and a LONG-TERM HOLD must be judged on its durable multi-week thesis, not a one-day wobble. For off-book positions, first infer the likely thesis in one clause, then judge it the same way.

SOURCE VALIDATION (mandatory): each position's status must be validated against the wire above and grounded in CONVERGENCE — cite the SPECIFIC source items behind the call in "sources" as "[Source] point", drawn from MULTIPLE different outlets where the wire allows. Do not fabricate: if the wire is quiet on a pair, say so in the read and keep "sources" honest (even empty) rather than inventing agreement.

Write TIGHT, telegram style. HARD LIMITS: headline max 8 words; each position read max 22 words including the status reason; sources max 2-3 short items each; pick only the 3-4 calendar events that matter, each "what" max 8 words and "why" max 10 words; overall max 30 words naming the single priority.
JSON only: {"headline":"...","lines":[{"pair":"EURUSD","status":"HOLDING|WOBBLING|BROKEN","read":"the reason, grounded in current conditions","sources":["[ForexLive] point","[FXStreet] point"]}],"calendar":[{"when":"Mon 21:00 BKK","what":"USD ISM Services (fc 54.2)","why":"beat = USD bid, hits the long"}],"overall":"..."}`, 1600);
    if (morningNote) {
      s.book.morningNote = { ...morningNote, at: t.iso };
      await rSet('terminal:book', s.book);
    }
  }

  return { clock: t, report, book: bookView(s.book), morningNote };
}

// Fill: confirmed position screenshot after taking an idea
async function actFill(image, ideaLedgerId) {
  const t = bkk();
  const s = await loadAll();
  const parsed = await parseShot(image, 'fill');
  const f = parsed.fill;
  if (!f || !f.pair) throw new Error('Could not read a position from that screenshot.');

  const rec = ideaLedgerId ? s.ledger.find((r) => r.id === ideaLedgerId) : null;
  const pos = {
    id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    pair: f.pair.replace('/', ''), direction: f.direction, lots: f.lots,
    entry: f.entry, sl: f.sl, tp: f.tp, floating: 0,
    openedAt: Date.now(), ideaId: rec?.id || null,
    thesis: rec?.idea?.thesis || null,
    proposedHorizon: rec?.idea?.horizon || 'one-day (close within 24h)',
    proposedConviction: rec?.idea?.conviction || null,
  };
  s.book.positions.push(pos);
  if (parsed.vitals && parsed.vitals.equity) {
    s.book.vitals = { ...parsed.vitals, ts: t.iso };
  }
  let slippage = null;
  if (rec) {
    rec.status = 'taken';
    rec.fill = { ...f, ts: Date.now() };
    const ideaPx = parseFloat(rec.idea.entry_zone);
    if (ideaPx && f.entry) slippage = +(f.entry - ideaPx).toFixed(5);
  }
  await Promise.all([rSet('terminal:book', s.book), rSet('terminal:ledger', s.ledger.slice(-400))]);
  return { clock: t, position: pos, slippage, book: bookView(s.book) };
}

async function actPass(ideaLedgerId) {
  const s = await loadAll();
  const rec = s.ledger.find((r) => r.id === ideaLedgerId);
  if (rec) rec.status = 'passed';
  await rSet('terminal:ledger', s.ledger.slice(-400));
  return { ok: true };
}

// AAR on a detected closure
async function actAAR(closureId, historyImg) {
  const t = bkk();
  const s = await loadAll();
  const c = (s.book.pendingAAR || []).find((x) => x.id === closureId);
  if (!c) throw new Error('Closure not found.');
  if (!c.close && historyImg) {
    const hp = await parseShot(historyImg, 'history');
    // require a CONFIDENT match on this specific position; do NOT fall back to the first
    // closed trade (audit finding 6) — a wrong match corrupts realised P/L, lessons, and the
    // linked idea. If nothing matches, ask for a clearer/correct history screenshot.
    const match = (hp.closes || []).find((x) => samePos(x, c.position, true));
    if (!match) {
      return { needsHistory: true, closureId, noMatch: true, note: `Couldn't find ${c.position.pair} ${c.position.direction} ${c.position.lots} in that history screenshot. Upload one that clearly shows this trade's closing row, or dismiss the closure if it was a false alarm.` };
    }
    c.close = match;
  }
  if (!c.close) return { needsHistory: true, closureId };

  const news = await getNews('forex');
  const held = daysHeld(c.position.openedAt);
  const aar = await claude(`You are THE TERMINAL's AAR officer. A position has closed. Run the after-action review with the poker four-bucket discipline: judge the DECISION QUALITY separately from the OUTCOME.

Original thesis (at entry): ${c.position.thesis || 'none on record (off-book entry)'}
Position: ${c.position.pair} ${c.position.direction} ${c.position.lots} lots @ ${c.position.entry}, SL ${c.position.sl || 'none'}, TP ${c.position.tp || 'none'}
Close: exit ${c.close.exit}, realised ${c.close.profit >= 0 ? '+' : ''}${c.close.profit}, closed ${c.close.closeTime || 'unknown'}, held ${held} day(s)
Lessons already banked:\n${s.lessons.slice(-10).map((l) => `- ${l.text}`).join('\n') || '- none'}
Fresh wire for context:\n${digest(news, 12)}

The four Army AAR questions: what was supposed to happen, what actually happened, why the difference, what do we do next time.
Buckets: GOOD_CALL_WIN, GOOD_CALL_LOSS (variance, change nothing), BAD_CALL_WIN (dangerous, name the flaw), BAD_CALL_LOSS (extract the lesson).
Exit read: did it hit TP, hit SL, or was it a manual close, and was the manual close disciplined or emotional?

JSON only: {"bucket":"...","headline":"one line verdict","supposed":"...","actual":"...","why_different":"...","next_time":"...","exit_read":"...","lesson":"one reusable lesson line, or NONE if genuinely nothing new"}`, 1600);

  // bank the lesson
  if (aar.lesson && aar.lesson !== 'NONE') {
    s.lessons.push({ text: aar.lesson, date: t.dmy, pair: c.position.pair, source: 'personal' });
    s.lessons = s.lessons.slice(-60);
  }
  // paste-ready MT5 Log row: Date Instrument Direction Lots Entry Current/Exit MentalTP MentalSL Floating Status Realised DaysHeld Notes
  const row = pasteRow([
    t.dmy, c.position.pair, c.position.direction === 'BUY' ? 'Buy' : 'Sell', c.position.lots,
    c.position.entry, c.close.exit, c.position.tp || '', c.position.sl || '', '',
    'Closed', c.close.profit, held,
    `AAR ${aar.bucket}: ${aar.headline}`,
  ]);

  // move closure into ledger
  const rec = s.ledger.find((r) => r.id === c.position.ideaId);
  const entry = rec || { id: `trade_${Date.now()}`, ts: Date.now(), date: t.dmy, status: 'taken', idea: { pair: c.position.pair, direction: c.position.direction, thesis: c.position.thesis } };
  entry.close = c.close;
  entry.aar = aar;
  entry.pasteRow = row;
  if (!rec) s.ledger.push(entry);
  s.book.pendingAAR = (s.book.pendingAAR || []).filter((x) => x.id !== closureId);

  await Promise.all([
    rSet('terminal:book', s.book),
    rSet('terminal:lessons', s.lessons),
    rSet('terminal:ledger', s.ledger.slice(-400)),
  ]);
  return { clock: t, aar, pasteRow: row, book: bookView(s.book), lessons: s.lessons };
}

// Dismiss a pending closure without an AAR. If closureId is given, clear just that one;
// if omitted (or 'all'), clear the whole backlog. For sweeping away stale/false closures
// (e.g. churn debris) that will never get a real after-action review.
async function actDismissClosure(closureId) {
  const s = await loadAll();
  const before = (s.book.pendingAAR || []).length;
  if (!closureId || closureId === 'all') {
    s.book.pendingAAR = [];
  } else {
    s.book.pendingAAR = (s.book.pendingAAR || []).filter((x) => x.id !== closureId);
  }
  const cleared = before - (s.book.pendingAAR || []).length;
  await rSet('terminal:book', s.book);
  return { clock: bkk(), cleared, book: bookView(s.book) };
}

// Red flag review: day-5+ keep-or-close, burden of proof on KEEP
async function actRedFlag(positionId) {
  const t = bkk();
  const s = await loadAll();
  const p = s.book.positions.find((x) => x.id === positionId);
  if (!p) throw new Error('Position not found.');
  const [news, rates, cal, patternIdeas, live] = await Promise.all([
    getNews('forex'), refRates(), getCalendar(),
    getSymbolIdeas(normPair(p.pair)).catch(() => []),
    livePrices([p.pair], null).catch(() => ({})),
  ]);
  // real trader pattern setups for THIS pair, to weigh in the hold-or-close call
  const patternDesk = patternIdeas.length
    ? patternIdeas.slice(0, 5).map((i) => `- ${i.title.trim()}`).join('\n')
    : 'no pattern feed for this pair this run';
  const liveLine = formatPrices(live) || 'live price unavailable this run';
  const held = daysHeld(p.openedAt);
  const hoursOpen = p.openedAt ? Math.max(0, (Date.now() - p.openedAt) / 3600e3) : null;
  const fromDesk = !!p.ideaId; // this position was opened from one of the desk's own ideas
  const isLongTerm = !!p.longTerm || /long/i.test(p.proposedHorizon || '');
  const pp = normPair(p.pair);
  const pairCal = calLines(cal, [pp.slice(0, 3), pp.slice(3, 6)]);
  const marginShare = s.book.vitals?.margin && s.book.vitals?.equity
    ? `this book uses ${s.book.vitals.margin} margin of ${s.book.vitals.equity} equity`
    : 'margin share unknown';

  // ---- horizon-aware, self-aware framing (the fix) ----
  // A one-day trade overstays after ~1 day; a long-term hold does not overstay for weeks.
  // A trade the desk itself just proposed must NOT be reviewed as if it were stale.
  let lifeFrame, ruleFrame;
  if (isLongTerm) {
    lifeFrame = `This is a LONG-TERM position (horizon: ${p.proposedHorizon || 'long-term hold'}), held ${held} day(s). It is NOT exempt from scrutiny; it needs a genuine review, just conducted through a LONG-TERM lens rather than a one-day scalp's twitchiness. Do real work here: (a) PATTERN: read the higher-timeframe price action and trend (weekly/daily structure, key support/resistance, whether the broader move is still intact or turning). (b) NEWS: weigh the durable, structural developments that bear on a multi-week/multi-month thesis, not a fleeting intraday risk-off spike. (c) LEVELS: check whether the current SL (${p.sl || 'none'}) and TP (${p.tp || 'none'}) still make sense at the present price, or should be revised for a long-term hold. (d) DURATION: if keeping, say concretely HOW MUCH LONGER to hold and toward what (a level, a catalyst, a timeframe).`;
    ruleFrame = `RULES: Judge on the durable long-term thesis and the higher-timeframe pattern, not one-day noise. Default to KEEP unless that long-term thesis has genuinely broken (a structural macro shift, a higher-timeframe trend reversal, a fundamental change) OR the levels/pattern now argue the position no longer makes sense. A temporary drawdown or a short-lived news spike is not itself a close signal. But DO give an honest, substantive verdict: if the long-term picture has soured, say CLOSE plainly. When you KEEP, you MUST provide a revised thesis, sensible revised or confirmed SL/TP levels, and a concrete answer on how much longer to hold.`;
  } else if (fromDesk && hoursOpen != null && hoursOpen < 20) {
    lifeFrame = `IMPORTANT: THE DESK ITSELF PROPOSED THIS TRADE and it was opened only ${hoursOpen < 1 ? Math.round(hoursOpen * 60) + ' minutes' : hoursOpen.toFixed(1) + ' hours'} ago, well inside its proposed ${p.proposedHorizon || 'one-day'} horizon. It has NOT overstayed; it has barely begun. Do NOT contradict the desk's own fresh proposal on ordinary intraday noise or a modest adverse move. Give the trade the room its horizon allows.`;
    ruleFrame = `RULES: Because this is a fresh, desk-proposed trade still inside its horizon, the burden of proof sits firmly on CLOSE. Default to KEEP. Recommend CLOSE ONLY if a genuine, specific, checkable event has BROKEN the original thesis since entry (e.g. the exact catalyst the trade was built on has now reversed, or a hard invalidation level written into the thesis has actually triggered). A small floating loss, general risk-off tone, or "might drift" is NOT grounds to close a trade the desk proposed minutes ago. If the thesis is intact, KEEP and simply restate it.`;
  } else {
    const overstayed = hoursOpen != null && hoursOpen > 26;
    lifeFrame = `Position held ${held} day(s) (proposed horizon was: ${p.proposedHorizon || 'one-day, close within 24h'}${overstayed ? ', so this position HAS overstayed its intended one-day life' : ', still within or near its intended life'}).`;
    ruleFrame = `RULES: The burden of proof sits on KEEP. A KEEP requires specific, current, checkable evidence the thesis is alive, plus a brand-new present-tense thesis, revised horizon and levels. "Price might come back" is a prayer, not a thesis; for an overstayed one-day trade, default to CLOSE. Weigh margin real estate: a not-quite-wrong position can still deserve closing on opportunity-cost grounds.`;
  }

  const verdict = await claude(`You are THE TERMINAL's red flag reviewer, running a zero-based position review (Peter Lynch test: if flat today, would you open THIS trade right now?), BUT calibrated to this position's actual horizon and origin.

${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}

Position under review: ${p.pair} ${p.direction} ${p.lots} lots @ ${p.entry}, SL ${p.sl || 'none'}, TP ${p.tp || 'none'}, floating ${p.floating ?? '?'}.
${lifeFrame}
Original thesis: ${p.thesis || 'none on record'}
Opportunity cost: ${marginShare}; a stale position blocks proper sizing of fresh ideas (weigh this ONLY if the position is genuinely stale or broken, not if it is a fresh or long-term hold doing its job).
UPCOMING CALENDAR for this pair's currencies, Bangkok times (validated Forex Factory data):
${pairCal}
Fresh wire (each item is source-tagged in [brackets] — sources live this run: ${liveSourceLine(news)}):\n${digest(news, 20)}

PATTERN DESK for ${p.pair} — real trader setups from TradingView (technical/chart context for the hold-or-close call; crowd ideas, weigh critically, but they show where technical attention sits on this exact pair):
${patternDesk}

LIVE PRICE + VOLATILITY for ${p.pair} (use this to judge whether the position's stop/target still make sense against where price actually is and how much it's moving):
${liveLine}

${ruleFrame}

SOURCE VALIDATION (mandatory): your KEEP/CLOSE verdict must be validated against the market news above, and grounded in CONVERGENCE — MULTIPLE independent sources pointing the same way, not a single headline. In "sources", list the SPECIFIC items you relied on, each as "[Source] the specific point", drawn from DIFFERENT outlets where possible (e.g. two or three of ForexLive, FXStreet, ActionForex agreeing). State your convergence honestly in "source_convergence": if several independent sources agree, say STRONG; if only one source or the wire is quiet on this pair, say WEAK/THIN and let that temper the verdict's confidence. Do NOT invent sources or attribute claims to outlets that did not make them; if the wire genuinely says little about this pair, say so plainly rather than fabricating convergence.

For a LONG-TERM KEEP you MUST fill "hold_duration" (how much longer and toward what) and "levels_check" (whether SL/TP still make sense, revised if needed). BREVITY: reason max 40 words, telegram style.

JSON only: {"verdict":"KEEP|CLOSE","reason":"...","evidence":["specific current evidence items"],"sources":["[Source] the specific point relied on — from MULTIPLE different outlets where the wire allows"],"source_convergence":"STRONG|MODERATE|WEAK/THIN — how many independent sources actually converge","new_thesis":"required if KEEP","new_horizon":"required if KEEP","hold_duration":"for a long-term KEEP: how much longer to hold and toward what level/catalyst","levels_check":"do current SL/TP still make sense? revised levels if not","suggested_levels":"optional revised SL/TP","margin_note":"..."}`, 1600);

  p.lastReview = { verdict: verdict.verdict, reason: verdict.reason, new_thesis: verdict.new_thesis || null, hold_duration: verdict.hold_duration || null, levels_check: verdict.levels_check || null, sources: Array.isArray(verdict.sources) ? verdict.sources : [], source_convergence: verdict.source_convergence || null, at: t.iso };

  if (verdict.verdict === 'KEEP') {
    p.ageResetAt = Date.now();
    p.thesis = verdict.new_thesis || p.thesis;
    p.redFlagHistory = [...(p.redFlagHistory || []), { ts: t.iso, verdict: 'KEEP' }];
  } else {
    p.redFlagHistory = [...(p.redFlagHistory || []), { ts: t.iso, verdict: 'CLOSE' }];
  }
  await rSet('terminal:book', s.book);
  return { clock: t, verdict, position: p };
}

// ---------- Mark a position long-term (or back to short-term) ----------
// A long-term hold is judged on its durable thesis and exempted from the one-day
// aging ladder and the close-biased fresh-trade review.
async function actSetHorizon(positionId, longTerm) {
  const s = await loadAll();
  const p = s.book.positions.find((x) => x.id === positionId);
  if (!p) throw new Error('Position not found.');
  p.longTerm = !!longTerm;
  if (longTerm) { p.proposedHorizon = 'long-term hold'; p.ageResetAt = Date.now(); }
  await rSet('terminal:book', s.book);
  return { ok: true, position: p };
}

// ---------- Router ----------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { action, ...p } = req.body || {};
    let out;
    if (action === 'get') out = await actGet();
    else if (action === 'ideas') out = await actIdeas(!!p.force);
    else if (action === 'sync') out = await actSync(p.positionsImages || p.positionsImage, p.historyImage);
    else if (action === 'fill') out = await actFill(p.image, p.ideaLedgerId);
    else if (action === 'pass') out = await actPass(p.ideaLedgerId);
    else if (action === 'aar') out = await actAAR(p.closureId, p.historyImage);
    else if (action === 'dismissclosure') out = await actDismissClosure(p.closureId);
    else if (action === 'redflag') out = await actRedFlag(p.positionId);
    else if (action === 'horizon') out = await actSetHorizon(p.positionId, p.longTerm);
    else throw new Error(`Unknown action: ${action}`);
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };
