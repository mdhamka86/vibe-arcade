// api/terminal-engine.js
// THE TERMINAL — desk brain. Ideas engine, screenshot parsing, reconciliation,
// aging ladder, red flag reviews, AAR, lessons archive. State lives in Upstash Redis.
//
// Env vars required on Vercel:
//   ANTHROPIC_API_KEY            (console.anthropic.com)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (or KV_REST_API_URL / KV_REST_API_TOKEN)

import { getNews } from './terminal-news.js';

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
  const text = (j.content || []).map((c) => c.text || '').join('\n');
  const clean = text.replace(/```json|```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : clean);
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
function checkLevels(idea, refPx) {
  const dir = (idea.direction || '').toUpperCase();
  const entry = num(idea.entry_zone);
  const tp = num(idea.tp);
  const sl = num(idea.sl);
  if (entry == null || tp == null || sl == null) return { ok: false, reason: 'missing a numeric entry, TP or SL' };
  if (dir !== 'BUY' && dir !== 'SELL') return { ok: false, reason: 'direction not BUY/SELL' };

  // 1) entry must live near the real market: within 3% of the live reference.
  // This is the check that kills the NZDUSD 1.5635 nonsense.
  if (refPx) {
    const drift = Math.abs(entry - refPx) / refPx;
    if (drift > 0.03) return { ok: false, reason: `entry ${entry} is ${(drift * 100).toFixed(1)}% off live ${refPx.toFixed(4)} — off-market or wrong magnitude` };
    // every level should share the market's order of magnitude
    for (const [name, lvl] of [['TP', tp], ['SL', sl]]) {
      const d = Math.abs(lvl - refPx) / refPx;
      if (d > 0.06) return { ok: false, reason: `${name} ${lvl} is ${(d * 100).toFixed(1)}% from live ${refPx.toFixed(4)} — implausible for a one-day trade` };
    }
  }
  // 2) geometry: BUY => SL below entry, TP above; SELL => the reverse.
  if (dir === 'BUY' && !(sl < entry && tp > entry)) return { ok: false, reason: `BUY needs SL(${sl}) below and TP(${tp}) above entry(${entry})` };
  if (dir === 'SELL' && !(sl > entry && tp < entry)) return { ok: false, reason: `SELL needs SL(${sl}) above and TP(${tp}) below entry(${entry})` };

  // 3) risk:reward should not be upside-down; warn if reward < risk
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk ? +(reward / risk).toFixed(2) : null;
  if (rr != null && rr < 1) return { ok: false, reason: `reward:risk ${rr} is below 1 — target closer than stop` };
  return { ok: true, rr };
}
function refFor(pair, rates) {
  if (!rates) return null;
  const p = normPair(pair);
  if (rates[p] != null) return rates[p];
  // try inverse (e.g. someone wrote USDGBP)
  const inv = p.slice(3, 6) + p.slice(0, 3);
  if (rates[inv] != null) return +(1 / rates[inv]).toFixed(5);
  return null;
}

