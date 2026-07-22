// api/exchange-scout.js
// THE EXCHANGE — the overnight candidate scout (Stage 2, 22/07/2026).
//
// WHY THIS EXISTS. actIdeas had no candidate universe at all. It read 28 headline titles —
// mostly about names he ALREADY HOLDS, which rule 8 then bans from proposal — and
// free-associated two tickers out of them. Nothing enumerated, screened or ranked anything,
// so "breadth" was whatever the model happened to recall. The racing side solved the same
// problem years earlier: enumerate the full field overnight on a cron, enrich it, cache the
// pack, and let the user-facing request just READ. This is that pattern for equities.
//
// It cannot live inside actIdeas. That request already measures ~41s against a 120s ceiling,
// and screening 399 names needs ~20 batched feed calls on its own. So the work moves here,
// behind a cron, and the hunt reads one small blob.
//
// STAGES (idempotent — a rerun only improves the pack):
//   universe  -> load the committed seed, classify every name
//   screen    -> batched price series -> momentum, trend, stretch, realised weekly vol
//   catalysts -> US earnings calendar (dated) + Asian news matches (already-underway)
//   rank      -> score, exclude, and cut to a shortlist
//   write     -> exchange:candidates:<date>
//
// TWO-TIER SWEEP (the agreed shape). A full 399-name sweep is ~20 feed requests; doing that
// daily against an undocumented endpoint is more exposure than it is worth. So: a FULL sweep
// weekly (Sunday), and on other days a refresh of only the standing shortlist plus anything
// carrying a catalyst — roughly 12 requests. Scores for names not re-screened are carried
// forward from the last full sweep and marked stale, never silently presented as fresh.
//
// Actions:
//   GET/POST ?action=run[&stage=all|universe|screen|catalysts|rank][&full=1]
//   GET      ?action=pack[&date=YYYY-MM-DD]   -> latest candidate pack
//   POST     ?action=refresh                  -> re-validate the seed against the live feed
//
// Cron (vercel.json): ?action=run&stage=all daily at 22:00 UTC (05:00 ICT) — after the US
// close and before the Tokyo open, so the pack is fresh for his whole trading day.

import universeSeed from './exchange-universe.json' with { type: 'json' };
import { classifyTicker, SUPPORTED } from './market-classifier.js';
import { getEarningsDates } from './quote-provider.js';
import { getNews } from './exchange-news.js';

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

// Measured 22/07/2026: the quote feed accepts at most 20 symbols per request — 21 returns
// HTTP 400. Every batching decision in this file follows from that one number.
export const BATCH = 20;
const SHORTLIST_SIZE = 40;      // what the hunt actually sees
const DAILY_REFRESH_SIZE = 200; // tier-2 names re-screened on a non-sweep day
const CONCURRENCY = 4;          // polite against an undocumented endpoint

