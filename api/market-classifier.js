// api/market-classifier.js
// THE EXCHANGE — the single source of truth for "which market is this name on?".
//
// WHY THIS EXISTS (22/07/2026). Three separate defects all traced back to the desk
// having no idea which exchange a ticker belonged to:
//   1. exchange-engine.js:75 sanitised tickers with /[^A-Z.]/g, stripping DIGITS, so
//      6758 (Sony, TSE) became "" and C6L (SIA, SGX) became "CL" — Colgate-Palmolive.
//      Asian names were silently priced as unrelated US companies.
//   2. Tradeability was prompt-English only; nothing in code stopped the model
//      proposing a name NOVA cannot trade.
//   3. There was no way to tell the user whether a market was open right now.
// All three need the same answer, so they get ONE classifier rather than three
// half-agreeing regexes.
//
// DESIGN RULE (deliberate): market is derived from TICKER SHAPE first, and the model's
// free-text `exchange` field is only a cross-check / tie-breaker. The model is allowed
// to write "other" in that field, so it can never be the source of truth. Where shape
// alone is genuinely ambiguous (a 4-digit code is valid on BOTH Tokyo and Bursa) and the
// hint does not resolve it, we return market:null — which the engine treats as UNPRICEABLE
// and hard-blocks. Guessing wrong is exactly the failure this module was written to end.
//
// Pure and network-free on purpose: the market-open badge must render without a fetch,
// and the tests must be able to drive it deterministically.

// ---------- The markets NOVA actually supports ----------
// `sessions` are LOCAL exchange wall-clock minutes-from-midnight, paired with an IANA
// zone. We deliberately do NOT store Phuket/ICT offsets: the US session crosses midnight
// in ICT and shifts an hour twice a year with US DST, so any hardcoded ICT window is
// wrong for part of the year. Storing local time + IANA zone and resolving at runtime is
// correct in every season, for every market, forever.
const M = (hh, mm) => hh * 60 + mm;

export const MARKETS = {
  US: {
    key: 'US', label: 'US', currency: 'USD', tz: 'America/New_York',
    yahooSuffix: '', // US tickers are bare on Yahoo AND on Finnhub
    sessions: [[M(9, 30), M(16, 0)]],
    aliases: ['NASDAQ', 'NYSE', 'NYSE AMERICAN', 'NYSEAMERICAN', 'AMEX', 'US', 'USA', 'NQ', 'ARCA', 'BATS'],
  },
  SGX: {
    key: 'SGX', label: 'SGX', currency: 'SGD', tz: 'Asia/Singapore',
    yahooSuffix: '.SI',
    // SGX runs a lunch break; the close auction runs to ~17:06 but 17:00 is the
    // honest "can I still trade normally" boundary.
    sessions: [[M(9, 0), M(12, 0)], [M(13, 0), M(17, 0)]],
    aliases: ['SGX', 'SES', 'SINGAPORE', 'SG'],
  },
  HKEX: {
    key: 'HKEX', label: 'HKEX', currency: 'HKD', tz: 'Asia/Hong_Kong',
    yahooSuffix: '.HK',
    sessions: [[M(9, 30), M(12, 0)], [M(13, 0), M(16, 0)]],
    aliases: ['HKEX', 'HKSE', 'HKG', 'HONG KONG', 'HONGKONG', 'HK', 'SEHK'],
  },
  TSE: {
    key: 'TSE', label: 'Tokyo', currency: 'JPY', tz: 'Asia/Tokyo',
    yahooSuffix: '.T',
    // TSE extended its afternoon close from 15:00 to 15:30 in November 2024
    // (closing auction 15:25-15:30). Using the old 15:00 would mark the market
    // shut for the last half hour of every session.
    sessions: [[M(9, 0), M(11, 30)], [M(12, 30), M(15, 30)]],
    aliases: ['TSE', 'TYO', 'JPX', 'TOKYO', 'JAPAN', 'JP'],
  },
  BURSA: {
    key: 'BURSA', label: 'Bursa', currency: 'MYR', tz: 'Asia/Kuala_Lumpur',
    yahooSuffix: '.KL',
    sessions: [[M(9, 0), M(12, 30)], [M(14, 30), M(17, 0)]],
    aliases: ['BURSA', 'KLSE', 'MYX', 'MALAYSIA', 'KUALA LUMPUR', 'MY'],
  },
  CHINA: {
    key: 'CHINA', label: 'China A', currency: 'CNY', tz: 'Asia/Shanghai',
    yahooSuffix: '.SS', // .SS Shanghai; .SZ Shenzhen handled via explicit suffix
    sessions: [[M(9, 30), M(11, 30)], [M(13, 0), M(15, 0)]],
    aliases: ['SSE', 'SZSE', 'SHANGHAI', 'SHENZHEN', 'CHINA', 'CN', 'SHH', 'SHZ'],
  },
};

