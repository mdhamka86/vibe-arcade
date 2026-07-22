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

// ---------- HORIZON DOCTRINE (single source of truth) ----------
// THE TRADER'S ACTUAL HORIZON IS 2-3 DAYS INTERDAY, not one day. The desk was previously
// hard-wired to a 24h life in five separate places — the idea prompt, the aging ladder, the
// level validator, the red-flag overstay test and the UI nag — with the numbers restated as
// literals at each site. The effect was that every NORMAL-length trade he holds got flagged
// AMBER on day 2 and RED on day 3, and the red-flag review that fired there ran with its
// burden of proof set to CLOSE. The desk was nagging him out of trades at exactly the point
// his own routine says hold.
//
// Every horizon number now derives from this one block. If the doctrine changes again, change
// it HERE — do not reintroduce literals at the call sites, which is how the five drifted apart.
const HORIZON = {
  targetDaysMin: 2,        // the trade is meant to work in 2...
  targetDaysMax: 3,        // ...to 3 days
  ceilingDays: 4,          // absolute life; past this it has genuinely overstayed
  ceilingHours: 96,        // ceilingDays in hours, for the hour-precise review path
  freshHours: 48,          // a desk-proposed trade is "still fresh" for its first 2 days
  // Level-validator tolerances, widened from the one-day settings. A 2-3 day trade legitimately
  // sits further from spot at entry and needs materially more stop room than a 24h scalp.
  maxEntryDriftPct: 0.025, // was 0.015 — an entry this far out can still fill across 2-3 days
  maxLevelDriftPct: 0.08,  // was 0.06  — magnitude-nonsense catcher, not a tightness rule
  minStopPips: 10,         // was 8     — anything tighter is noise over a multi-day hold
  maxStopPips: 300,        // was 150   — ~2-3x daily ATR on the wider crosses
  minTargetPips: 12,       // was 8     — below this the spread eats a multi-day hold
};
// The one human-readable name for the doctrine, so stored positions and prompts cannot drift
// apart from it the way the five literal sites did.
HORIZON.label = `${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day interday`;
// The calendar deliberately reaches BEYOND the trade's own life — see the note in getCalendar().
const CALENDAR_LOOKAHEAD_HOURS = HORIZON.ceilingHours + 48;

// ---------- OVERNIGHT SCREEN: staleness contract ----------
// terminal-screen.js writes a ranked board to `terminal:screen`. This engine reads it as
// ADDITIVE context and never depends on it: if the board is missing or old, idea generation runs
// exactly as it did before, and says on screen that it ran unscreened.
//
// The thresholds are generous BECAUSE the screen's factors are daily-derived — a 20-day range
// and a 14-day ATR do not meaningfully move in six hours. (This is exactly why forex-brain's
// verdicts could NOT be consumed the same way: a 90-minute breakout trigger is worthless an hour
// later, whereas a daily-structure board is not.)
//
// Past SCREEN_USABLE_MS the board is ignored ENTIRELY and the fact is surfaced. A cron can fail
// silently for days; an idea engine that quietly gets worse without saying so is the exact
// failure class this codebase has already been bitten by (vitals with no timestamp, a function
// with no declared timeout). Degradation must be loud.
//
// Lives here, in the consumer, and is imported BY terminal-screen — the dependency runs one way
// only, screen -> engine, so there is no import cycle between two handlers.
export const SCREEN_FRESH_MS = 12 * 3600e3;
export const SCREEN_USABLE_MS = 36 * 3600e3;
export function screenAge(pack, nowMs = Date.now()) {
  if (!pack || !pack.at) return { state: 'MISSING', ageMs: null, label: 'no screen has been run' };
  const ageMs = nowMs - Date.parse(pack.at);
  if (!Number.isFinite(ageMs) || ageMs < 0) return { state: 'MISSING', ageMs: null, label: 'screen timestamp unreadable' };
  const hrs = ageMs / 3600e3;
  if (ageMs <= SCREEN_FRESH_MS) return { state: 'FRESH', ageMs, label: `screened ${hrs < 1 ? Math.round(ageMs / 60000) + 'm' : hrs.toFixed(1) + 'h'} ago` };
  if (ageMs <= SCREEN_USABLE_MS) return { state: 'STALE', ageMs, label: `screen is ${hrs.toFixed(0)}h old — factors may have moved` };
  return { state: 'EXPIRED', ageMs, label: `screen is ${Math.round(hrs / 24)}d old and was ignored` };
}