// ---------- Redis ----------
async function rGet(key) {
  const r = await fetch(`${R_URL}/get/${key}`, { headers: { Authorization: `Bearer ${R_TOK}` } });
  if (!r.ok) throw new Error(`Storage read failed (${r.status}).`);
  const j = await r.json();
  if (j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}
async function rSet(key, val) {
  const r = await fetch(`${R_URL}/set/${key}`, {
    method: 'POST', headers: { Authorization: `Bearer ${R_TOK}` }, body: JSON.stringify(val),
  });
  if (!r.ok) throw new Error(`Storage write failed (${r.status}).`);
  return true;
}

function bkkDateKey(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const g = (t) => p.find((x) => x.type === t)?.value || '';
  return { dateKey: `${g('year')}-${g('month')}-${g('day')}`, weekday: g('weekday') };
}
const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Stage 1: universe ----------
// The seed is committed reference data, exactly like charter-seed.json on the racing side:
// index membership shifts a few times a year, and there is no free licensed constituent API
// for the Asian boards, so a validated static list beats anything scraped in the hot path.
export function loadUniverse() {
  const out = [];
  for (const [market, rows] of Object.entries(universeSeed.markets || {})) {
    if (!SUPPORTED.includes(market)) continue;
    for (const [code, name, sector] of rows) {
      // trustHint: the seed's market column is curated reference data, validated against the
      // live feed before it was committed — not a model's guess. Without it the classifier
      // (correctly) refuses SGX codes whose shape collides with US or HK conventions.
      const cls = classifyTicker(code, market, { trustHint: true });
      // A seed entry the classifier cannot resolve would be unpriceable downstream anyway,
      // so it is dropped HERE rather than becoming a silent hole in the pack.
      if (!cls.ok) continue;
      out.push({
        code, name, sector, market,
        sym: cls.yahooSymbol,
        currency: cls.currency,
      });
    }
  }
  return out;
}

// ---------- Stage 2: screen ----------
async function fetchSeries(syms) {
  const qs = `symbols=${encodeURIComponent(syms.join(','))}&range=3mo&interval=1d`;
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v7/finance/spark?${qs}`,
        { headers: { Accept: 'application/json', 'User-Agent': UA } });
      if (!r.ok) continue;
      const j = await r.json();
      const rows = j?.spark?.result;
      if (!Array.isArray(rows)) continue;
      const out = {};
      for (const row of rows) {
        const resp = row?.response?.[0];
        const closes = (resp?.indicators?.quote?.[0]?.close || []).filter((c) => typeof c === 'number' && c > 0);
        if (closes.length >= 10) {
          out[String(resp.meta.symbol).toUpperCase()] = { closes, currency: resp.meta.currency || null };
        }
      }
      if (Object.keys(out).length) return out;
    } catch { /* try the next host */ }
  }
  return {};
}

// Price-derived signals, computed identically for every market because they come from one
// series source. This is the whole reason the screen can cover Tokyo and Singapore at all:
// Massive would have been US-only, and its free tier serves a single previous bar.
export function signalsFrom(closes) {
  if (!closes || closes.length < 10) return null;
  const last = closes[closes.length - 1];
  const at = (n) => closes[Math.max(0, closes.length - 1 - n)];
  const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mu = mean(rets);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, rets.length - 1));
  const weeklyVolPct = isFinite(sd) && sd > 0 ? +(sd * Math.sqrt(5) * 100).toFixed(2) : null;

  const sma20 = closes.length >= 20 ? mean(closes.slice(-20)) : null;
  const sma50 = closes.length >= 50 ? mean(closes.slice(-50)) : null;
  const win = closes.slice(-60);
  const hi = Math.max(...win), lo = Math.min(...win);

  return {
    last: +last.toFixed(4),
    ret1w: pct(last, at(5)) != null ? +pct(last, at(5)).toFixed(2) : null,
    ret1m: pct(last, at(21)) != null ? +pct(last, at(21)).toFixed(2) : null,
    vsSma20: sma20 ? +pct(last, sma20).toFixed(2) : null,
    vsSma50: sma50 ? +pct(last, sma50).toFixed(2) : null,
    // where it sits in its own 60-day range: 0 = at the low, 100 = at the high
    stretch: hi > lo ? +(((last - lo) / (hi - lo)) * 100).toFixed(1) : null,
    weeklyVolPct,
    bars: closes.length,
  };
}

async function screen(names) {
  const out = {};
  const batches = [];
  for (let i = 0; i < names.length; i += BATCH) batches.push(names.slice(i, i + BATCH));
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    const got = await Promise.all(slice.map((b) => fetchSeries(b.map((n) => n.sym))));
    slice.forEach((batch, bi) => {
      const map = got[bi] || {};
      for (const n of batch) {
        const s = map[n.sym.toUpperCase()];
        if (s) out[n.code] = { ...signalsFrom(s.closes), currency: s.currency || n.currency };
      }
    });
    if (i + CONCURRENCY < batches.length) await sleep(200);
  }
  return out;
}

// ---------- Stage 3: catalysts ----------
// Two sources, matching what each market can actually supply for free:
//   US    -> Finnhub's earnings calendar, a genuinely DATED forward event.
//   Asia  -> the news wire. A dated headline naming the company IS the "already underway"
//            catalyst class the engine's gate accepts (up to 5 days behind). There is no
//            free Asian earnings calendar, and rather than pretend otherwise this marks
//            such catalysts newsDerived:true so the card can say the date is unverified.
async function catalysts(names, dateKey) {
  const found = {};

  const usNames = names.filter((n) => n.market === 'US');
  if (usNames.length) {
    // The calendar is queried per symbol in quote-provider; batch it in slices so a big
    // universe cannot spend the whole minute's rate budget at once.
    for (let i = 0; i < usNames.length; i += 25) {
      const slice = usNames.slice(i, i + 25);
      const map = await getEarningsDates(
        slice.map((n) => ({ ticker: n.code, exchange: 'NASDAQ' })),
        dateKey, addDays(dateKey, 10),
      ).catch(() => ({}));
      for (const n of slice) {
        const e = map[n.code.toUpperCase()];
        if (e && e.date) found[n.code] = { type: 'EARNINGS', date: e.date, text: `Scheduled earnings on ${e.date}`, verified: true, newsDerived: false };
      }
      if (i + 25 < usNames.length) await sleep(1100); // stay under 60/min
    }
  }

  // News-derived, all markets. Matching on company NAME rather than ticker: an SGX code like
  // C6L never appears in a headline, but "Singapore Airlines" does.
  let wire = [];
  try { wire = await getNews('market'); } catch { wire = []; }
  for (const n of names) {
    if (found[n.code]) continue; // a dated calendar event outranks a headline
    const hit = wire.find((it) => nameMatchesStory(n.name, `${it.title || ''} ${it.desc || ''}`));
    if (hit) {
      const when = hit.ts ? new Date(hit.ts).toISOString().slice(0, 10) : dateKey;
      found[n.code] = {
        type: 'NEWS', date: when, text: String(hit.title || '').slice(0, 120),
        source: hit.source || null, verified: false, newsDerived: true,
      };
    }
  }
  return found;
}

// Corporate furniture that carries no identifying information.
const SUFFIXES = new Set(['corp', 'corporation', 'inc', 'incorporated', 'ltd', 'limited', 'plc', 'co',
  'company', 'holdings', 'holding', 'group', 'bhd', 'berhad', 'reit', 'trust', 'sa', 'ag', 'nv', 'the']);
// Words common enough that a match on them alone means nothing. "ENN Energy" matching a
// story about "X Energy" is not a catalyst, it is a coincidence.
const GENERIC = new Set(['energy', 'motor', 'motors', 'bank', 'banking', 'financial', 'finance', 'technology',
  'technologies', 'industries', 'industrial', 'electric', 'electronics', 'chemical', 'chemicals', 'steel',
  'power', 'gas', 'oil', 'mining', 'pharma', 'pharmaceutical', 'pharmaceuticals', 'biosciences', 'health',
  'healthcare', 'medical', 'insurance', 'securities', 'capital', 'investment', 'investments', 'properties',
  'property', 'development', 'developments', 'construction', 'engineering', 'airlines', 'airways', 'air',
  'telecom', 'telecommunications', 'communications', 'media', 'retail', 'foods', 'food', 'beverage',
  'international', 'national', 'general', 'united', 'american', 'china', 'chinese', 'japan', 'japanese',
  'singapore', 'malaysia', 'malaysian', 'hong', 'kong', 'asia', 'asian', 'pacific', 'global', 'world',
  'first', 'new', 'sun', 'star', 'city', 'land', 'life', 'home', 'auto', 'digital', 'data', 'systems',
  'solutions', 'services', 'products', 'materials', 'resources', 'partners', 'enterprise', 'enterprises']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// FALSE-CATALYST GUARD (22/07/2026). The first version of this matched substrings against
// the first word over three letters, and production immediately produced nonsense: ENN
// Energy matched a story about "X Energy" purely on the word energy, and Disco Corp matched
// a Capital One story because "disco" is a substring of "Discover". A fabricated catalyst is
// worse than none — it inflates the name's rank AND can be handed to the model as evidence.
//
// So: strip corporate furniture, then require either the full remaining phrase or, for
// single-word names, a distinctive word matched on WORD BOUNDARIES. Generic industry words
// never qualify on their own.
export function nameMatchesStory(companyName, story) {
  const hay = String(story || '').toLowerCase();
  if (!hay) return false;
  const words = String(companyName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const core = words.filter((w) => !SUFFIXES.has(w));
  if (!core.length) return false;

  // Multi-word names: require the whole phrase, so "Sands China" cannot be satisfied by a
  // story that merely mentions China.
  if (core.length >= 2) {
    const phrase = new RegExp(`\\b${core.map(esc).join('[^a-z0-9]{1,3}')}\\b`, 'i');
    if (phrase.test(hay)) return true;
    // A distinctive leading word still counts (Tencent Holdings -> "Tencent"), but only if
    // it is not generic and is long enough to be a real name.
    const lead = core[0];
    if (lead.length >= 5 && !GENERIC.has(lead)) return new RegExp(`\\b${esc(lead)}\\b`, 'i').test(hay);
    return false;
  }

  const only = core[0];
  if (only.length < 5 || GENERIC.has(only)) return false;
  return new RegExp(`\\b${esc(only)}\\b`, 'i').test(hay);
}

// ---------- Stage 4: rank ----------
// Scores are deliberately simple and legible: this picks a SHORTLIST for a model to reason
// over, it is not a trading system. Anything clever here would be unexplainable in the card.
export function scoreOne(n, sig, cat, ctx) {
  if (!sig) return null;
  const reasons = [];
  let score = 0;

  // A name has to be able to reach a worthwhile target inside a week, but not be a lottery.
  const v = sig.weeklyVolPct;
  if (v == null) return null;
  if (v < 1.5) return null;                       // too quiet to pay for the risk in 5 days
  if (v > 18) { score -= 15; reasons.push('very volatile'); }

  // momentum, both directions — a swing can be long or short
  if (sig.ret1w != null) {
    const m = Math.abs(sig.ret1w);
    if (m >= 3) { score += Math.min(20, m * 1.5); reasons.push(`${sig.ret1w > 0 ? 'up' : 'down'} ${Math.abs(sig.ret1w).toFixed(1)}% this week`); }
  }
  // trend agreement
  if (sig.vsSma20 != null && sig.vsSma50 != null) {
    if (sig.vsSma20 > 0 && sig.vsSma50 > 0) { score += 10; reasons.push('above 20d and 50d'); }
    else if (sig.vsSma20 < 0 && sig.vsSma50 < 0) { score += 6; reasons.push('below 20d and 50d'); }
  }
  // stretch: the edges of a 60-day range are where week-long setups tend to start
  if (sig.stretch != null) {
    if (sig.stretch <= 15) { score += 14; reasons.push(`near 60d low (${sig.stretch})`); }
    else if (sig.stretch >= 85) { score += 12; reasons.push(`near 60d high (${sig.stretch})`); }
  }
  // THE BIG ONE: a dated catalyst is what makes this a one-week trade at all.
  if (cat) {
    if (!cat.newsDerived) { score += 30; reasons.push(`earnings ${cat.date}`); }
    else { score += 18; reasons.push('in the news today'); }
  }
  // diversification: he is saturated in US semiconductors
  if (ctx.chipHeavy && /semiconductor/i.test(n.sector)) { score -= 25; reasons.push('chip — already saturated'); }
  if (ctx.underweightSectors.has(n.sector)) { score += 8; reasons.push('under-represented sector'); }
  if (n.market !== 'US') { score += 10; reasons.push('daytime-tradeable for him'); }

  return { score: +score.toFixed(1), reasons };
}

export function rank(names, signals, cats, ctx, limit = SHORTLIST_SIZE) {
  const scored = [];
  for (const n of names) {
    if (ctx.exclude.has(n.code.toUpperCase())) continue;
    const sig = signals[n.code];
    const cat = cats[n.code] || null;
    const s = scoreOne(n, sig, cat, ctx);
    if (!s) continue;
    scored.push({
      code: n.code, name: n.name, market: n.market, sector: n.sector,
      currency: sig.currency || n.currency,
      last: sig.last, ret1w: sig.ret1w, ret1m: sig.ret1m,
      vsSma20: sig.vsSma20, vsSma50: sig.vsSma50, stretch: sig.stretch,
      weeklyVolPct: sig.weeklyVolPct,
      catalyst: cat,
      score: s.score, why: s.reasons.join('; '),
      stale: !!sig.stale,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- The run ----------
async function run(opts = {}) {
  const started = Date.now();
  const { dateKey, weekday } = bkkDateKey();
  const universe = loadUniverse();

  // Book context, so ranking knows what he already owns and where he is concentrated.
  let book = null, ledger = [], uni = null;
  try { book = await rGet('exchange:book'); } catch { /* pack is still useful without it */ }
  try { ledger = (await rGet('exchange:ledger')) || []; } catch { ledger = []; }
  try { uni = await rGet('exchange:universe'); } catch { uni = null; }

  const held = new Set(((book && book.holdings) || []).map((h) => (h.ticker || h.name || '').toUpperCase()));
  const recent = new Set((ledger || [])
    .filter((r) => r.idea && r.ts > Date.now() - 10 * 86400e3)
    .map((r) => (r.idea.ticker || r.idea.name || '').toUpperCase()));
  const unavailable = new Set(((uni && uni.unavailable) || []).map((x) => String(x || '').toUpperCase()));
  const exclude = new Set([...held, ...recent, ...unavailable]);

  const sectorValue = {};
  for (const h of ((book && book.holdings) || [])) {
    const sec = h._sector || h.sector || 'Unknown';
    sectorValue[sec] = (sectorValue[sec] || 0) + Math.abs((+h.qty || 0) * (+h.lastPrice || +h.avgCost || 0));
  }
  const chipHeavy = Object.entries(sectorValue).some(([k, v]) => /semi|chip/i.test(k) && v > 0);
  const present = new Set(Object.keys(sectorValue));
  const underweightSectors = new Set(
    [...new Set(universe.map((n) => n.sector))].filter((s) => !present.has(s)),
  );

  // TIER SELECTION. Full sweep on Sunday or when forced; otherwise refresh the standing
  // shortlist plus anything that had a catalyst last run.
  const prev = await rGet(`exchange:candidates:${addDays(dateKey, -1)}`).catch(() => null);
  const isFull = !!opts.full || weekday === 'Sun' || !prev;
  let toScreen = universe;
  if (!isFull && prev) {
    const keep = new Set([
      ...(prev.shortlist || []).map((c) => c.code),
      ...Object.keys(prev.catalysts || {}),
      ...(prev.tier2 || []).slice(0, DAILY_REFRESH_SIZE),
    ]);
    toScreen = universe.filter((n) => keep.has(n.code));
    if (!toScreen.length) toScreen = universe.slice(0, DAILY_REFRESH_SIZE);
  }

  const signals = await screen(toScreen);
  // Carry forward anything not re-screened today, MARKED STALE. Silently presenting a
  // four-day-old momentum reading as today's is the sort of quiet lie this project keeps
  // finding and removing.
  if (!isFull && prev && prev.signals) {
    for (const [code, sig] of Object.entries(prev.signals)) {
      if (!signals[code]) signals[code] = { ...sig, stale: true };
    }
  }

  const screened = universe.filter((n) => signals[n.code]);
  const cats = await catalysts(screened, dateKey);
  const shortlist = rank(universe, signals, cats, { exclude, chipHeavy, underweightSectors });

  // tier-2 for tomorrow: the next band down, so good names near the cut are re-checked
  const tier2 = rank(universe, signals, cats, { exclude, chipHeavy, underweightSectors }, DAILY_REFRESH_SIZE)
    .map((c) => c.code);

  const pack = {
    dateKey,
    builtAt: new Date().toISOString(),
    sweep: isFull ? 'full' : 'refresh',
    universeSize: universe.length,
    screenedCount: Object.keys(signals).length,
    freshCount: Object.keys(signals).filter((k) => !signals[k].stale).length,
    catalystCount: Object.keys(cats).length,
    shortlist,
    tier2,
    signals,
    catalysts: cats,
    elapsedMs: Date.now() - started,
  };
  await rSet(`exchange:candidates:${dateKey}`, pack);
  return pack;
}

// ---------- Seed refresh ----------
// Re-validates every committed symbol against the live feed and REPORTS drift. It does not
// rewrite the committed file — index membership is a deliberate, reviewable change, not
// something a cron should mutate underneath you.
async function refresh() {
  const universe = loadUniverse();
  const gone = [];
  for (let i = 0; i < universe.length; i += BATCH) {
    const chunk = universe.slice(i, i + BATCH);
    const got = await fetchSeries(chunk.map((n) => n.sym));
    for (const n of chunk) if (!got[n.sym.toUpperCase()]) gone.push({ market: n.market, code: n.code, name: n.name, sym: n.sym });
    await sleep(200);
  }
  return {
    checked: universe.length,
    resolving: universe.length - gone.length,
    drifted: gone,
    note: gone.length
      ? 'These no longer price — usually delisted, merged or taken private. Remove them from api/exchange-universe.json.'
      : 'Every committed name still resolves.',
  };
}

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const q = { ...(req.query || {}), ...(req.body || {}) };
    const action = q.action || 'pack';
    if (action === 'run') {
      const pack = await run({ full: q.full === '1' || q.full === true });
      return res.status(200).json({
        ok: true, dateKey: pack.dateKey, sweep: pack.sweep,
        universeSize: pack.universeSize, screened: pack.screenedCount, fresh: pack.freshCount,
        catalysts: pack.catalystCount, shortlist: pack.shortlist.length, elapsedMs: pack.elapsedMs,
        top: pack.shortlist.slice(0, 10),
      });
    }
    if (action === 'pack') {
      const key = q.date || bkkDateKey().dateKey;
      const pack = await rGet(`exchange:candidates:${key}`);
      if (!pack) return res.status(404).json({ error: `No candidate pack for ${key}. Run ?action=run first.` });
      return res.status(200).json(pack);
    }
    if (action === 'refresh') return res.status(200).json(await refresh());
    if (action === 'universe') {
      const u = loadUniverse();
      const byMarket = {};
      for (const n of u) byMarket[n.market] = (byMarket[n.market] || 0) + 1;
      return res.status(200).json({ total: u.length, byMarket, version: universeSeed.version, generatedOn: universeSeed.generatedOn });
    }
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