// The allowlist Bug 3 asked for. Anything not in here is not proposable, full stop.
export const SUPPORTED = Object.keys(MARKETS);

// Yahoo suffix -> market, so an already-suffixed symbol short-circuits every guess.
const BY_SUFFIX = {
  '.SI': 'SGX', '.HK': 'HKEX', '.T': 'TSE', '.KL': 'BURSA',
  '.SS': 'CHINA', '.SZ': 'CHINA',
};

// Normalise the model's free-text exchange string to a market key, or null.
export function marketFromHint(exchangeHint) {
  const h = String(exchangeHint || '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!h || h === 'OTHER') return null;
  for (const k of SUPPORTED) {
    if (k === h) return k;
    if (MARKETS[k].aliases.some((a) => h === a || h.includes(a))) return k;
  }
  return null;
}

// ---------- The classifier ----------
// Returns a frozen descriptor. `market: null` means "we could not establish this
// safely" and MUST be treated by callers as unpriceable + unproposable.
//
//   ambiguous:true  -> shape fits more than one market and the hint didn't resolve it
//   supported:false -> resolved to something NOVA does not offer
export function classifyTicker(rawTicker, exchangeHint) {
  const raw = String(rawTicker == null ? '' : rawTicker).toUpperCase().trim();
  // Keep letters, digits and dot. THE ORIGINAL BUG lived here: the old pattern was
  // /[^A-Z.]/g, which deleted every digit and turned Asian codes into US tickers.
  const sym = raw.replace(/[^A-Z0-9.]/g, '');
  const hint = marketFromHint(exchangeHint);
  const fail = (reason, extra) => Object.freeze({
    ok: false, market: null, ticker: sym || null, yahooSymbol: null,
    currency: null, tz: null, isUS: false, supported: false, reason, ...extra,
  });

  if (!sym) return fail('no usable ticker');

  // 1) An explicit Yahoo-style suffix is unambiguous — trust it over everything.
  const dot = sym.lastIndexOf('.');
  if (dot > 0) {
    const suffix = sym.slice(dot);
    const body = sym.slice(0, dot);
    const mk = BY_SUFFIX[suffix];
    if (mk && body) return build(mk, body, sym, hint);
    // A dotted US class share (BRK.B) is legitimate — but ONLY for the handful of class
    // letters US listings actually use. A blanket "letters dot single letter" rule also
    // swallows VOD.L (London), BMW.DE, RIO.AX and friends, quietly marking a venue NOVA
    // does not offer as a tradeable US name. Anything outside this set is refused.
    if (/^[A-Z]{1,5}$/.test(body) && /^[ABCUW]$/.test(suffix.slice(1))) return build('US', sym, sym, hint);
    return fail(`unrecognised exchange suffix "${suffix}" — not a market NOVA offers`);
  }

  // 2) Shape-based inference on a bare code.
  const candidates = [];
  // US common stock is pure letters, 1-5 of them (NVDA, F, GOOGL).
  if (/^[A-Z]{1,5}$/.test(sym)) candidates.push('US');
  // SGX counters are 3-4 alphanumeric characters that mix letters AND digits, in any
  // arrangement. That mixture is the clean signature — US codes are pure letters and
  // the other Asian boards are pure digits, so nothing else looks like this:
  //   C6L (SIA)  D05 (DBS)  Z74 (Singtel)  BN4 (Keppel)  ES3 (STI ETF)
  //   A17U (Ascendas REIT)  C38U (CapLand)  5DD  9CI (CapLand Invest)
  // An earlier pattern here demanded letter+2-digits and rejected C6L outright —
  // the very ticker whose mispricing started all of this.
  if (/^[A-Z0-9]{3,4}$/.test(sym) && /[A-Z]/.test(sym) && /\d/.test(sym)) candidates.push('SGX');
  // A leading zero on a 4-5 digit code is a Hong Kong convention (0700, 09988) and
  // neither Tokyo nor Bursa codes lead with one — so it resolves on shape alone.
  if (/^0\d{3,4}$/.test(sym)) candidates.push('HKEX');
  else {
    // 4-digit codes are valid on Tokyo (6758), Bursa (1155) AND Hong Kong (0700
    // written unpadded as 700 is 3-digit, but 1810 etc are 4). Genuinely ambiguous —
    // the hint must resolve it or we refuse.
    if (/^\d{4}$/.test(sym)) candidates.push('TSE', 'BURSA', 'HKEX');
    // 1-3 and 5 digit codes are Hong Kong's alone among these boards.
    if (/^\d{1,3}$/.test(sym) || /^\d{5}$/.test(sym)) candidates.push('HKEX');
  }
  // Mainland China A-shares are 6 digits (600519 Shanghai, 000001 Shenzhen).
  if (/^\d{6}$/.test(sym)) candidates.push('CHINA');

  const uniq = [...new Set(candidates)];
  if (!uniq.length) return fail(`ticker shape "${sym}" matches no supported market`);

  // The hint is a TIE-BREAKER, never an override: it may only pick among shapes that
  // are actually plausible for this ticker.
  if (uniq.length > 1) {
    if (hint && uniq.includes(hint)) return build(hint, sym, sym, hint);
    return fail(
      `ticker "${sym}" is ambiguous across ${uniq.join('/')} and the stated exchange did not resolve it`,
      { ambiguous: true, candidates: uniq },
    );
  }
  // Single shape match. If the hint firmly disagrees, that is a real conflict and we
  // refuse rather than silently pricing the wrong instrument.
  if (hint && hint !== uniq[0]) {
    return fail(
      `ticker "${sym}" looks like ${uniq[0]} but was labelled ${hint} — conflicting, not guessing`,
      { conflict: true, shape: uniq[0], hint },
    );
  }
  return build(uniq[0], sym, sym, hint);
}

function build(marketKey, body, sym, hint) {
  const m = MARKETS[marketKey];
  if (!m) {
    return Object.freeze({
      ok: false, market: marketKey, ticker: sym, yahooSymbol: null, currency: null,
      tz: null, isUS: false, supported: false, reason: `${marketKey} is not a NOVA market`,
    });
  }
  // HK and China codes are zero-padded on Yahoo (700 -> 0700.HK).
  let core = body;
  if (marketKey === 'HKEX') core = body.replace(/^0+/, '').padStart(4, '0');
  const yahooSymbol = marketKey === 'US' ? core : `${core}${m.yahooSuffix}`;
  return Object.freeze({
    ok: true,
    market: marketKey,
    label: m.label,
    ticker: sym,
    yahooSymbol,
    currency: m.currency,
    tz: m.tz,
    isUS: marketKey === 'US',
    supported: SUPPORTED.includes(marketKey),
    hintAgreed: hint ? hint === marketKey : null,
  });
}

// ---------- Timezone plumbing ----------
// Mirrors the bkk() helper in exchange-engine.js: Intl.formatToParts, NOT the
// `new Date(d.toLocaleString('en-US',{timeZone}))` round-trip that usMarketOpen()
// used in public/exchange.html. That round-trip re-parses a locale-formatted string
// and is not guaranteed by spec — it happens to work in V8 and breaks elsewhere.
function partsIn(date, tz) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t)?.value || '';
  // 'en-GB' renders midnight as 24 rather than 00 in some ICU builds; normalise.
  const hh = parseInt(g('hour'), 10) % 24;
  return {
    y: parseInt(g('year'), 10), m: parseInt(g('month'), 10), d: parseInt(g('day'), 10),
    hh, mi: parseInt(g('minute'), 10), ss: parseInt(g('second'), 10),
    weekday: g('weekday'), minutes: hh * 60 + parseInt(g('minute'), 10),
  };
}