// ---------- forex-brain as a CONDITIONS signal (and nothing more) ----------
// The sibling engine publishes a verdict per USD major on a 90-minute TTL. Those verdicts are
// NOT trade ideas for this desk: they are H1 range-breakouts with a 90-minute life, and this
// desk holds 2-3 days. Consuming them as ideas would import a foreign horizon.
//
// What IS informative is the AGGREGATE. forex-brain's doctrine is "FLAT is the default and the
// common answer", so when it nonetheless finds direction in most of the majors, that is a read
// on conditions — the dollar complex is trending rather than chopping. One line, in desk_note.
//
// Read-only, fail-silent, and expiry-aware: an expired verdict says nothing about right now, so
// stale ones are excluded rather than counted. If the whole thing is unavailable the desk simply
// does not mention it.
const BRAIN_MAJORS = ['EURUSD', 'USDJPY', 'GBPUSD', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD'];
async function readBrainConditions(nowMs = Date.now()) {
  const verdicts = await Promise.all(BRAIN_MAJORS.map((s) => rGet(`forex:verdict:${s}`).catch(() => null)));
  const live = verdicts.filter((v) => v && v.expiresAt && Date.parse(v.expiresAt) > nowMs);
  if (live.length < 3) return null; // too thin to characterise conditions honestly
  const flat = live.filter((v) => v.direction === 'FLAT').length;
  const directional = live.filter((v) => v.direction === 'BUY' || v.direction === 'SELL');
  return {
    live: live.length, flat, directional: directional.length,
    line: `forex-brain (sibling breakout engine, 90-min horizon — CONDITIONS ONLY, not an idea source): FLAT on ${flat}/${live.length} USD majors right now${directional.length ? `, directional on ${directional.map((v) => `${v.symbol} ${v.direction}`).join(', ')}` : ''}. It defaults to FLAT, so a high FLAT count suggests the dollar complex is chopping rather than trending; a low one suggests genuine direction. Use this to calibrate how much follow-through to expect, NOT to pick a pair.`,
  };
}

// Render a slice of the ranked board for the prompt. `from`/`to` let the retry show a DIFFERENT
// slice than the first attempt — the shortlist is what makes a second hunt possible at all.
function screenLines(ranked, from, to) {
  const slice = (ranked || []).slice(from, to);
  if (!slice.length) return '- no candidates in this slice';
  return slice.map((r, n) => {
    const f = r.factors || {};
    const bits = [
      f.atrD1Pips != null ? `ATR ${f.atrD1Pips}p/day` : null,
      f.volRatio != null ? `energy ${f.volRatio}x own baseline` : null,
      f.rangePos != null ? `range pos ${f.rangePos}` : null,
      f.trendSeparationAtr != null ? `trend ${f.trendSeparationAtr > 0 ? '+' : ''}${f.trendSeparationAtr} ATR` : null,
      f.catalysts && f.catalysts.next ? `next: ${f.catalysts.next.ccy} ${f.catalysts.next.title} ${f.catalysts.next.when} (${f.catalysts.next.impact}, in ${f.catalysts.next.hoursOut}h)` : 'no scheduled catalyst in window',
    ].filter(Boolean);
    // The overnight analyst's own read, where there is one. This is the substance of the upgrade:
    // the shortlist arrives already reasoned about, pair by pair, rather than as bare numbers.
    const l = r.llm;
    const head = l
      ? `${from + n + 1}. ${r.pair} [analyst ${l.score}/100, ${l.direction}${l.direction !== 'STAND_ASIDE' ? `, ${l.conviction}` : ''}]`
      : `${from + n + 1}. ${r.pair} [score ${r.score}]`;
    const body = l
      ? `\n     read: ${l.read}${l.keyRisk ? `\n     key risk: ${l.keyRisk}` : ''}${l.catalystDependency ? `\n     catalyst: ${l.catalystDependency}` : ''}${l.entry != null ? `\n     indicative levels at screen time: entry ${l.entry}, TP ${l.tp}, SL ${l.sl} (RE-ANCHOR these to the live price below)` : ''}`
      : `\n     why: ${r.why}`;
    return `${head} ${bits.join(' · ')}${body}`;
  }).join('\n');
}
// Aging ladder derived from the doctrine above: OK inside the intended window, NOTE at the
// top of it, AMBER at the ceiling, RED once genuinely past it. Under the old one-day ladder
// these same holds read AMBER/RED on days 2 and 3.
const ageFlag = (d) =>
  (d > HORIZON.ceilingDays ? 'RED'
    : d >= HORIZON.ceilingDays ? 'AMBER'
    : d >= HORIZON.targetDaysMax ? 'NOTE'
    : 'OK');

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
// Exported so terminal-screen.js can share the parser AND the `terminal:cal` cache rather than
// growing a second Forex Factory reader. One definition, one cache, one rate-limit budget.
export async function getCalendar() {
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
      // The forward window must OVERSHOOT the hold window, not merely match it. Was a flat 56h,
      // sized for the old one-day doctrine, which stopped before a 3-day trade did. Matching the
      // 96h ceiling exactly would be better but still wrong in a specific way: an event landing
      // just PAST the ceiling is precisely the one worth knowing about, because it is the reason
      // to close at day 3 rather than run to day 4 — and a calendar truncated at the ceiling can
      // never show it. Overshooting by two days also keeps the per-idea "catalyst lands after
      // this trade's ceiling" check meaningful; truncating at the ceiling would make that branch
      // unreachable, i.e. a validation that can never fire.
      if (utc < Date.now() - 3600e3 || utc > Date.now() + CALENDAR_LOOKAHEAD_HOURS * 3600e3) continue;
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
const calLine = (e) => `- ${e.when} · ${e.ccy} ${e.title} [${e.impact}]${e.forecast ? ` (fc ${e.forecast}, prev ${e.previous})` : ''}`;
function calLines(events, ccys) {
  const f = ccys && ccys.length ? events.filter((e) => ccys.includes(e.ccy)) : events;
  return f.slice(0, 14).map(calLine).join('\n') || `- nothing High/Medium inside the ${HORIZON.ceilingDays}-day window`;
}
const normPair = (p) => (p || '').replace(/[^A-Za-z]/g, '').toUpperCase();

// ---------- Per-currency calendar for the IDEAS path (audit finding 7) ----------
// The ideas prompt used to receive `calLines(cal)` with NO currency argument: a single global
// top-14 list. Two things went wrong with that. First, the model is choosing among ~19 pairs,
// so it needs the events for whatever pair it lands on — not the fourteen loudest events
// overall. Second, the slice(0,14) truncation is not neutral: it is chronological, so a quiet
// morning of EUR data would push every NZD event off the end and the desk would never learn
// that RBNZ prints inside the hold window. The red-flag path already filters per pair; this
// mirrors that for the hunt, grouped so nothing is silently dropped.
const UNIVERSE_CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD'];
function calByCurrency(events, ccys = UNIVERSE_CCYS) {
  const out = [];
  for (const c of ccys) {
    const mine = (events || []).filter((e) => e.ccy === c);
    if (!mine.length) { out.push(`${c}: nothing High/Medium in the window`); continue; }
    out.push(`${c}:\n${mine.map((e) => '  ' + calLine(e).slice(2)).join('\n')}`);
  }
  return out.join('\n') || `- no calendar data this run`;
}

// ---------- Catalyst resolution (audit finding 8) ----------
// The idea schema now carries a structured catalyst. This resolves the model's CLAIM back to a
// REAL event in the calendar we handed it, so an event-anchored idea can be verified rather
// than taken on trust, and so the shadow book can eventually answer "do event-anchored ideas
// actually outperform?" — a question the old free-text thesis made unanswerable.
// Matching is deliberately loose (the model paraphrases titles); we require the currency to
// match and a meaningful word overlap with the real title.
function resolveCatalyst(claim, events, pair) {
  if (!claim || typeof claim !== 'object') return null;
  const title = String(claim.event || '').toLowerCase().trim();
  if (!title) return null;
  const p = normPair(pair);
  const legs = [p.slice(0, 3), p.slice(3, 6)];
  const words = new Set(title.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  let best = null, bestScore = 0;
  for (const e of events || []) {
    if (!legs.includes(e.ccy)) continue; // a catalyst must belong to one of the pair's own legs
    const et = String(e.title || '').toLowerCase();
    const ew = new Set(et.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
    if (!ew.size || !words.size) continue;
    let common = 0; for (const w of words) if (ew.has(w)) common++;
    const score = common / Math.min(words.size, ew.size);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.5 ? best : null;
}

// ---------- RED FOLDER GUARD (ported from forex-brain.js:125) ----------
// The sibling engine in this same directory forces FLAT when a High-impact event for either of
// a pair's currencies lands inside a guard window. The Terminal had the identical calendar data
// in hand and no such guard — a proposal could walk blind into an NFP print with nothing in
// code to stop it.
//
// PORTED, NOT COPIED, because the doctrines differ. forex-brain is a breakout system where an
// imminent print is simply a trap, so it hard-forces FLAT. The Terminal's prompt explicitly
// invites event trades ("trade the setup around a specific scheduled event, or explicitly
// position clear of it"), so a blanket ban would fight its own doctrine. The rule enforced here
// is therefore the narrower and more honest one: you may trade into a print, but you may not do
// it BLIND. An idea that names the event as its catalyst passes (capped); one that does not,
// fails and is sent back.
//
// Window is 60 minutes rather than forex-brain's 45: the Terminal proposes an entry ZONE that
// may take time to fill, so the exposure to an imminent print starts earlier than a market
// order's would.
const RED_FOLDER_GUARD_MIN = 60;
function redFolderImminent(events, pair, guardMinutes = RED_FOLDER_GUARD_MIN, nowMs = Date.now()) {
  const p = normPair(pair);
  if (p.length < 6) return null;
  const legs = [p.slice(0, 3), p.slice(3, 6)];
  const win = guardMinutes * 60000;
  for (const e of events || []) {
    if (!e || !/high/i.test(String(e.impact || ''))) continue;
    if (!legs.includes(e.ccy)) continue;
    if (!Number.isFinite(e.utc)) continue;
    if (e.utc >= nowMs && e.utc - nowMs <= win) return e;
  }
  return null;
}

// ---------- Self-improvement reflection ----------
// Studies the resolved shadow scorecard plus taken-trade AARs and distils a standing
// set of concrete guidance notes that shape future idea generation. This is the
// learning loop: the desk gets measurably better by reflecting on its own record.
function shadowScorecard(ledger) {
  const resolved = ledger.filter((r) => r.status === 'passed' && r.shadowVerdict && r.shadowVerdict.grade);
  const taken = ledger.filter((r) => r.aar && r.aar.bucket);
  const tally = { win: 0, loss: 0, soft: 0, other: 0, total: resolved.length };
  const byPair = {};
  // BY CURRENCY, not only by pair (audit finding 2). Tracking pairs alone can never surface
  // "your GBP exposure is where you bleed" — a 1W-4L record spread across GBPUSD, GBPJPY and
  // GBPAUD shows as three unremarkable 0W-1L pairs and one 1W-2L, none of which clears the
  // 2-resolved threshold to even be mentioned. Netted by currency and by SIDE it reads as a
  // single clear finding. A pair is two currency bets, so each result credits both legs, and
  // the side matters: being wrong long GBP says nothing about being short it.
  const byCcy = {};
  const creditCcy = (ccy, side, isWin, isLoss) => {
    const k = `${side} ${ccy}`;
    byCcy[k] = byCcy[k] || { w: 0, l: 0 };
    if (isWin) byCcy[k].w++; else if (isLoss) byCcy[k].l++;
  };
  for (const r of resolved) {
    const g = r.shadowVerdict.grade;
    const isWin = g === 'WIN' || g === 'SOFT_WIN';
    const isLoss = g === 'LOSS' || g === 'SOFT_LOSS';
    if (g === 'WIN') tally.win++; else if (g === 'LOSS') tally.loss++;
    else if (g === 'SOFT_WIN' || g === 'SOFT_LOSS') tally.soft++; else tally.other++;
    const p = normPair(r.idea.pair);
    byPair[p] = byPair[p] || { w: 0, l: 0 };
    if (isWin) byPair[p].w++; else if (isLoss) byPair[p].l++;
    const dir = (r.idea.direction || '').toUpperCase();
    if (p.length >= 6 && (dir === 'BUY' || dir === 'SELL')) {
      const long = dir === 'BUY';
      creditCcy(p.slice(0, 3), long ? 'LONG' : 'SHORT', isWin, isLoss);
      creditCcy(p.slice(3, 6), long ? 'SHORT' : 'LONG', isWin, isLoss);
    }
  }
  return { tally, byPair, byCcy, resolved, taken };
}

async function reflectAndLearn(s, t) {
  const card = shadowScorecard(s.ledger);
  // need a reasonable sample before drawing conclusions; avoid jumping at noise
  if (card.resolved.length < 6) return null;

  const pairLines = Object.entries(card.byPair)
    .filter(([, v]) => v.w + v.l >= 2)
    .map(([p, v]) => `${p}: ${v.w}W-${v.l}L`).join(', ') || 'no pair has 2+ resolved yet';
  const ccyLines = Object.entries(card.byCcy)
    .filter(([, v]) => v.w + v.l >= 3)
    .sort((a, b) => (b[1].l - b[1].w) - (a[1].l - a[1].w))
    .map(([c, v]) => `${c}: ${v.w}W-${v.l}L`).join(', ') || 'no currency side has 3+ resolved yet';
  const takenLines = card.taken.slice(-10)
    .map((r) => `${r.idea?.pair || r.close?.pair} ${r.aar.bucket}`).join(', ') || 'none';
  const priorGuidance = (s.guidance || []).map((g) => `- ${g.text}`).join('\n') || '- none yet';

  const reflection = await claude(`You are THE TERMINAL's performance analyst. Study the desk's own track record and distil what it should DO DIFFERENTLY to generate better ideas. Judge decision quality, not just outcomes.

SHADOW BOOK (ideas he passed on, tracked to resolution over the ${HORIZON.ceilingDays}-day horizon ceiling):
Overall: ${card.tally.win} clean wins, ${card.tally.loss} clean losses, ${card.tally.soft} soft calls, from ${card.tally.total} resolved.
By pair: ${pairLines}
By CURRENCY SIDE (each trade credits both legs; this is where a correlated book's real bias shows up — a bad run spread across three GBP crosses hides in the by-pair line but not here): ${ccyLines}

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

  // 1) entry must live near the real market. Over a 2-3 day hold an entry can sit further
  // from spot than a 24h scalp's and still fill, so the tolerance is HORIZON.maxEntryDriftPct.
  //
  // FAIL CLOSED WHEN THERE IS NO ANCHOR (audit finding 5). This block used to be wrapped in a
  // bare `if (refPx)`, so a pair we could not price skipped EVERY magnitude and proximity check
  // and fell through to a plain `{ok:true}` on geometry alone — invented levels reaching the
  // screen at full conviction with no warning. That is the Exchange's "no price is not a
  // blocker" bug in a narrower form. An unpriceable pair now returns ok:false with
  // `unanchored`, so the caller can retry for a priceable pair and, failing that, cap
  // conviction and warn rather than wave the numbers through.
  if (!refPx) {
    return { ok: false, unanchored: true, reason: `no live or reference price available for ${normPair(idea.pair) || 'this pair'} — its levels cannot be verified against the market, so they are not trustworthy` };
  }
  {
    const drift = Math.abs(entry - refPx) / refPx;
    if (drift > HORIZON.maxEntryDriftPct) return { ok: false, reason: `entry ${entry} is ${(drift * 100).toFixed(1)}% off live ${refPx.toFixed(4)} — too far to fill inside a ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day window` };
    // every level should share the market's order of magnitude
    for (const [name, lvl] of [['TP', tp], ['SL', sl]]) {
      const d = Math.abs(lvl - refPx) / refPx;
      if (d > HORIZON.maxLevelDriftPct) return { ok: false, reason: `${name} ${lvl} is ${(d * 100).toFixed(1)}% from live ${refPx.toFixed(4)} — implausible for a ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day trade` };
    }
  }
  // 2) geometry: BUY => SL below entry, TP above; SELL => the reverse.
  if (dir === 'BUY' && !(sl < entry && tp > entry)) return { ok: false, reason: `BUY needs SL(${sl}) below and TP(${tp}) above entry(${entry})` };
  if (dir === 'SELL' && !(sl > entry && tp < entry)) return { ok: false, reason: `SELL needs SL(${sl}) above and TP(${tp}) below entry(${entry})` };

  // 3) stop distance must be sane for the 2-3 day horizon: not so tight that two days of
  // ordinary noise stops it out, not so wide it ties up absurd risk. The old band (8-150 pips)
  // was sized for a 24h scalp and would reject stops that are correct for a multi-day hold.
  const pip = pipSize(idea.pair, refPx);
  const slPips = Math.abs(entry - sl) / pip;
  const tpPips = Math.abs(tp - entry) / pip;
  if (slPips < HORIZON.minStopPips) return { ok: false, reason: `stop is only ${slPips.toFixed(0)} pips from entry — ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} days of ordinary noise will stop it out; needs room to breathe` };
  if (slPips > HORIZON.maxStopPips) return { ok: false, reason: `stop is ${slPips.toFixed(0)} pips away — far too wide even for a ${HORIZON.targetDaysMax} day hold` };
  if (tpPips < HORIZON.minTargetPips) return { ok: false, reason: `target is only ${tpPips.toFixed(0)} pips from entry — not worth the spread and risk` };

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
  // Liquid crosses that were in NEITHER this map NOR refRates, so refFor() returned null for
  // them and checkLevels waved their invented levels straight through (audit finding 5). The
  // validator now fails closed on a null anchor, but the better fix is to HAVE the anchor:
  // these are all real, fetchable Yahoo FX symbols and all derivable from the same single
  // frankfurter call refRates() already makes. Deliberately NOT added to PAIR_RANGES — see the
  // uniqueness note on that table; a second EUR-based band near 1.6 would silently degrade the
  // flagship EURAUD auto-correct from a correction to a flag.
  EURCAD: 'EURCAD=X', GBPCAD: 'GBPCAD=X', NZDCAD: 'NZDCAD=X', EURNZD: 'EURNZD=X', GBPNZD: 'GBPNZD=X',
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
      // Same five crosses added to YF_SYMBOL above: they cost nothing here (all derived from
      // the one frankfurter response already in hand) and they give refFor() a fallback anchor
      // so a proposal on one of them is validated rather than failed closed.
      EURCAD: cross('EUR', 'CAD'), GBPCAD: cross('GBP', 'CAD'), NZDCAD: cross('NZD', 'CAD'),
      EURNZD: cross('EUR', 'NZD'), GBPNZD: cross('GBP', 'NZD'),
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

// ================= CURRENCY EXPOSURE / CORRELATION (audit finding 2) =================
// The dupe gate only ever compared WHOLE PAIRS (`openPairs.includes(normPair(i.pair))`), so a
// proposed long GBPJPY sailed through while the book was already long GBPUSD and long GBPAUD —
// three bets on the same currency read as three "fresh" ideas. Correlation was mentioned four
// times in the prompt and enforced nowhere, and the model was never even shown the book's net
// currency posture: it got a semicolon-joined list of position rows and a 15-word field to
// summarise the risk in.
//
// A forex position is two currency bets, not one. BUY GBPJPY is long GBP AND short JPY. Netting
// those legs across the book is what turns a list of rows into a risk picture.
// Exported so the overnight screen scores book-fit against the SAME netting the idea gate uses.
// If these ever diverge, the screen would rank a pair as fresh risk that the gate then blocks
// as stacked — so they must be one function, not two that agree today.
export function currencyExposure(positions) {
  const exp = {};
  for (const p of positions || []) {
    const pr = normPair(p.pair);
    if (pr.length < 6) continue;
    const dir = (p.direction || '').toUpperCase();
    if (dir !== 'BUY' && dir !== 'SELL') continue;
    const lots = Math.abs(num(p.lots) ?? 0);
    if (!lots) continue;
    const s = dir === 'BUY' ? 1 : -1;
    const base = pr.slice(0, 3), quote = pr.slice(3, 6);
    exp[base] = +((exp[base] || 0) + s * lots).toFixed(4);
    exp[quote] = +((exp[quote] || 0) - s * lots).toFixed(4);
  }
  return exp;
}
// Human-readable posture line for the prompt. States the net side of every currency the book
// actually touches, so "you are long GBP three ways" is visible rather than inferable.
export function exposureLine(exp) {
  const rows = Object.entries(exp || {}).filter(([, v]) => Math.abs(v) > 1e-9)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!rows.length) return 'FLAT — no currency exposure on the book';
  return rows.map(([c, v]) => `${v > 0 ? 'LONG' : 'SHORT'} ${c} ${Math.abs(v).toFixed(2)} lots`).join(', ');
}
// Does this proposed idea STACK onto risk the book already carries?
// Returns the legs that add to an existing same-sign exposure. `heavy` means the stack is
// material enough to be sent back for a genuinely fresh idea rather than merely annotated:
// either BOTH legs stack materially (the proposal is a near-duplicate of the book's posture),
// or one material leg is more than doubled.
//
// MATERIALITY MATTERS, and leaving it out produced a real false positive. Run against his live
// book — long AUDUSD 0.05 and short GBPUSD 0.03 among others — the net USD exposure is a 0.02
// lot RESIDUAL, the arithmetic leftover of two positions that mostly cancel. Without a floor,
// a fresh 0.03-lot EURUSD idea "more than doubles" that residual and got BLOCKED as stacked
// risk, which is nonsense: there is no meaningful USD position to stack onto. A gate that
// blocks good ideas on rounding noise starves the screen and teaches him to ignore it, which
// is the same failure the PAIR_RANGES note warns about further down this file.
//
// So: every same-side leg is still REPORTED (it is true, and cheap to say), but only legs at
// or above one normal clip can cap conviction or block.
const STACK_MATERIAL_LOTS = 0.05;
function correlationCheck(idea, exp) {
  const p = normPair(idea && idea.pair);
  const dir = (idea && idea.direction || '').toUpperCase();
  const lots = Math.abs(num(idea && idea.lots) ?? 0) || 0;
  if (p.length < 6 || (dir !== 'BUY' && dir !== 'SELL')) return { stacked: [], heavy: false };
  const s = dir === 'BUY' ? 1 : -1;
  const legs = [[p.slice(0, 3), s], [p.slice(3, 6), -s]];
  const stacked = [];
  for (const [ccy, sign] of legs) {
    const existing = (exp || {})[ccy] || 0;
    if (Math.abs(existing) < 1e-9) continue;
    if (Math.sign(existing) !== sign) continue; // opposite side: this REDUCES risk, not stacks it
    const adding = lots || 0;
    stacked.push({
      ccy,
      side: sign > 0 ? 'LONG' : 'SHORT',
      existing: +Math.abs(existing).toFixed(2),
      adding: +adding.toFixed(2),
      combined: +(Math.abs(existing) + adding).toFixed(2),
      material: Math.abs(existing) >= STACK_MATERIAL_LOTS,
    });
  }
  const material = stacked.filter((x) => x.material);
  // "more than doubles" is only a meaningful test when we know the proposed size AND there is a
  // real position underneath it; when lots are missing we fall back to the both-legs test alone
  // rather than inventing a magnitude.
  const doubles = material.some((x) => x.adding > 0 && x.adding >= x.existing);
  return { stacked, material, heavy: material.length >= 2 || doubles };
}

// ================= MARGIN ARITHMETIC (audit finding 3) =================
// The SIZING DOCTRINE states a "HARD FLOOR: projected margin level must stay above 150%" and
// asks the model to compute it. Nothing checked the answer. checkLevels validated entry/TP/SL
// geometry down to the pip and never looked at `lots` or `vitals` at all — so the one number
// that decides whether a trade can blow up the account was the only one taken on trust, at a
// moment when the live book is sitting at MARGIN AMBER.
//
// Leverage is ~1:20, calibrated against the observed figure already documented in the prompt:
// 0.10 lots EURUSD consumes ~$570 of margin. 100_000 * 0.10 * 1.14 / 20 = $570. Checks out.
const LEVERAGE = 20;
const CONTRACT = 100000;
// USD value of one unit of a currency, from whatever price data we hold.
function usdPerUnit(ccy, rates, live) {
  if (ccy === 'USD') return 1;
  const direct = refFor(ccy + 'USD', rates, live);   // e.g. EURUSD -> USD per EUR
  if (direct) return direct;
  const inverse = refFor('USD' + ccy, rates, live);  // e.g. USDJPY -> JPY per USD
  if (inverse) return 1 / inverse;
  return null;
}
// Margin consumed by `lots` of `pair`, in account currency (USD). Null when we cannot price the
// base currency — and null must never be read as "free".
function estMarginUSD(pair, lots, rates, live) {
  const p = normPair(pair);
  const l = Math.abs(num(lots) ?? 0);
  if (p.length < 6 || !l) return null;
  const u = usdPerUnit(p.slice(0, 3), rates, live);
  if (!u || !Number.isFinite(u) || u <= 0) return null;
  return +((CONTRACT * l * u) / LEVERAGE).toFixed(2);
}
// Projected margin level (%) if `addMargin` of new margin is taken on. Mirrors the broker's own
// equity / margin-in-use * 100.
function projectedMarginLevel(vitals, addMargin) {
  const equity = num(vitals && vitals.equity);
  const inUse = num(vitals && vitals.margin) ?? 0;
  if (equity == null || addMargin == null) return null;
  const denom = inUse + addMargin;
  if (!(denom > 0)) return null;
  return +((equity / denom) * 100).toFixed(1);
}
const MARGIN_FLOOR_PCT = 150;   // hard floor from the doctrine
const MARGIN_PREFER_PCT = 200;  // preferred level if BOTH ideas were taken together
const LOT_STEP = 0.01;          // MT5 minimum increment; a size below this cannot be traded

// The largest lot size in `pair` that keeps the projected margin level at or above the floor.
//
// A FLOOR BREACH IS A FACT ABOUT LOT SIZE, NOT A JUDGEMENT ON THE TRADE. The gate used to
// REJECT any idea whose proposed size breached the floor, which threw away the analysis with the
// arithmetic — a genuinely good setup vanished because the model guessed 0.05 instead of 0.02.
// Solving for the size that fits keeps the idea and corrects only the number that was wrong.
//
//   projected = equity / (marginInUse + lots * marginPerLot) * 100  >=  floorPct
//   =>  lots <= ((equity * 100 / floorPct) - marginInUse) / marginPerLot
//
// Rounded DOWN to the broker's lot step: rounding up would re-breach the floor this exists to
// protect. Returns 0 when no tradeable size fits, null when the maths cannot be done at all.
function maxLotsWithinFloor(pair, vitals, rates, live, floorPct = MARGIN_FLOOR_PCT) {
  const equity = num(vitals && vitals.equity);
  if (equity == null || !(equity > 0)) return null;
  const inUse = num(vitals && vitals.margin) ?? 0;
  const perLot = estMarginUSD(pair, 1, rates, live);
  if (perLot == null || !(perLot > 0)) return null;
  const budget = (equity * 100 / floorPct) - inUse;
  // THE guard against a negative size, and deliberately the only one. An earlier version also
  // clamped the result with Math.max(0, …); the two were redundant, so removing either left the
  // other silently covering for it and neither was independently testable — the mutation harness
  // caught exactly that. One guard that is genuinely load-bearing beats two that alibi each other.
  if (!(budget > 0)) return 0; // already at or through the floor; nothing fits
  const raw = budget / perLot;
  const stepped = Math.floor(raw / LOT_STEP) * LOT_STEP;
  // toFixed(2) because floating point turns 0.06 into 0.060000000000000005, which then reads
  // back as an absurd lot size in the UI and in the prompt.
  return +stepped.toFixed(2);
}
// VITALS FRESHNESS. The engine already refuses to call a PRICE live at 6h old; margin and
// equity were rendered into the prompt with no age at all, so a week-old sync would size
// tonight's trades in silence. Same gate, same reasoning: we cannot verify a floor we cannot
// currently measure, so unverifiable is reported as unverifiable rather than passed.
const VITALS_FRESH_MS = 6 * 3600 * 1000;
function vitalsAge(vitals) {
  const ts = vitals && vitals.ts ? Date.parse(vitals.ts) : NaN;
  if (!Number.isFinite(ts)) return { known: false, fresh: false, ageMs: null, label: 'never synced' };
  const ageMs = Date.now() - ts;
  const fresh = ageMs >= 0 && ageMs <= VITALS_FRESH_MS;
  return { known: true, fresh, ageMs, label: fresh ? `synced ${Math.round(ageMs / 60000)}m ago` : `⚠ STALE, last synced ${Math.round(ageMs / 3600000)}h ago` };
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
  // Vitals are now stamped with their AGE. A margin level with no timestamp reads as current
  // whatever its true age, and sizing decisions were being made against it.
  const va = vitalsAge(vitals);
  // Net currency posture across the whole book, so stacked same-currency risk is VISIBLE rather
  // than something the model has to re-derive from a list of rows.
  const exp = currencyExposure(bv.positions);
  return `CONTEXT
Now (Bangkok): ${t.dmy} ${t.weekday} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}
Account vitals (${va.label}): ${vitals ? `balance ${vitals.balance}, equity ${vitals.equity}, margin in use ${vitals.margin ?? 'n/a'}, free margin ${vitals.freeMargin ?? 'n/a'}, margin level ${vitals.marginLevel}%` : 'not yet synced'}${vitals && !va.fresh ? '\n  ⚠ These vitals are STALE. Treat every margin figure below as unverified and size conservatively; the desk will not certify a margin floor it cannot currently measure.' : ''}
Open book: ${bv.positions.length ? bv.positions.map((p) => `${p.pair} ${p.direction} ${p.lots} lots @ ${p.entry}, SL ${p.sl || 'none'}, TP ${p.tp || 'none'}, floating ${p.floating ?? '?'}, held ${p.daysHeld}d [${p.ageFlag}]`).join('; ') : 'FLAT, no open positions'}
NET CURRENCY EXPOSURE (both legs of every open pair, netted — this is the risk you actually carry): ${exposureLine(exp)}
Reference rates (ECB daily, ${rates?.asOf || 'n/a'}): ${rates ? Object.entries(rates).filter(([k]) => k !== 'asOf').map(([k, v]) => `${k} ${v}`).join(', ') : 'unavailable'}
Lessons archive (scar tissue, most recent first):
${lessons.slice(-12).reverse().map((l) => `- ${l.text} (${l.date})`).join('\n') || '- none yet'}`;
}

// ================= THE IDEA GATE =================
// Every check that decides whether a proposal is safe to show runs through auditIdeaAgainst().
// Before this, only two existed — repeat/open exposure and level geometry — while correlation
// and the margin floor were requested in the prompt and verified nowhere. The two checks that
// actually bound RISK were the two taken on trust, on an account already at margin amber.
//
// Findings split into BLOCKING (send it back and ask for a different idea) and WARNINGS (show
// it, but say what is wrong and cap the conviction). The distinction matters: blocking a
// thin-but-honest idea just produces an empty screen, while showing an unverifiable one at full
// conviction is how a margin call happens. A cap can only ever LOWER what the model claimed.
//
// LIVES AT MODULE SCOPE, NOT INSIDE actIdeas, for the reason pairGuard() already documents in
// this file: a gate that cannot be reached from a test gets tested by a hand-copied duplicate,
// and the duplicate keeps passing long after the shipped code has drifted away from it. `ctx`
// carries everything the gate needs — {banned, openPairs, exposure, vitals, vitalsUsable, vAge,
// rates, live, cal} — so the suite can drive the real thing with constructed inputs.
const CONVICTION_RUNG = { LOW: 0, MED: 1, 'MED-HIGH': 2, HIGH: 3 };

// Which FX session is actually live at a given Bangkok hour. Module scope so the suite can
// assert the mapping against real session times rather than trusting prose that was wrong.
// Bangkok is UTC+7; see the derivation table at the sessionBrief call site.
function sessionPhase(hour) {
  if (hour >= 5 && hour < 15) return 'asian';     // 22:00-08:00 UTC — Sydney/Tokyo, London shut
  if (hour >= 15 && hour < 20) return 'european'; // 08:00-13:00 UTC — London open, pre-US
  if (hour >= 20) return 'overlap';               // 13:00-17:00 UTC — London/NY, deepest
  return 'newyork';                               // 17:00-22:00 UTC — NY afternoon, London shut
}

function ideaIsDupe(i, ctx) {
  const p = normPair(i && i.pair);
  return ctx.banned.has(p + '|' + (i && i.direction)) || ctx.openPairs.includes(p);
}

// CONVICTION MEASURES THE TRADE, NOT THE BOOK.
//
// This gate used to fold three different kinds of judgement into one number. Trade quality
// (is the setup real? does the catalyst check out? are the levels sane?) belongs in conviction.
// But the book's margin level and its existing currency exposure are facts about the ACCOUNT,
// not about the idea — and letting them lower the conviction band hid good ideas behind his own
// risk position, which is his to manage, not the desk's to censor. A genuinely strong setup was
// displayed as LOW because he happened to be carrying exposure that day.
//
// So findings now land in three buckets, and only two of them touch conviction:
//   blocking[]   the idea cannot be shown as written — send it back        (quality/safety)
//   warnings[]   real doubt about the TRADE — caps the conviction band     (quality)
//   riskNotes[]  facts about HIS BOOK — shown alongside, never cap         (margin, correlation)
//
// The 150% floor survives as a hard gate, but it RESIZES rather than kills: a breach is
// arithmetic about lot size, not a verdict on the setup.
function auditIdeaAgainst(i, ctx, nowMs = Date.now()) {
  const a = { blocking: [], warnings: [], riskNotes: [], cap: null, margin: null, correlation: null, catalyst: null, redFolder: null };
  const capTo = (c) => { if (a.cap == null || CONVICTION_RUNG[c] < CONVICTION_RUNG[a.cap]) a.cap = c; };

  // 1) repeat / already-open exposure
  if (ideaIsDupe(i, ctx)) a.blocking.push(`${i.pair} ${i.direction} repeats recent or open exposure`);

  // 2) levels — including the unanchored case, which used to pass silently
  const lc = checkLevels(i, refFor(i.pair, ctx.rates, ctx.live));
  a.level = lc;
  if (!lc.ok) {
    a.blocking.push(`${i.pair} ${i.direction}: ${lc.reason}`);
    if (lc.unanchored) capTo('LOW');
  }

  // 3) CORRELATION — INFORMATIONAL ONLY. Never caps, never blocks.
  // Stacking onto existing exposure is a fact about his book that he should SEE, and then decide
  // about himself. It says nothing about whether the setup in front of him is any good, so it no
  // longer touches the conviction band or refuses the idea.
  const corr = correlationCheck(i, ctx.exposure);
  a.correlation = corr;
  if (corr.stacked.length) {
    const desc = (rows) => rows.map((x) => `${x.side} ${x.ccy} ${x.existing} + ${x.adding} = ${x.combined} lots`).join(', ');
    if (corr.material.length) a.riskNotes.push(`Adds to existing exposure: ${desc(corr.material)}. Your call whether that concentration is acceptable.`);
    else a.riskNotes.push(`Minor overlap with ${desc(corr.stacked)} — small enough to be book residue rather than real concentration.`);
  }

  // 4) MARGIN — the floor is a HARD GATE, but it RESIZES rather than kills.
  // The level itself never caps conviction: how much room his account has is not evidence about
  // the trade. What the floor does control is the SIZE, and a size that breaches it is corrected
  // to the largest one that fits, with both numbers shown.
  const est = estMarginUSD(i.pair, i.lots, ctx.rates, ctx.live);
  const projected = ctx.vitalsUsable ? projectedMarginLevel(ctx.vitals, est) : null;
  a.margin = { estUSD: est, projectedPct: projected, floor: MARGIN_FLOOR_PCT, verified: projected != null, requestedLots: num(i.lots) };
  if (projected != null) {
    if (projected < MARGIN_FLOOR_PCT) {
      const fit = maxLotsWithinFloor(i.pair, ctx.vitals, ctx.rates, ctx.live, MARGIN_FLOOR_PCT);
      a.margin.breachedAtRequested = true;
      if (fit != null && fit >= LOT_STEP) {
        // Resize. The idea survives at a size that respects the floor.
        a.margin.resizedTo = fit;
        a.margin.resizedProjectedPct = projectedMarginLevel(ctx.vitals, estMarginUSD(i.pair, fit, ctx.rates, ctx.live));
        a.riskNotes.push(`At ${i.lots} lots this would project ${projected}%, under your ${MARGIN_FLOOR_PCT}% floor — shown resized to ${fit} lots (projects ${a.margin.resizedProjectedPct}%). The setup is unchanged; only the size is.`);
      } else {
        // Nothing tradeable fits. Still not a blocking finding and still not a conviction cap:
        // the idea is sound, his account simply has no room for it right now. Saying that
        // plainly is more useful than hiding the idea and implying there was nothing to find.
        a.margin.noSizeFits = true;
        a.riskNotes.push(`No tradeable size fits your ${MARGIN_FLOOR_PCT}% floor right now — even ${LOT_STEP} lots would breach it. The idea stands; the room does not. Free margin first if you want it.`);
      }
    } else if (a.margin.requestedLots != null) {
      a.margin.headroomLots = maxLotsWithinFloor(i.pair, ctx.vitals, ctx.rates, ctx.live, MARGIN_FLOOR_PCT);
    }
  } else {
    // Unverifiable margin is a gap in what we know about HIS ACCOUNT, not about the trade, so it
    // is stated and no longer caps the conviction band.
    const why = !ctx.vitals ? 'no account vitals synced yet'
      : (ctx.vAge && !ctx.vAge.fresh) ? `vitals are stale (${ctx.vAge.label})`
      : est == null ? 'could not price this pair to estimate margin'
      : 'equity missing from vitals';
    a.riskNotes.push(`Margin impact UNVERIFIED: ${why}. Size this one yourself.`);
  }

  // 5) RED FOLDER — an imminent high-impact print on either leg
  const rf = redFolderImminent(ctx.cal, i.pair, RED_FOLDER_GUARD_MIN, nowMs);
  if (rf) {
    a.redFolder = rf;
    const declared = !!(i.catalyst && String(i.catalyst.stance || '').toUpperCase() !== 'NONE'
      && resolveCatalyst(i.catalyst, [rf], i.pair));
    if (!declared) {
      a.blocking.push(`${i.pair} walks blind into ${rf.ccy} ${rf.title} at ${rf.when} (High impact, inside ${RED_FOLDER_GUARD_MIN}min) without naming it as the catalyst`);
    } else {
      a.warnings.push(`Positioned across ${rf.ccy} ${rf.title} at ${rf.when} — a High-impact print inside the hour. The direction of that print is not knowable.`);
      capTo('MED');
    }
  }

  // 6) CATALYST resolution — verify the claim against the calendar we actually supplied
  const stance = String((i.catalyst && i.catalyst.stance) || 'NONE').toUpperCase();
  if (stance !== 'NONE') {
    const real = resolveCatalyst(i.catalyst, ctx.cal, i.pair);
    if (!real) {
      a.warnings.push(`Catalyst "${(i.catalyst && i.catalyst.event) || '?'}" does not match any High/Medium event on this pair's currencies in the calendar. Treat the event anchor as unverified.`);
      capTo('MED');
    } else {
      const hoursOut = (real.utc - nowMs) / 3600e3;
      a.catalyst = { event: real.title, ccy: real.ccy, when: real.when, utc: real.utc, impact: real.impact, stance, hoursOut: +hoursOut.toFixed(1), insideWindow: hoursOut <= HORIZON.ceilingHours };
      if (!a.catalyst.insideWindow) {
        a.warnings.push(`Catalyst ${real.title} lands in ${Math.round(hoursOut)}h, past this trade's ${HORIZON.ceilingDays}-day ceiling — the position would be closed before its own catalyst fires.`);
        capTo('MED');
      }
    }
  }
  return a;
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
  // PATTERN FEEDS (audit finding 9). This was a fixed list of 7 majors + DXY, while the prompt
  // told the model to survey 12 crosses as well — so the crosses were ordered to be considered
  // and given strictly less evidence than the majors, which is a thumb on the scale disguised as
  // breadth. The screen now tells us which pairs are actually worth the request budget, so the
  // feeds FOLLOW THE BOARD: the top-ranked candidates get pattern context whether they are
  // majors or crosses. Falls back to the old fixed list when no board is available, so an
  // unscreened run is no worse than it was before.
  const FALLBACK_PATTERN_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD', 'DXY'];
  // LIVE-PRICE coverage is WIDER (audit finding 4): the prompt surveys crosses too, so they
  // must get live prices + ATR, not just the daily ECB fallback. These are batched Yahoo calls,
  // all verified fetchable, so covering them doesn't balloon the pattern-feed request count.
  // Extended to cover the FULL screened universe: if the board can rank EURNZD or GBPCAD into
  // the top 8, the prompt must be able to price it, or the level validator fails it closed for a
  // pair the desk itself just recommended.
  const PRICE_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD', 'DXY',
    'EURGBP', 'EURJPY', 'GBPJPY', 'EURAUD', 'GBPAUD', 'AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY', 'EURCHF', 'GBPCHF', 'AUDCAD', 'AUDNZD',
    'EURCAD', 'GBPCAD', 'NZDCAD', 'EURNZD', 'GBPNZD'];
  // The board is read FIRST, because it decides which pairs are worth spending pattern-feed
  // requests on. Both reads are additive: a failure degrades the hunt, it does not break it.
  const [screenPack, brainConditions] = await Promise.all([
    rGet('terminal:screen').catch(() => null),
    readBrainConditions().catch(() => null),
  ]);
  const screen = screenAge(screenPack);
  // Used only while genuinely current; past SCREEN_USABLE_MS it is dropped outright rather than
  // quietly aged into the prompt.
  const screenUsable = (screen.state === 'FRESH' || screen.state === 'STALE') && !!screenPack;
  const screenRanked = screenUsable ? (screenPack.ranked || []).filter((r) => !r.alreadyOpen) : [];
  // The consolidation is only honoured if its picks survive the already-open filter — a pair that
  // was opened between the screen running and now is no longer a candidate, however well it read.
  const screenConsolidation = (() => {
    if (!screenUsable || !screenPack.consolidation) return null;
    const c = screenPack.consolidation;
    const picks = (c.picks || []).filter((p) => screenRanked.some((r) => r.pair === normPair(p.pair)));
    return picks.length ? { ...c, picks } : null;
  })();
  // Pattern feeds follow the board when there is one: the top 8 candidates get technical context
  // whether they are majors or crosses, plus DXY for dollar backdrop.
  const PATTERN_PAIRS = screenRanked.length
    ? [...new Set([...screenRanked.slice(0, 8).map((r) => r.pair), 'DXY'])]
    : FALLBACK_PATTERN_PAIRS;

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

  // Shadow book tracking: resolve passed ideas across the idea's own permitted life.
  // Each generation we append today's reference price to the idea's trail, then check
  // whether the TP or SL level was reached by any daily mark within the window.
  // Honest limitation: daily closes only, so a verdict is a well-founded estimate,
  // not a tick-perfect certainty. Labelled as such.
  //
  // HORIZON ALIGNMENT (audit finding 13): this window was a hardcoded 3 days while the generator
  // was building 1-day ideas, so the learning loop graded every idea over three times the life
  // the idea was actually given — and then fed that verdict back into the prompt as guidance.
  // It now derives from the same HORIZON block the generator uses, so an idea is judged over
  // exactly the life it was permitted: propose for 2-3 days, grade at the 4-day ceiling.
  const graded = [];
  const WINDOW_MS = HORIZON.ceilingDays * 86400e3;
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
      rec.shadowVerdict = { grade: moved ? 'SOFT_WIN' : 'SOFT_LOSS', note: `neither level reached inside the ${HORIZON.ceilingDays}d ceiling; graded on final drift`, resolvedOn: t.dmy };
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

  // ---------- SESSION AWARENESS (corrected BKK <-> session mapping) ----------
  // The previous three buckets were factually WRONG at both edges, and the brief confidently
  // asserted the wrong thing to the model. "DAYTIME" began at 11:00 BKK claiming "London
  // liquidity is deep" — London opens 08:00 UTC, which is 15:00 BKK, so for its first four
  // hours that bucket described a market that was shut. "EVENING" was a TWELVE-hour bucket
  // (17:00-05:00 BKK) claiming to sit "around the London/New York overlap" with "US data
  // typically settled by now" — at its 17:00 BKK start that is 10:00 UTC, London mid-morning,
  // and the US data it declared settled had not printed yet (NFP/CPI land 12:30-13:30 UTC,
  // i.e. 19:30-20:30 BKK).
  //
  // Bangkok is UTC+7. The real sessions, converted once, here:
  //   Sydney  22:00-07:00 UTC -> 05:00-14:00 BKK
  //   Tokyo   00:00-09:00 UTC -> 07:00-16:00 BKK
  //   London  08:00-17:00 UTC -> 15:00-00:00 BKK
  //   New York 13:00-22:00 UTC -> 20:00-05:00 BKK
  //   London/NY overlap 13:00-17:00 UTC -> 20:00-24:00 BKK  (the deepest window)
  //   Top-tier US data (NFP, CPI) 12:30-13:30 UTC -> 19:30-20:30 BKK
  const phase = sessionPhase(t.hour);
  const clockStr = `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')} BKK`;
  const sessionBrief =
    phase === 'asian'
      ? `ASIAN SESSION (${clockStr}). Sydney and Tokyo are the live markets; London is SHUT and does not open until 15:00 BKK. Liquidity is thinner, ranges are narrower, and spreads on the European crosses are wider than they will be later. Hunt where the flow genuinely is now: JPY crosses, AUD and NZD (RBA/RBNZ, Chinese data, commodities). You may absolutely build a EUR or GBP idea, but be honest that its catalyst is still hours away and price the entry accordingly rather than pretending Europe is trading.`
      : phase === 'european'
      ? `EUROPEAN SESSION (${clockStr}). London is open and liquidity is deepening; New York has NOT opened yet (20:00 BKK) and the top-tier US releases have NOT printed yet (NFP/CPI land 19:30-20:30 BKK). Hunt EUR, GBP, CHF and the European crosses where the action genuinely is. If US data is due in the next few hours, say explicitly whether the idea is positioned INTO it or clear of it — do not write as though it has already happened.`
      : phase === 'overlap'
      ? `LONDON / NEW YORK OVERLAP (${clockStr}). Both books are open — the deepest, most directional and tightest-spread window of the day, and the one that carries a ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day position best. The main US releases have typically printed by now, so the dollar's reaction is readable rather than pending. Trade the genuine trend of the session; mind any late US release still to come.`
      : `NEW YORK AFTERNOON (${clockStr}). London has closed and New York is running down toward its own close at 05:00 BKK. Liquidity is thinning and late moves here are often position-squaring rather than genuine direction, so treat a sharp move with suspicion. Entries set now will sit through the quiet Asian handover — size the stop for that gap rather than for the range you can see on the screen right now.`;

  const prompt = `You are the ideas engine of THE TERMINAL, the forex desk of a retail trader in Phuket (broker: Phillip MT5). He trades at any hour he chooses, morning, day or evening, whenever opportunity calls. Typical sizing 0.02-0.10 lots. Account is small; capital preservation beats bravado.

${sessionBrief}

${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}

LIVE REFERENCE PRICES + VOLATILITY (anchor EVERY level to these; entries must sit within ~1% of the LIVE price, not at invented round numbers. Where a pair shows a daily ATR, size the stop RELATIVE to it — a ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day stop is typically ~1.5-2.5x the DAILY ATR, because the position must survive two or three sessions of noise, not one. A stop sized for a single day will be taken out by ordinary chop long before the thesis resolves. Do NOT use a hardcoded pip count when a real ATR is shown):
${priceBlock}
IF A PAIR IS NOT PRICED ABOVE, DO NOT PROPOSE IT. Its levels cannot be verified against the market and the desk will refuse them.

Recent AAR verdicts:
${recentAAR || '- none yet'}
Passed-idea shadow grades (his filter vs the engine):
${graded.join('\n') || '- none new'}

SELF-IMPROVEMENT GUIDANCE (distilled from the desk's own tracked track record; APPLY these):
${(s.guidance || []).map((g) => `- ${g.text}${g.basis ? ' [' + g.basis + ']' : ''}`).join('\n') || '- none yet; not enough resolved history to draw conclusions'}

IDEA HISTORY, last 7 days (for freshness, not repetition):
${historyLines}

ECONOMIC CALENDAR — High/Medium impact, grouped BY CURRENCY, covering the full ${HORIZON.ceilingDays}-day hold window and two days beyond it (an event landing just past the ceiling is a reason to plan an earlier exit, so it is shown deliberately), Bangkok times (validated Forex Factory data; these ARE the forex catalysts):
${calByCurrency(cal)}

Tonight's forex news wire (sources that actually delivered this run — ${liveSourceLine(news)}):
${digest(news, 30)}

PATTERN DESK — real trader setups from TradingView, per pair (technical/chart-pattern context to weigh ALONGSIDE the news; these are crowd ideas, not gospel, but they show where technical attention sits):
${patternDigest}
${brainConditions ? `\nMARKET CONDITIONS CROSS-CHECK:\n${brainConditions.line}\n` : ''}
${screenRanked.length ? `OVERNIGHT SCREEN — THE WHOLE BOARD, MEASURED AND INDIVIDUALLY ANALYSED (${screen.label}${screen.state === 'STALE' ? '; treat the numbers as indicative, re-check anything you act on' : ''}).
Every tradeable pair was measured in code on identical factors, and then EACH ONE was given its own dedicated analyst pass — a separate reasoning call that saw only that pair, with its full evidence and the news touching it. ${screenPack.scored} of ${screenPack.universeSize} pairs completed both stages. Pairs already open in the book are excluded.${(screenPack.unscored || []).length ? ` ${screenPack.unscored.length} pair(s) could not be analysed this run (${screenPack.unscored.slice(0, 4).map((u) => u.pair).join(', ')}) — they are absent from the list below, not judged and rejected.` : ''}

THIS IS THE FUNNEL, AND IT HAS ALREADY DONE REAL WORK. These are not bare rankings; each carries an analyst's read:
${screenLines(screenRanked, 0, 8)}
${screenConsolidation ? `
THE DESK HEAD'S CONSOLIDATION — a further pass that read every analyst's verdict and compared the whole field, which no individual analyst could do:
Field quality: ${screenConsolidation.field_quality || 'n/a'}. ${screenConsolidation.field_read || ''}
Selected: ${(screenConsolidation.picks || []).map((p) => `${p.pair} ${p.direction} (${p.conviction}) — ${p.why_this_one}${p.independence ? ` [independence: ${p.independence}]` : ''}`).join('\n          ') || 'none'}
${(screenConsolidation.runners_up || []).length ? `Runners-up: ${screenConsolidation.runners_up.join(' | ')}` : ''}

YOUR JOB IS NOT TO REDO THAT WORK. Build tonight's two proposals around the selected pairs above. What you add is what the overnight pass could NOT have: the LIVE price, the current margin position, tonight's wire, and the imminent calendar. So:
- Re-anchor EVERY level to the live reference prices below. The screen's indicative levels are from screen time and are almost certainly stale by now.
- If live conditions have genuinely invalidated a selection — the move already happened, the catalyst has passed, tonight's wire contradicts it — say so plainly in the thesis and substitute from the runners-up or the ranked list above. That is a legitimate and expected outcome, not a failure.
- If you go outside this list entirely, name explicitly what the wire tells you that the overnight pass could not see. "I preferred a different pair" is not a reason.` : `
No consolidation pass was available this run${screenPack.consolidationError ? ` (${screenPack.consolidationError})` : ''}, so weigh the individual analyst reads above yourself and pick the two best. Re-anchor all levels to the live prices below.`}` : `OVERNIGHT SCREEN: UNAVAILABLE this run (${screen.label}). You are hunting UNSCREENED — there is no measured ranking of the board tonight and no per-pair analysis, so survey the universe yourself as thoroughly as you can and be honest in desk_note that the board was not pre-measured.`}

TASK: Propose exactly 2 INTERDAY ideas: opened now, intended to work over ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} DAYS, with a ${HORIZON.ceilingDays}-day absolute ceiling. This is his actual trading rhythm — he is not a day-trader and does not scalp. Build theses that need two or three sessions to play out and levels with the room to survive that long. Do NOT propose a trade whose whole life is a single session, and do NOT propose one that needs a fortnight.

TRAWL HARD, NEVER SHRUG (critical): Your job is to find the two best genuine opportunities anywhere on the board, and you must always work hard to find them. Before concluding anything, survey the FULL universe of liquid pairs, not just the obvious dollar majors: the majors (EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, NZDUSD, USDCAD) AND the liquid crosses (EURGBP, EURJPY, GBPJPY, EURAUD, AUDJPY, NZDJPY, AUDNZD, CADJPY, CHFJPY, EURCHF, GBPCHF, AUDCAD). Read the whole news wire below, weigh the calendar, consider each session's active markets, and hunt for where genuine opportunity actually is tonight. Rotate your hunting ground across sessions; do not keep returning to the same two pairs. Laziness is not permitted: "nothing to do" is only acceptable AFTER a real search of the whole board, never as a first resort. There is almost always a reasonable setup somewhere in a universe this large.

HONESTY STILL HOLDS: trawling hard means finding the best genuine setups, NOT inflating their conviction. Always surface your two best finds, but rate each one's conviction truthfully (see the conviction rule below). Working hard and rating honestly are both required: relentless effort, honest grading. Rules:

SIZING DOCTRINE (aggressive, margin-bounded):
- Size these as AGGRESSIVELY as the margin arithmetic honestly allows. Do not default to timid clips when headroom is generous; equally, never let bravado outrun the maths. Note a ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day hold ties the margin up for the WHOLE of that window, so the headroom you consume is not returned by tonight's close.
- Account leverage is approximately 1:20 (observed live: 0.10 lots EURUSD consumes ~$570 of margin; scale by notional for other pairs and lot sizes).
- For EACH idea, compute the projected margin level if taken = equity / (current margin in use + estimated new margin) x 100. HARD FLOOR: projected margin level must stay above ${MARGIN_FLOOR_PCT}%. Prefer above ${MARGIN_PREFER_PCT}% if BOTH ideas were taken together. State the projected figure explicitly in sizing_note. THIS IS RECOMPUTED IN CODE FROM THE LIVE VITALS AFTER YOU RESPOND: if your lot size breaches the floor the desk RESIZES it down to the largest size that fits and shows both numbers — the idea is kept, only the size is corrected. So get the arithmetic right, but never drop or weaken an idea because of sizing.
- Account for ACTIVE trades: margin already committed shrinks the honest maximum size. If the book is already heavy, say so in sizing_note and size accordingly.
- FRESHNESS IS MANDATORY: do NOT propose any pair+direction combo from the idea history above that appeared in the last 3 days, unless a specific NEW named catalyst justifies it (name it explicitly in the thesis). Rotate the hunting ground; the market has dozens of pairs.
- NEVER propose a pair that is already open in the book: that is adding, not a fresh idea.
- CORRELATION IS REPORTED, NOT PENALISED. Read the NET CURRENCY EXPOSURE line above. A forex position is TWO currency bets: BUY GBPJPY is long GBP and short JPY, so a trade whose legs push the same way as exposure the book already carries concentrates risk rather than diversifying it. State any such overlap plainly in correlation_note so he can see it — he manages his own exposure and will decide. Do NOT lower an idea's conviction, and do NOT decline to propose it, because it happens to touch a currency he already holds. A genuinely strong setup is still a strong setup on a concentrated book; the concentration is his call, the quality is yours.
- CATALYST (required field): every idea must carry a "catalyst" object. If the thesis is anchored to a scheduled event, name it EXACTLY as it appears in the calendar above, give its Bangkok time, and set stance to TRADE_INTO (deliberately positioned for the event) or POSITION_CLEAR (deliberately sized/timed to avoid it). If the thesis genuinely rests on flow or technicals rather than a scheduled event, set stance NONE and say what the driver is instead — do not invent an event to fill the field. At least ONE of the two ideas must be genuinely event-anchored. Your catalyst claim is matched back against the real calendar in code; an event that is not on it will be flagged.
- YOU MAY NOT WALK BLIND INTO A PRINT. If a High-impact event for either of a pair's currencies lands within the next ${RED_FOLDER_GUARD_MIN} minutes, you must either name that event as the idea's catalyst (stance TRADE_INTO or POSITION_CLEAR) or choose a different pair. This is enforced in code: an unacknowledged imminent print rejects the idea.
- BREVITY, telegram style, zero filler: thesis max 40 words; risks max 25; sizing_note max 25; correlation_note max 15; desk_note max 50 words naming the session's single priority.
- CONVICTION MEASURES THE TRADE, NOT HIS BOOK. Rate conviction on a four-rung scale, LOW, MED, MED-HIGH, HIGH, purely on the QUALITY of the setup: catalyst, trend, structure, level cleanliness, source convergence, event timing. Reserve MED-HIGH and HIGH for genuine convergence. Do NOT inflate conviction to seem useful — but equally, do NOT deflate it because of his margin level, his free margin, or overlap with positions he already holds. Those are facts about his account that the desk reports separately and that he manages himself; they are not evidence about whether this trade is good. A HIGH-quality setup is HIGH even if it would add to his exposure or need sizing down. If the honest read is that nothing tonight clears MED-HIGH on QUALITY, say so in desk_note and mark them at their true lower conviction.
- ${t.isFriday ? `It is FRIDAY. A ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day hold opened now WILL sit through the weekend gap. Either state explicitly that the thesis survives the weekend and size for gap risk, or propose something intended to close before the Friday bell — say which, and do not leave it ambiguous.` : `Respect the ${HORIZON.ceilingDays}-day ceiling.`}
- Estimate margin cost at suggested lots and sanity-check against free margin.
- Prefer R:R of at least 1.5. LEVEL DISCIPLINE (critical, every number is validated after you respond): entry_zone must sit within ~1% of the live reference price. SL and TP on the correct sides (BUY: SL below entry, TP above; SELL: SL above, TP below). Stop distance must be sane for a ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} DAY trade: typically 40-150 pips on majors, never tighter than ~${HORIZON.minStopPips} pips (two days of noise will take it out) nor wider than ~${HORIZON.maxStopPips} pips. Size levels to recent volatility, NOT arbitrary round numbers. Every level must share the pair's order of magnitude (e.g. NZDUSD levels are ~0.56xx, never 1.5xxx). Double-check each number against the live price before finalising.
- Weigh the lessons archive; do not repeat known mistakes.

Respond ONLY with JSON, no markdown:
{"ideas":[{"pair":"EUR/USD","direction":"BUY|SELL","entry_zone":"1.1440-1.1455","tp":"1.1520","sl":"1.1400","lots":"0.05","horizon":"${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day interday","conviction":"LOW|MED|MED-HIGH|HIGH","thesis":"...","catalyst":{"event":"the event title EXACTLY as written in the calendar above, or null if stance is NONE","when":"the Bangkok time exactly as shown in the calendar, e.g. Thu 19:30 BKK, or null","ccy":"which currency the event belongs to","stance":"TRADE_INTO|POSITION_CLEAR|NONE","note":"if stance is NONE, the non-event driver in max 12 words"},"sources":[{"outlet":"the publication name EXACTLY as tagged in the wire above, e.g. ForexLive, FXStreet, ActionForex, Reuters","point":"the specific claim from that outlet that supports this idea"}],"risks":"...","sizing_note":"why THIS lot size: the margin arithmetic, projected margin level if taken, and what capped or freed the size","correlation_note":"how this sits against the NET CURRENCY EXPOSURE above: which legs stack, which are fresh"}],"stand_down":false,"desk_note":"one-paragraph read of the session"}
CONVERGENCE RULE (enforced in code, not just requested): MED-HIGH and HIGH conviction REQUIRE at least TWO sources in the "sources" array from DIFFERENT outlets that both appear in the wire above. An idea that cites fewer than two independent wire outlets will be AUTOMATICALLY DOWNGRADED to at most MED, no matter what conviction you write. So only claim MED-HIGH/HIGH when you can genuinely name two or more different outlets from the wire that converge. Do not invent outlets or cite ones not present above.
Reminder: every price you output is checked against live rates after you respond. An impossible level (wrong magnitude, or SL/TP on the wrong side) will be rejected, so verify each number now.`;

  let ideas = await claude(prompt, 2200);

  // ================= THE GATE =================
  // Assembles the context the gate needs and runs it. The gate itself, and the reasoning behind
  // the blocking/warning split, live at module scope on auditIdeaAgainst() so the safety suite
  // can drive the shipped code directly.
  const exposure = currencyExposure(s.book.positions || []);
  const vAge = vitalsAge(s.book.vitals);
  const vitalsUsable = !!(s.book.vitals && num(s.book.vitals.equity) != null && vAge.fresh);
  const ctx = { banned, openPairs, exposure, vitals: s.book.vitals, vitalsUsable, vAge, rates, live, cal };

  const isDupe = (i) => ideaIsDupe(i, ctx);
  const auditIdea = (i) => auditIdeaAgainst(i, ctx);
  const isBad = (i) => auditIdea(i).blocking.length > 0;

  // RETRY — now a genuine SECOND HUNT, not a second guess (audit finding 10).
  // It used to fire only on a validity failure and re-ask the identical question, so a run that
  // came back thin came back thin twice. Two changes: it also fires when the board is there and
  // NOTHING cleared the conviction bar, and it hands over the NEXT slice of the ranked shortlist
  // — candidates 9-16, pairs the first attempt was never shown. That is only possible because a
  // measured shortlist now exists; without the screen there is no second slice to offer, so the
  // conviction-triggered retry is deliberately gated on having one.
  const clearsBar = (i) => ['MED-HIGH', 'HIGH'].includes((i.conviction || '').toUpperCase());
  const nothingClears = (ideas.ideas || []).length > 0 && !(ideas.ideas || []).some(clearsBar);
  const haveSecondSlice = screenRanked.length > 8;
  const needRetry = (ideas.ideas || []).some(isBad) || (nothingClears && haveSecondSlice);

  if (needRetry) {
    const rejects = (ideas.ideas || []).flatMap((i) => auditIdea(i).blocking);
    const seen = (ideas.ideas || []).map((i) => `${i.pair} ${i.direction}`).join(', ') || 'none';
    const reason = rejects.length
      ? `REJECTED, fix and resubmit two clean ideas. Every reason below is a CODE-ENFORCED gate, not a preference:\n${rejects.map((r) => '- ' + r).join('\n')}`
      : `Your first pass produced nothing above MED conviction (${seen}). That may well be the honest read — but before settling on it, LOOK AT THE REST OF THE BOARD. You were shown the top 8; here are the next candidates you have not considered. If after genuinely weighing these the honest answer is still that nothing clears the bar, say so plainly and return your best two at their true conviction. Do not inflate anything to fill the slot.`;
    try {
      const second = await claude(prompt +
        `\n\n${reason}\n` +
        (haveSecondSlice ? `\nNEXT CANDIDATES FROM THE SCREEN (ranked 9-16, not shown to you above):\n${screenLines(screenRanked, 8, 16)}\n` : '') +
        `\nAlready proposed this run (do not simply repeat them): ${seen}.\nBanned pairs+direction tonight: ${[...banned].map((b) => b.replace('|', ' ')).join(', ') || 'none'}. Open book: ${openPairs.join(', ') || 'none'}. Net currency exposure: ${exposureLine(exposure)}.`, 2200);
      // Accept the retry only if it is clean AND at least as good as what it replaces: a second
      // pass that is merely different must not displace a valid first pass.
      if (second.ideas && second.ideas.length && !second.ideas.some(isBad)) {
        const firstWasBad = (ideas.ideas || []).some(isBad);
        const secondClears = second.ideas.some(clearsBar);
        if (firstWasBad || secondClears) { ideas = second; ideas.fromRetry = true; }
      }
    } catch { /* fall through to flagging */ }
  }

  // Final annotation pass — runs over WHATEVER survived, first attempt or retry, so nothing
  // reaches the screen uninspected. This used to sit inside the failure branch only, meaning a
  // clean first attempt skipped every check but the level one.
  (ideas.ideas || []).forEach((i) => {
    const a = auditIdea(i);
    const lc = a.level;
    if (lc.ok) { i.rr = lc.rr; i.slPips = lc.slPips; i.tpPips = lc.tpPips; }
    else {
      i.level_warning = `LEVELS UNVERIFIED: ${lc.reason}. Do not trade these numbers as-is; confirm on your chart first.`;
      i.conviction = 'LOW';
    }
    if (isDupe(i)) i.correlation_note = ((i.correlation_note || '') + ' REPEAT WARNING: overlaps recent or open exposure.').trim();
    // surface the computed risk facts to the UI rather than leaving them in prose
    i.marginCheck = a.margin;
    i.exposureStack = a.correlation && a.correlation.stacked.length ? a.correlation : null;
    i.catalystResolved = a.catalyst;
    if (a.redFolder) i.redFolder = { title: a.redFolder.title, ccy: a.redFolder.ccy, when: a.redFolder.when, impact: a.redFolder.impact };

    // THE FLOOR RESIZES THE IDEA rather than removing it. Both numbers are kept: `lots` becomes
    // the size that actually fits, `lotsRequested` preserves what the desk originally proposed,
    // so the card can say "at 0.05 breaches your floor; shown at 0.02" instead of silently
    // presenting a different trade than the one that was reasoned about.
    if (a.margin && a.margin.resizedTo != null) {
      i.lotsRequested = i.lots;
      i.lots = String(a.margin.resizedTo);
      i.resized = true;
    }

    // Blocking findings that SURVIVED the retry must be visible, not silently downgraded.
    if (a.blocking.length) {
      i.gate_warning = `GATE: ${a.blocking.join(' | ')}. The desk asked for a replacement and did not get a clean one — treat this idea as unsafe as written.`;
      i.convictionClaimed = i.convictionClaimed || i.conviction; // record what was overridden
      i.conviction = 'LOW';
    }
    // Two separate channels, deliberately not merged: risk_flags are doubts about the TRADE and
    // they cap conviction; risk_notes are facts about HIS BOOK and they never do.
    if (a.warnings.length) i.risk_flags = a.warnings;
    if (a.riskNotes.length) i.risk_notes = a.riskNotes;
    // apply the conviction cap last, so it can only ever lower what the model claimed
    if (a.cap && CONVICTION_RUNG[(i.conviction || '').toUpperCase()] > CONVICTION_RUNG[a.cap]) {
      i.convictionClaimed = i.convictionClaimed || i.conviction;
      i.conviction = a.cap;
      i.conviction_note = [(i.conviction_note || ''), `Capped to ${a.cap} on trade quality: ${a.warnings.join(' ')}`].filter(Boolean).join(' ');
    }
  });

  // COMBINED margin: each idea is individually sized to fit the floor, but they are sized
  // INDEPENDENTLY — two ideas that each fit on their own can breach it together. That is a real
  // arithmetic fact he needs, and no per-idea figure shows it. Computed from the POST-RESIZE
  // sizes, or it would report on trades the desk is no longer proposing.
  if (vitalsUsable) {
    const totalMargin = (ideas.ideas || []).reduce((sum, i) => sum + (estMarginUSD(i.pair, i.lots, rates, live) || 0), 0);
    const combined = projectedMarginLevel(s.book.vitals, totalMargin);
    ideas.marginIfBothTaken = { estUSD: +totalMargin.toFixed(2), projectedPct: combined, floor: MARGIN_FLOOR_PCT, prefer: MARGIN_PREFER_PCT };
    if (combined != null && combined < MARGIN_FLOOR_PCT) {
      ideas.marginWarning = `Each idea is sized to fit your ${MARGIN_FLOOR_PCT}% floor on its own, but taking BOTH would land at ${combined}%. Take one, or size the second down yourself.`;
    } else if (combined != null && combined < MARGIN_PREFER_PCT) {
      ideas.marginWarning = `Taking both leaves the margin level at ${combined}%, under the ${MARGIN_PREFER_PCT}% comfort mark. Workable, but there is little room left for a bad candle.`;
    }
  }
  ideas.exposureBefore = exposure;
  ideas.vitalsAge = vAge;
  // Screen provenance. `usedScreen: false` is as important to record as true: it is how the UI
  // can say "this hunt ran unscreened" instead of presenting a degraded run as a normal one.
  ideas.screen = {
    state: screen.state, label: screen.label, usedScreen: screenRanked.length > 0,
    at: screenPack ? screenPack.at : null,
    universeSize: screenPack ? screenPack.universeSize : null,
    scored: screenPack ? screenPack.scored : null,
    shownTop: screenRanked.slice(0, 8).map((r) => ({ pair: r.pair, score: r.score, dir: (r.llm && r.llm.direction) || r.preferredDirection, read: r.llm ? r.llm.read : null })),
    perPairAnalysed: screenRanked.filter((r) => !!r.llm).length,
    unanalysed: (screenUsable && screenPack.unscored ? screenPack.unscored : []).map((u) => ({ pair: u.pair, reason: u.unscored })),
    consolidation: screenConsolidation ? { picks: screenConsolidation.picks, field_quality: screenConsolidation.field_quality, field_read: screenConsolidation.field_read } : null,
    consolidationError: screenUsable ? (screenPack.consolidationError || null) : null,
    // Did the ideas actually come from the shortlist, or did the model go off-board? Recorded
    // so it can be reviewed rather than assumed.
    offBoard: (ideas.ideas || []).map((i) => normPair(i.pair)).filter((p) => !screenRanked.slice(0, 16).some((r) => r.pair === p)),
  };
  if (brainConditions) ideas.brainConditions = { live: brainConditions.live, flat: brainConditions.flat, directional: brainConditions.directional };
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
  // gate_warning must disqualify as firmly as level_warning does: both mean a code-enforced
  // check failed and the retry did not produce a clean replacement. Belt and braces — the gate
  // already forces conviction to LOW in that case, so this is a second lock on the same door
  // rather than the only one.
  (ideas.ideas || []).forEach((i) => { i.qualifies = clears(i.conviction) && !i.level_warning && !i.gate_warning; });
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
        proposedHorizon: takenMatch ? (takenMatch.idea.horizon || HORIZON.label) : undefined,
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
      if (isLongTerm) tag = ' [LONG-TERM HOLD: judge on the durable multi-week thesis and higher-timeframe trend, NOT day-to-day noise; only mark BROKEN on a real structural break].';
      else if (fromDesk && hoursOpen != null && hoursOpen < HORIZON.freshHours) tag = ` [FRESH DESK-PROPOSED TRADE, opened ${hoursOpen < 1 ? Math.round(hoursOpen * 60) + 'min' : hoursOpen < 36 ? hoursOpen.toFixed(1) + 'h' : (hoursOpen / 24).toFixed(1) + 'd'} ago, early in its ${p.proposedHorizon || HORIZON.label} horizon — a trade on this horizon is SUPPOSED to sit through adverse sessions, so do NOT flip to BROKEN on ordinary noise or a modest adverse move; mark BROKEN only if the specific catalyst it was built on has genuinely reversed or a written invalidation level has actually triggered].`;
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

For EACH open position, decide a thesis status: HOLDING (original reasoning intact, stay the course), WOBBLING (thesis under strain, watch closely, be ready to act), or BROKEN (the reason for the trade no longer applies, actively consider closing). Ground the verdict in the fresh news, the calendar and the price move since entry. CALIBRATE TO HORIZON: a position tagged FRESH DESK-PROPOSED must not be flipped to BROKEN on ordinary noise minutes after the desk itself proposed it, and a LONG-TERM HOLD must be judged on its durable multi-week thesis, not a single session's wobble. A position inside its ${HORIZON.label} life is EXPECTED to ride out adverse sessions — that is the horizon working, not the thesis breaking. For off-book positions, first infer the likely thesis in one clause, then judge it the same way.

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
    proposedHorizon: rec?.idea?.horizon || HORIZON.label,
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

  // ---- horizon-aware, self-aware framing ----
  // Three bands, and they must TILE THE WHOLE TIMELINE with no gap between them. They did not:
  // the fresh-trade branch expired at 20h and the overstay test did not begin until 26h, so a
  // trade between those two ages fell into the neutral branch while that branch's text still
  // described the horizon as "one-day, close within 24h" — it read as overdue precisely because
  // the numbers around it had been recalibrated and it had not (audit finding 14).
  //
  // Now derived from HORIZON and contiguous by construction:
  //   0 .. freshHours (48h)            -> desk-proposed and still early; burden on CLOSE
  //   freshHours .. ceilingHours (96h) -> working through its intended 2-3 day life; neutral
  //   > ceilingHours                   -> genuinely overstayed; burden on KEEP
  let lifeFrame, ruleFrame;
  if (isLongTerm) {
    lifeFrame = `This is a LONG-TERM position (horizon: ${p.proposedHorizon || 'long-term hold'}), held ${held} day(s). It is NOT exempt from scrutiny; it needs a genuine review, just conducted through a LONG-TERM lens rather than a short-term trade's twitchiness. Do real work here: (a) PATTERN: read the higher-timeframe price action and trend (weekly/daily structure, key support/resistance, whether the broader move is still intact or turning). (b) NEWS: weigh the durable, structural developments that bear on a multi-week/multi-month thesis, not a fleeting intraday risk-off spike. (c) LEVELS: check whether the current SL (${p.sl || 'none'}) and TP (${p.tp || 'none'}) still make sense at the present price, or should be revised for a long-term hold. (d) DURATION: if keeping, say concretely HOW MUCH LONGER to hold and toward what (a level, a catalyst, a timeframe).`;
    ruleFrame = `RULES: Judge on the durable long-term thesis and the higher-timeframe pattern, not day-to-day noise. Default to KEEP unless that long-term thesis has genuinely broken (a structural macro shift, a higher-timeframe trend reversal, a fundamental change) OR the levels/pattern now argue the position no longer makes sense. A temporary drawdown or a short-lived news spike is not itself a close signal. But DO give an honest, substantive verdict: if the long-term picture has soured, say CLOSE plainly. When you KEEP, you MUST provide a revised thesis, sensible revised or confirmed SL/TP levels, and a concrete answer on how much longer to hold.`;
  } else if (fromDesk && hoursOpen != null && hoursOpen < HORIZON.freshHours) {
    lifeFrame = `IMPORTANT: THE DESK ITSELF PROPOSED THIS TRADE and it was opened only ${hoursOpen < 1 ? Math.round(hoursOpen * 60) + ' minutes' : hoursOpen < 36 ? hoursOpen.toFixed(1) + ' hours' : (hoursOpen / 24).toFixed(1) + ' days'} ago, well inside its proposed ${p.proposedHorizon || `${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day interday`} horizon. It has NOT overstayed; it is still in the early part of its intended life. A ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day trade is SUPPOSED to sit through adverse sessions — that is the horizon working, not the thesis failing. Do NOT contradict the desk's own recent proposal on ordinary noise or a modest adverse move. Give the trade the room its horizon allows.`;
    ruleFrame = `RULES: Because this is a desk-proposed trade still early in its horizon, the burden of proof sits firmly on CLOSE. Default to KEEP. Recommend CLOSE ONLY if a genuine, specific, checkable event has BROKEN the original thesis since entry (e.g. the exact catalyst the trade was built on has now reversed, or a hard invalidation level written into the thesis has actually triggered). A floating loss, general risk-off tone, or "might drift" is NOT grounds to close a trade inside its intended ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day life. If the thesis is intact, KEEP and simply restate it.`;
  } else if (hoursOpen != null && hoursOpen <= HORIZON.ceilingHours) {
    // The band that used to be a gap: past the fresh window, still inside the intended life.
    const daysIn = (hoursOpen / 24).toFixed(1);
    lifeFrame = `Position held ${daysIn} days (proposed horizon: ${p.proposedHorizon || `${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day interday`}). This is WORKING THROUGH its intended life — not fresh, not overdue. It is at the stage where the thesis should be starting to pay, so this is a genuine checkpoint rather than either a rubber stamp or an eviction notice.`;
    ruleFrame = `RULES: Judge this one even-handedly — neither branch's thumb on the scale. The trade has had time to start working, so ask honestly whether it IS working: has the catalyst played out, is price responding to the thesis, is the original reasoning still visible in the tape? KEEP if the thesis is alive and has room left inside the ${HORIZON.ceilingDays}-day ceiling; CLOSE if it has simply failed to do anything while the clock ran down, or the reasoning has quietly stopped applying. Do not demand a fresh trade's certainty, and do not grant an overstayed one's indulgence.`;
  } else {
    const overstayed = hoursOpen != null && hoursOpen > HORIZON.ceilingHours;
    lifeFrame = `Position held ${held} day(s) (proposed horizon was: ${p.proposedHorizon || `${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day interday`}${overstayed ? `, so this position HAS overstayed its intended ${HORIZON.targetDaysMin}-${HORIZON.targetDaysMax} day life and is past the ${HORIZON.ceilingDays}-day ceiling` : ', held-time unknown, so judge it on the evidence rather than the clock'}).`;
    ruleFrame = `RULES: The burden of proof sits on KEEP. A KEEP requires specific, current, checkable evidence the thesis is alive, plus a brand-new present-tense thesis, revised horizon and levels. "Price might come back" is a prayer, not a thesis; for a trade past its ${HORIZON.ceilingDays}-day ceiling, default to CLOSE. Weigh margin real estate: a not-quite-wrong position can still deserve closing on opportunity-cost grounds, and on this account that margin is needed elsewhere.`;
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

// ---- Vercel function configuration ----
// THIS FILE HAD NO DECLARED TIMEOUT (audit finding 4). It was the only engine in the repo
// without one — trawl.js declares 300, propose.js 120, odds2.js 45, forex-brain.js 300 via
// vercel.json — and it is by some distance the heaviest. A single actIdeas() call makes ~34 RSS
// fetches, 26 Yahoo chart calls, 8 TradingView feeds, the Forex Factory calendar, frankfurter,
// and then up to FOUR sequential Claude calls (ideas, the retry, the market lesson, the
// reflection), all synchronously inside one user-facing request. That ran on whatever the
// platform default happened to be, with nothing in the repo bounding it.
//
// stewards.js:2245 documents this exact failure biting before, from both directions: a client
// waiting on a leash for a cap that did not exist, and functions silently running on the
// platform default after their vercel.json entries were removed. The lesson recorded there is
// that the duration belongs next to the code it bounds, with no second place to check — so it
// is declared here rather than in vercel.json, matching trawl/propose/odds2.
//
// 300s matches forex-brain, the other engine doing a comparable fan-out of network work.
// NOTE the bodyParser limit must stay in this export regardless: it has no vercel.json
// equivalent, which is why this file could not simply be handed over to that config block.
export const config = { maxDuration: 300, api: { bodyParser: { sizeLimit: '8mb' } } };