// ---------- Reference FX rates (frankfurter.dev, ECB daily, no key) ----------
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
  return {
    ...book,
    positions: (book.positions || []).map((p) => {
      const base = p.ageResetAt || p.openedAt;
      const d = daysHeld(base);
      return { ...p, daysHeld: daysHeld(p.openedAt), ageDays: d, ageFlag: ageFlag(d) };
    }),
  };
}
function digest(items, n = 16) {
  return (items || []).slice(0, n).map((i) => `- [${i.source}] ${i.title}`).join('\n');
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
  if (cached && !force) return { clock: t, ideas: cached, cached: true };
  if (t.isWeekend && !force) return { clock: t, weekend: true, ideas: null };

  const s = await loadAll();
  const [news, rates, cal] = await Promise.all([getNews('forex'), refRates(), getCalendar()]);

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

  const priceBlock = rates
    ? Object.entries(rates).filter(([k]) => k !== 'asOf' && rates[k] != null)
        .map(([k, v]) => `${k} ${v}`).join(', ')
    : 'live prices unavailable, be conservative';

  // session awareness: the desk is used both at the 21:20 night session and in the
  // morning (~07:30-08:00). Each session has a different live market, so the hunting
  // ground must shift accordingly rather than always leaning on US-session dollar pairs.
  const isMorning = t.hour >= 5 && t.hour < 12;
  const sessionBrief = isMorning
    ? `MORNING SESSION (${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} BKK). The active markets now are the Asian session (Tokyo, Sydney, Singapore) rolling into the European open. Do NOT default to US-session dollar pairs whose catalysts have already passed overnight. Hunt where the liquidity and news flow actually are right now: JPY crosses, AUD and NZD (RBA/RBNZ, Chinese data, commodities), EUR and GBP as Europe wakes. A one-day trade opened this morning should be built around today's Asian/European catalysts, not last night's New York move.`
    : `NIGHT SESSION (${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} BKK), inside the London/New York overlap, the most liquid and directional window of the day. US data has settled; trade the genuine trend of the session.`;

  const prompt = `You are the ideas engine of THE TERMINAL, the forex desk of a retail trader in Phuket (broker: Phillip MT5). He trades both a night session (21:20 BKK) and a morning session (~07:30-08:00 BKK). Typical sizing 0.02-0.10 lots. Account is small; capital preservation beats bravado.

${sessionBrief}

${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}

LIVE REFERENCE PRICES (anchor EVERY level to these; entries must sit within ~0.5% of the live price, not at invented round numbers):
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

Tonight's forex news wire (multi-source: ForexLive, FXStreet, ActionForex, Myfxbook, DailyForex, central bank feed, Google News):
${digest(news, 20)}

TASK: Propose exactly 2 short-term ideas built as ONE-DAY positions: opened tonight, targeted to close within ~24h, 48h absolute ceiling. Be genuinely critical: if conditions are poor, low conviction is honest and stand_down may be true (still show the 2 best candidates, marked LOW). Rules:

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
- Prefer R:R of at least 1.5. LEVEL DISCIPLINE (critical): entry_zone must sit within ~0.5% of the live reference price above. SL and TP must be on the correct sides (BUY: SL below entry, TP above; SELL: SL above, TP below) and reflect realistic one-day travel, roughly 20-70 pips of stop on majors, sized to recent volatility, NOT arbitrary round numbers. Every level must share the pair's order of magnitude (e.g. NZDUSD levels are ~0.56xx, never 1.5xxx). Double-check each number against the live price before finalising.
- Weigh the lessons archive; do not repeat known mistakes.

Respond ONLY with JSON, no markdown:
{"ideas":[{"pair":"EUR/USD","direction":"BUY|SELL","entry_zone":"1.1440-1.1455","tp":"1.1520","sl":"1.1400","lots":"0.05","horizon":"one-day (close within 24h)","conviction":"LOW|MED|MED-HIGH|HIGH","thesis":"...","risks":"...","sizing_note":"why THIS lot size: the margin arithmetic, projected margin level if taken, and what capped or freed the size","correlation_note":"..."}],"stand_down":false,"desk_note":"one-paragraph read of the session"}
Reminder: every price you output is checked against live rates after you respond. An impossible level (wrong magnitude, or SL/TP on the wrong side) will be rejected, so verify each number now.`;

  let ideas = await claude(prompt, 2200);

  // combined gate: reject on duplicate/open exposure OR broken levels, retry once
  const isDupe = (i) => banned.has(normPair(i.pair) + '|' + i.direction) || openPairs.includes(normPair(i.pair));
  const levelCheck = (i) => checkLevels(i, refFor(i.pair, rates));
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
      else i.rr = lc.rr;
    });
  } else {
    (ideas.ideas || []).forEach((i) => { i.rr = levelCheck(i).rr; });
  }
  ideas.generatedAt = t.iso;
  ideas.dateKey = t.dateKey;

  // conviction gating: mark which ideas clear the MED-HIGH bar. Full set is kept for
  // the record and the shadow book; the frontend shows only the qualifying ones.
  const clears = (c) => ['MED-HIGH', 'HIGH'].includes((c || '').toUpperCase());
  (ideas.ideas || []).forEach((i) => { i.qualifies = clears(i.conviction) && !i.level_warning; });
  ideas.qualifyingCount = (ideas.ideas || []).filter((i) => i.qualifies).length;
  ideas.session = isMorning ? 'morning' : 'night';
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
JSON: {"positions":[{"pair":"EURUSD","direction":"BUY|SELL","lots":0.1,"entry":1.14388,"current":1.1438,"sl":1.116,"tp":1.18,"floating":-2.14}],"vitals":{"balance":0,"equity":0,"margin":0,"freeMargin":0,"marginLevel":0}}
If a field is not visible use null. marginLevel as a number (percent).`,
    history: `Extract ALL closed deals visible in this MT5 history screenshot.