// Convert a wall-clock time IN a zone to the true UTC instant. Iterates because the
// offset itself depends on the instant (DST). Converges in two passes; three for safety.
function zonedToUtc(y, m, d, hh, mi, tz) {
  const target = Date.UTC(y, m - 1, d, hh, mi, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(guess), tz);
    const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss);
    guess = target - (asIfUtc - guess);
  }
  return new Date(guess);
}

const WEEKEND = new Set(['Sat', 'Sun']);
const PHUKET = 'Asia/Bangkok'; // ICT, UTC+7 — Phuket shares Bangkok's zone

function phuketClock(date) {
  const p = partsIn(date, PHUKET);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

// ---------- Market open/shut ----------
// IMPORTANT HONESTY NOTE: this is SCHEDULED hours only. Public holidays are NOT
// derivable from a weekday check, and every one of these markets closes for days the
// others trade through (Chinese New Year, Golden Week, Deepavali, Thanksgiving...).
// Rather than ship a holiday table that silently rots the moment it stops being
// maintained, every result carries scheduledOnly:true and the UI says so. An honest
// "scheduled hours" badge is worth more than a confident wrong one — which is the same
// principle as the unpriced hard-block in the engine.
export function marketStatus(marketKey, now = new Date()) {
  const m = MARKETS[marketKey];
  if (!m) {
    return {
      market: null, open: false, known: false, scheduledOnly: true,
      label: 'hours unknown', detail: 'Market not recognised — check the platform.',
    };
  }
  const local = partsIn(now, m.tz);
  const weekend = WEEKEND.has(local.weekday);
  const open = !weekend && m.sessions.some(([a, b]) => local.minutes >= a && local.minutes < b);

  // Today's sessions rendered in HIS clock, so the badge is directly actionable.
  const todaysWindows = m.sessions.map(([a, b]) => {
    const s = zonedToUtc(local.y, local.m, local.d, Math.floor(a / 60), a % 60, m.tz);
    const e = zonedToUtc(local.y, local.m, local.d, Math.floor(b / 60), b % 60, m.tz);
    return `${phuketClock(s)}-${phuketClock(e)}`;
  }).join(', ');

  const next = open ? null : nextOpen(m, now);
  return {
    market: marketKey,
    label: m.label,
    open,
    known: true,
    scheduledOnly: true,
    currency: m.currency,
    weekend,
    sessionsPhuket: todaysWindows,
    nextOpenIso: next ? next.toISOString() : null,
    nextOpenPhuket: next ? phuketClock(next) : null,
    nextOpenInMins: next ? Math.round((next.getTime() - now.getTime()) / 60000) : null,
    detail: open
      ? `${m.label} is open now (scheduled hours; ${todaysWindows} your time).`
      : next
        ? `${m.label} is shut. Next open ${phuketClock(next)} your time${weekend ? ' (weekend now)' : ''}.`
        : `${m.label} is shut.`,
  };
}

// Walk forward day by day to the next session start. Bounded at 10 days so a bad
// table can never spin. Cheap, and correct across DST because each candidate start is
// resolved through zonedToUtc independently.
function nextOpen(m, now) {
  for (let dayOffset = 0; dayOffset <= 10; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 86400000);
    const lp = partsIn(probe, m.tz);
    if (WEEKEND.has(lp.weekday)) continue;
    for (const [a] of m.sessions) {
      const start = zonedToUtc(lp.y, lp.m, lp.d, Math.floor(a / 60), a % 60, m.tz);
      if (start.getTime() > now.getTime()) return start;
    }
  }
  return null;
}

// Convenience for callers holding a ticker rather than a market key.
export function statusForTicker(ticker, exchangeHint, now = new Date()) {
  const c = classifyTicker(ticker, exchangeHint);
  if (!c.ok) {
    return {
      market: null, open: false, known: false, scheduledOnly: true,
      label: 'market unclear', detail: c.reason,
    };
  }
  return { ...marketStatus(c.market, now), ticker: c.ticker, yahooSymbol: c.yahooSymbol };
}
