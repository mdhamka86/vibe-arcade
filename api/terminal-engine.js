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
const ageFlag = (d) => (d >= 5 ? 'RED' : d >= 3 ? 'AMBER' : d >= 2 ? 'NOTE' : 'OK');

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

// ---------- Reference FX rates (frankfurter.dev, ECB daily, no key) ----------
async function refRates() {
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY,CHF,AUD,NZD,CAD');
    const j = await r.json();
    const inv = (x) => (x ? +(1 / x).toFixed(5) : null);
    return {
      asOf: j.date,
      EURUSD: inv(j.rates.EUR), GBPUSD: inv(j.rates.GBP),
      USDJPY: j.rates.JPY, USDCHF: j.rates.CHF,
      AUDUSD: inv(j.rates.AUD), NZDUSD: inv(j.rates.NZD), USDCAD: j.rates.CAD,
    };
  } catch { return null; }
}

// ---------- State ----------
async function loadAll() {
  const [book, lessons, ledger] = await Promise.all([
    rGet('terminal:book'), rGet('terminal:lessons'), rGet('terminal:ledger'),
  ]);
  return {
    book: book || { positions: [], pendingAAR: [], vitals: null, vitalsHistory: [] },
    lessons: lessons || [],
    ledger: ledger || [], // ideas offered/taken/passed + completed AARs
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
Account vitals: ${vitals ? `balance ${vitals.balance}, equity ${vitals.equity}, free margin ${vitals.freeMargin ?? 'n/a'}, margin level ${vitals.marginLevel}%` : 'not yet synced'}
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
  return { clock: t, book: bookView(s.book), lessons: s.lessons, ledger: s.ledger.slice(-60), ideasToday: ideas };
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

  // grade any passed ideas older than a day (direction-only, ECB daily granularity)
  const graded = [];
  for (const rec of s.ledger) {
    if (rec.status === 'passed' && !rec.passedEval && rates && rates[rec.idea.pair.replace('/', '')]) {
      const nowPx = rates[rec.idea.pair.replace('/', '')];
      const ref = parseFloat(rec.idea.entry_zone) || null;
      if (ref && Date.now() - rec.ts > 86400000) {
        const moved = rec.idea.direction === 'BUY' ? nowPx > ref : nowPx < ref;
        rec.passedEval = { grade: moved ? 'WOULD_BE_GREEN' : 'WOULD_BE_RED', refPx: nowPx, note: 'direction-only, daily ref rate' };
        graded.push(`${rec.idea.pair} ${rec.idea.direction} (passed ${rec.date}): ${rec.passedEval.grade}`);
      }
    }
  }

  const recentAAR = s.ledger.filter((r) => r.aar).slice(-6)
    .map((r) => `${r.idea?.pair || r.close?.pair} ${r.aar.bucket}: ${r.aar.headline}`).join('\n');

  const prompt = `You are the ideas engine of THE TERMINAL, the nightly forex desk of a retail trader in Phuket (broker: Phillip MT5). He trades the 21:20 Bangkok session, inside the London/NY overlap. Typical sizing 0.02-0.10 lots. Account is small; capital preservation beats bravado.

${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}

Recent AAR verdicts:
${recentAAR || '- none yet'}
Passed-idea shadow grades (his filter vs the engine):
${graded.join('\n') || '- none new'}

IDEA HISTORY, last 7 days (for freshness, not repetition):
${historyLines}

ECONOMIC CALENDAR, next 48h, High/Medium impact, Bangkok times (validated Forex Factory data):
${calLines(cal)}

Tonight's forex news wire (multi-source: ForexLive, FXStreet, ActionForex, Myfxbook, DailyForex, central bank feed, Google News):
${digest(news, 20)}

TASK: Propose exactly 2 short-term ideas (intraday to 48h max). Be genuinely critical: if conditions are poor, low conviction is honest and stand_down may be true (still show the 2 best candidates, marked LOW). Rules:
- FRESHNESS IS MANDATORY: do NOT propose any pair+direction combo from the idea history above that appeared in the last 3 days, unless a specific NEW named catalyst justifies it (name it explicitly in the thesis). Rotate the hunting ground; the market has dozens of pairs.
- NEVER propose a pair that is already open in the book: that is adding, not a fresh idea.
- Anchor at least one idea to the calendar above: trade the setup around a specific scheduled event, or explicitly position clear of it, and say which.
- Never duplicate or heavily correlate with open book exposure; if any correlation exists, state it in correlation_note.
- ${t.isFriday ? 'It is FRIDAY: intraday-only ideas, nothing planned to hold over the weekend gap.' : 'Respect the 48h horizon.'}
- Estimate margin cost at suggested lots and sanity-check against free margin.
- Prefer R:R of at least 1.5. State entry zone, hard TP and SL levels.
- Weigh the lessons archive; do not repeat known mistakes.

Respond ONLY with JSON, no markdown:
{"ideas":[{"pair":"EUR/USD","direction":"BUY|SELL","entry_zone":"1.1440-1.1455","tp":"1.1520","sl":"1.1400","lots":"0.05","horizon":"intraday-48h","conviction":"LOW|MED|HIGH","thesis":"...","risks":"...","margin_note":"...","correlation_note":"..."}],"stand_down":false,"desk_note":"one-paragraph read of the session"}`;

  let ideas = await claude(prompt, 2200);

  // hard freshness check: one retry if the model repeated recent or open exposure
  const isDupe = (i) => banned.has(normPair(i.pair) + '|' + i.direction) || openPairs.includes(normPair(i.pair));
  if ((ideas.ideas || []).some(isDupe)) {
    try {
      const second = await claude(prompt +
        `\n\nREJECTED: your previous attempt repeated recently-offered or currently-open exposure. Banned tonight: ${[...banned].map((b) => b.replace('|', ' ')).join(', ') || 'none'}. Open book pairs: ${openPairs.join(', ') || 'none'}. Produce two genuinely DIFFERENT ideas.`, 2200);
      if (!(second.ideas || []).some(isDupe)) ideas = second;
      else (ideas.ideas || []).forEach((i) => { if (isDupe(i)) i.correlation_note = ((i.correlation_note || '') + ' REPEAT WARNING: overlaps recent or open exposure; treat with extra scepticism.').trim(); });
    } catch { /* keep first attempt with warnings below */ }
    (ideas.ideas || []).forEach((i) => { if (isDupe(i)) i.correlation_note = ((i.correlation_note || '') + ' REPEAT WARNING: overlaps recent or open exposure.').trim(); });
  }
  ideas.generatedAt = t.iso;
  ideas.dateKey = t.dateKey;
  await rSet(key, ideas);

  // log offered ideas into ledger (replacing any same-day offers not yet acted on,
  // so a force-regenerate never double-counts the shadow book)
  s.ledger = s.ledger.filter((r) => !(r.status === 'offered' && r.dateKey === t.dateKey));
  for (const idea of ideas.ideas || []) {
    s.ledger.push({ id: `idea_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), date: t.dmy, dateKey: t.dateKey, status: 'offered', idea });
  }
  await rSet('terminal:ledger', s.ledger.slice(-400));
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
    morningNote = await claude(`You are THE TERMINAL's morning desk note writer.
${deskContext(t, s.book, s.lessons, s.book.vitals, rates)}
Closures detected this sync: ${report.closedDetected.map((c) => `${c.position.pair} ${c.position.direction} ${c.close ? `closed ${c.close.profit >= 0 ? '+' : ''}${c.close.profit}` : 'closed, awaiting history screenshot'}`).join('; ') || 'none'}
TODAY'S ECONOMIC CALENDAR, High/Medium impact, Bangkok times (validated Forex Factory data, do not invent events beyond it):
${calLines(cal)}
Fresh wire:\n${digest(news, 14)}
Write a tight morning briefing. JSON only: {"headline":"one line","lines":[{"pair":"...","read":"1-2 sentences on how overnight news touches this position"}],"calendar_watch":"the specific landmines from the calendar above that matter to the open book and tonight's session, with their Bangkok times","overall":"2-3 sentences"}`, 1400);
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
    s.lessons.push({ text: aar.lesson, date: t.dmy, pair: c.position.pair });
    s.lessons = s.lessons.slice(-40);
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

Position under review: ${p.pair} ${p.direction} ${p.lots} lots @ ${p.entry}, SL ${p.sl || 'none'}, TP ${p.tp || 'none'}, floating ${p.floating ?? '?'}, held ${held} days (intended horizon was 48h max).
Original thesis: ${p.thesis || 'none on record'}
Opportunity cost: ${marginShare}; a stale position blocks proper sizing of fresh ideas.
UPCOMING CALENDAR for this pair's currencies, Bangkok times (validated Forex Factory data):
${pairCal}
Fresh wire:\n${digest(news, 16)}

RULES: The burden of proof sits on KEEP. A KEEP requires specific, current, checkable evidence the thesis is alive, plus a brand-new present-tense thesis, revised horizon and levels. "Price might come back" is a prayer, not a thesis; default to CLOSE. Weigh margin real estate: a not-quite-wrong position can still deserve closing on opportunity-cost grounds.

JSON only: {"verdict":"KEEP|CLOSE","reason":"2-3 sentences","evidence":["specific current evidence items"],"new_thesis":"required if KEEP","new_horizon":"required if KEEP","suggested_levels":"optional revised SL/TP","margin_note":"..."}`, 1600);

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