JSON: {"closes":[{"pair":"EURUSD","direction":"BUY|SELL","lots":0.1,"entry":1.14388,"exit":1.15,"profit":24.2,"closeTime":"2026.07.02 19:41"}]}`,
    fill: `Extract the single confirmed position (the newest/most relevant) plus account vitals if visible from this MT5 screenshot.
JSON: {"fill":{"pair":"EURUSD","direction":"BUY|SELL","lots":0.1,"entry":1.14388,"sl":1.116,"tp":1.18},"vitals":{"balance":null,"equity":null,"freeMargin":null,"marginLevel":null}}`,
  }[kind];

  return claude([
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
    { type: 'text', text: `${spec}\nRespond ONLY with JSON, no markdown, no commentary.` },
  ], 1600);
}

function samePos(a, b) {
  return a.pair.replace('/', '') === b.pair.replace('/', '') &&
    a.direction === b.direction &&
    Math.abs((a.lots || 0) - (b.lots || 0)) < 0.001 &&
    Math.abs((a.entry || 0) - (b.entry || 0)) / (a.entry || 1) < 0.002;
}

// Morning sync: positions shot (+ optional history shot) -> reconcile
async function actSync(positionsImg, historyImg) {
  const t = bkk();
  const s = await loadAll();
  const posParse = positionsImg ? await parseShot(positionsImg, 'positions') : { positions: [], vitals: null };
  const histParse = historyImg ? await parseShot(historyImg, 'history') : { closes: [] };

  const seen = posParse.positions || [];
  const report = { closedDetected: [], orphansAdded: [], updated: 0, agingFlags: [], vitalsAlert: null };

  // 1) positions in book but missing on screen -> closed; match against history
  const still = [];
  for (const p of s.book.positions) {
    const onScreen = seen.find((x) => samePos(x, p));
    if (onScreen) {
      p.floating = onScreen.floating ?? p.floating;
      p.sl = onScreen.sl ?? p.sl; p.tp = onScreen.tp ?? p.tp;
      report.updated++;
      still.push(p);
    } else {
      const match = (histParse.closes || []).find((c) => samePos(c, p));
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
  // 2) on screen but not in book -> orphan, adopt it
  for (const x of seen) {
    if (!s.book.positions.find((p) => samePos(p, x))) {
      const orphan = {
        id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ...x, pair: x.pair.replace('/', ''), openedAt: Date.now(), orphan: true,
        thesis: 'Off-book entry, no engine thesis on record.',
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
      return `${p.pair} ${p.direction} ${p.lots} @ ${p.entry}, now ~${ref ?? '?'}, floating ${p.floating ?? '?'}, held ${p.ageDays}d. ${p.thesis && p.thesis !== 'Off-book entry, no engine thesis on record.' ? 'Thesis on record: ' + p.thesis : 'NO thesis on record (off-book entry): infer the most likely reason a trader took this direction here, then judge it.'}`;
    }).join('\n');

    morningNote = await claude(`You are THE TERMINAL's morning desk analyst. Your most important job is to re-examine every open position against CURRENT conditions and judge, honestly, whether its thesis still holds or whether it is time to think about closing. Do not rubber-stamp; a position being green does not mean the thesis is intact, and a position being red does not mean it is broken.

${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}

OPEN POSITIONS TO RE-EXAMINE (one verdict each):
${posDetail}

Closures detected this sync: ${report.closedDetected.map((c) => `${c.position.pair} ${c.position.direction} ${c.close ? `closed ${c.close.profit >= 0 ? '+' : ''}${c.close.profit}` : 'closed, awaiting history screenshot'}`).join('; ') || 'none'}
TODAY'S ECONOMIC CALENDAR, High/Medium impact, Bangkok times (validated Forex Factory data, do not invent events beyond it):
${calLines(cal)}
Fresh wire:\n${digest(news, 14)}

For EACH open position, decide a thesis status: HOLDING (original reasoning intact, stay the course), WOBBLING (thesis under strain, watch closely, be ready to act), or BROKEN (the reason for the trade no longer applies, actively consider closing). Ground the verdict in the fresh news, the calendar and the price move since entry. For off-book positions, first infer the likely thesis in one clause, then judge it the same way.

Write TIGHT, telegram style. HARD LIMITS: headline max 8 words; each position read max 22 words including the status reason; pick only the 3-4 calendar events that matter, each "what" max 8 words and "why" max 10 words; overall max 30 words naming the single priority.
JSON only: {"headline":"...","lines":[{"pair":"EURUSD","status":"HOLDING|WOBBLING|BROKEN","read":"the reason, grounded in current conditions"}],"calendar":[{"when":"Mon 21:00 BKK","what":"USD ISM Services (fc 54.2)","why":"beat = USD bid, hits the long"}],"overall":"..."}`, 1400);
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
    c.close = (hp.closes || []).find((x) => samePos(x, c.position)) || (hp.closes || [])[0] || null;
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

// Red flag review: day-5+ keep-or-close, burden of proof on KEEP
async function actRedFlag(positionId) {
  const t = bkk();
  const s = await loadAll();
  const p = s.book.positions.find((x) => x.id === positionId);
  if (!p) throw new Error('Position not found.');
  const [news, rates, cal] = await Promise.all([getNews('forex'), refRates(), getCalendar()]);
  const held = daysHeld(p.openedAt);
  const pp = normPair(p.pair);
  const pairCal = calLines(cal, [pp.slice(0, 3), pp.slice(3, 6)]);
  const marginShare = s.book.vitals?.margin && s.book.vitals?.equity
    ? `this book uses ${s.book.vitals.margin} margin of ${s.book.vitals.equity} equity`
    : 'margin share unknown';

  const verdict = await claude(`You are THE TERMINAL's red flag reviewer, running a zero-based position review (Peter Lynch test: if flat today, would you open THIS trade right now?).

${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}

Position under review: ${p.pair} ${p.direction} ${p.lots} lots @ ${p.entry}, SL ${p.sl || 'none'}, TP ${p.tp || 'none'}, floating ${p.floating ?? '?'}, held ${held} days (proposed horizon was: ${p.proposedHorizon || 'one-day, close within 24h'}, so this position has overstayed its intended life).
Original thesis: ${p.thesis || 'none on record'}
Opportunity cost: ${marginShare}; a stale position blocks proper sizing of fresh ideas.
UPCOMING CALENDAR for this pair's currencies, Bangkok times (validated Forex Factory data):
${pairCal}
Fresh wire:\n${digest(news, 16)}

RULES: The burden of proof sits on KEEP. A KEEP requires specific, current, checkable evidence the thesis is alive, plus a brand-new present-tense thesis, revised horizon and levels. "Price might come back" is a prayer, not a thesis; default to CLOSE. Weigh margin real estate: a not-quite-wrong position can still deserve closing on opportunity-cost grounds. BREVITY: reason max 40 words, telegram style.

JSON only: {"verdict":"KEEP|CLOSE","reason":"...","evidence":["specific current evidence items"],"new_thesis":"required if KEEP","new_horizon":"required if KEEP","suggested_levels":"optional revised SL/TP","margin_note":"..."}`, 1600);

  p.lastReview = { verdict: verdict.verdict, reason: verdict.reason, new_thesis: verdict.new_thesis || null, at: t.iso };

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

// ---------- Router ----------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { action, ...p } = req.body || {};
    let out;
    if (action === 'get') out = await actGet();
    else if (action === 'ideas') out = await actIdeas(!!p.force);
    else if (action === 'sync') out = await actSync(p.positionsImage, p.historyImage);
    else if (action === 'fill') out = await actFill(p.image, p.ideaLedgerId);
    else if (action === 'pass') out = await actPass(p.ideaLedgerId);
    else if (action === 'aar') out = await actAAR(p.closureId, p.historyImage);
    else if (action === 'redflag') out = await actRedFlag(p.positionId);
    else throw new Error(`Unknown action: ${action}`);
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };
