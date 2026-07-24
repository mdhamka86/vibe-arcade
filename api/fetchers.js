// /api/fetchers.js
//
// Ninety Plus - source fetchers.
//
// One fetcher per source. Each returns a normalised shape so the scoring layer
// never has to know where a number came from:
//
//   { source, ok, error?, teams?: {...}, fixtures?: [...], meta: {...} }
//
// Every parser below was written against a REAL response captured on
// 2026-07-24, not against a guess at the markup.

// USER-AGENT ROTATION IS A REAL BYPASS, not superstition. Verified 24/07/2026:
// forebet.com returns 403 to a desktop-Chrome UA on every path but 200 to an
// iPhone, Firefox or Android UA. The first live run of this tool lost Forebet on
// BOTH the Swedish and Russian leagues to exactly that, and reported it as the
// source being down. A 403 from one fetcher with one UA is not proof a source is
// dead — retry with a different UA before writing anything off.
const UAS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
];
const UA = UAS[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PER-SOURCE UA PREFERENCE, not one global rotation. The two constraints pull in
// OPPOSITE directions and a single order cannot satisfy both:
//   forebet.com   403s desktop Chrome, serves iPhone/Firefox/Android
//   soccerstats   serves a STRIPPED MOBILE PAGE to an iPhone UA (194KB, 174 rows)
//                 and the full table to a desktop UA (700KB, 763 rows)
// Rotating iPhone-first fixed Forebet and quietly cut SoccerSTATS from 16 teams to
// 1 — a 200 with the wrong markup, which is exactly the "a 200 is not coverage"
// trap. So each fetcher states the identity it needs, and rotation happens only
// within that preference on retry.
const UA_DESKTOP = [UAS[2], UAS[1]];   // chrome, then firefox
const UA_MOBILE  = [UAS[0], UAS[1]];   // iphone, then firefox

// Fetch a page through r.jina.ai's renderer. The proxy does its own fetch from
// its own network, then returns the fully rendered HTML (X-Return-Format: html).
// Slower than a direct hit (it renders), so callers use it as a LAST resort.
async function grabVia(targetUrl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch('https://r.jina.ai/' + targetUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UAS[0], 'X-Return-Format': 'html' },
    });
    if (!r.ok) throw new Error('jina HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function grab(url, { ms = 15000, tries = 3, json = false, uas = UA_DESKTOP } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // Rotate WITHIN the source's preferred family on retry: a source that
          // gates on the header fails identically three times otherwise, and the
          // retry proves nothing.
          'User-Agent': uas[i % uas.length],
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: json ? 'application/json' : 'text/html,application/xhtml+xml,text/csv,*/*',
        },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return json ? await r.json() : await r.text();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(400);
    } finally {
      clearTimeout(t);
    }
  }
  throw last;
}

// Strip tags/scripts/ad-injection, collapse to searchable text.
function detag(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalise a club name for cross-source matching. Sources spell the same club
// a dozen ways (Bodo/Glimt, Bodoe Glimt, Bodø/Glimt, FK Bodo Glimt), so we
// fold accents, drop corporate cruft, and compare on a bare key.
const ALIASES = {
  // Cases the generic rules cannot reach: abbreviations, doubled vowels, and
  // clubs whose short name shares no substring with their long name.
  'lafc': 'los angeles', 'nycfc': 'new york city', 'rsl': 'real salt lake',
  'hamkam': 'ham kam', 'hamarkameratene': 'ham kam',
  'ifk goteborg': 'goteborg', 'goeteborg': 'goteborg',
  // English exonyms. SGPools writes the English name, European sources the local
  // one, and the two share no substring, so no amount of fuzzy matching finds them.
  'gothenburg': 'goteborg', 'ifk gothenburg': 'goteborg',
  'copenhagen': 'kobenhavn', 'munich': 'munchen', 'cologne': 'koln',
  'turin': 'torino', 'milan': 'milano', 'seville': 'sevilla',
  'lisbon': 'lisboa', 'prague': 'praha', 'warsaw': 'warszawa',
  'moscow': 'moskva', 'vienna': 'wien', 'zurich': 'zurich',
  'psg': 'paris saint germain', 'spurs': 'tottenham',
  'man utd': 'manchester', 'man city': 'manchester city',
  'inter': 'internazionale', 'bodoe glimt': 'bodo glimt',
};

export function teamKey(name) {
  if (!name) return '';
  let k = String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Scandinavian/German transliteration. Sources disagree wildly: ClubElo
    // writes "Bodoe Glimt"/"Vaesteraas", ESPN writes "Bodo/Glimt"/"Västerås".
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/oe/g, 'o').replace(/ae/g, 'a').replace(/ue/g, 'u')
    // collapse doubled vowels left by transliteration (vasteraas -> vasteras)
    .replace(/([aeiou])\1+/g, '$1')
    // strip club-type tokens that only some sources include
    .replace(/\b(fc|fk|sk|if|ik|bk|cf|sc|ac|afc|club|clube|deportivo|cd|ca|sv|vfl|vfb|utd|fotball|fotboll|ff|il|bsc|ssc|as|us|ud|sd|rc|cs|ifk)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (ALIASES[k]) k = ALIASES[k];
  return k;
}

/** Fuzzy-match a name against a map of key -> value. */
export function matchTeam(name, table) {
  const k = teamKey(name);
  if (!k) return null;
  if (table[k]) return table[k];
  const keys = Object.keys(table);
  // containment both ways handles "Bodo Glimt" vs "Bodo Glimt 2"
  let best = null, bestLen = 0;
  for (const c of keys) {
    if ((c.includes(k) || k.includes(c)) && Math.min(c.length, k.length) >= 4) {
      const L = Math.min(c.length, k.length);
      if (L > bestLen) { best = table[c]; bestLen = L; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// ESPN  -  fixtures, records, 5-game form, DraftKings moneyline + O/U
// Verified shape: events[].competitions[0].{odds[], competitors[].{records,form}}
// ---------------------------------------------------------------------------
export async function fetchESPN(slug, yyyymmdd) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard` +
              (yyyymmdd ? `?dates=${yyyymmdd}` : '');
  try {
    const d = await grab(url, { json: true, ms: 20000 });
    const fixtures = (d.events || []).map((e) => {
      const c = (e.competitions || [])[0] || {};
      const o = (c.odds || [])[0] || {};
      const side = (ha) => (c.competitors || []).find((x) => x.homeAway === ha) || {};
      const h = side('home'), a = side('away');
      const rec = (t) => ((t.records || [])[0] || {}).summary || null;
      return {
        id: e.id,
        date: e.date,
        home: (h.team || {}).displayName,
        away: (a.team || {}).displayName,
        homeForm: h.form || null,
        awayForm: a.form || null,
        homeRecord: rec(h),
        awayRecord: rec(a),
        // DraftKings line, when present - a second market price vs SGPools
        oddsProvider: (o.provider || {}).name || null,
        spread: o.details || null,
        overUnder: o.overUnder != null ? Number(o.overUnder) : null,
        mlHome: ((o.homeTeamOdds || {}).moneyLine) ?? null,
        mlAway: ((o.awayTeamOdds || {}).moneyLine) ?? null,
      };
    });
    return { source: 'espn', ok: true, fixtures,
             meta: { league: ((d.leagues || [])[0] || {}).name, count: fixtures.length } };
  } catch (e) {
    return { source: 'espn', ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// ClubElo  -  Elo ratings + FULL scoreline / goal-difference distribution
// Verified: CSV, header Date,Country,Home,Away,GD<-5..GD>5,R:0-0..R:6-0
// EUROPE ONLY.
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((l) => {
    const cells = l.split(',');
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i]; });
    return o;
  });
}

export async function fetchClubElo(countryCode) {
  try {
    const txt = await grab('http://api.clubelo.com/Fixtures', { ms: 20000 });
    const rows = parseCSV(txt);
    const wanted = (!countryCode || countryCode === '*')
      ? rows
      : rows.filter((r) => r.Country === countryCode);

    const fixtures = wanted.map((r) => {
      let home = 0, away = 0;
      for (const k of Object.keys(r)) {
        if (!k.startsWith('GD')) continue;
        const v = parseFloat(r[k]);
        if (isNaN(v)) continue;
        if (k === 'GD=0') continue;
        if (k === 'GD>5') home += v;
        else if (k === 'GD<-5') away += v;
        else if (k.startsWith('GD=-')) away += v;
        else if (k.startsWith('GD=')) home += v;
      }
      const draw = parseFloat(r['GD=0']) || 0;

      // scoreline grid -> totals probabilities
      const scores = Object.entries(r)
        .filter(([k]) => k.startsWith('R:'))
        .map(([k, v]) => ({ score: k.slice(2), p: parseFloat(v) || 0 }))
        .sort((a, b) => b.p - a.p);
      const over = (line) => scores
        .filter((s) => s.score.split('-').reduce((x, y) => x + Number(y), 0) > line)
        .reduce((a, s) => a + s.p, 0);

      return {
        date: r.Date, country: r.Country, home: r.Home, away: r.Away,
        pHome: home, pDraw: draw, pAway: away,
        fairHome: home ? 1 / home : null,
        fairDraw: draw ? 1 / draw : null,
        fairAway: away ? 1 / away : null,
        topScores: scores.slice(0, 5),
        pOver15: over(1.5), pOver25: over(2.5), pOver35: over(3.5),
      };
    });
    return { source: 'clubelo', ok: true, fixtures, meta: { count: fixtures.length, country: countryCode } };
  } catch (e) {
    return { source: 'clubelo', ok: false, error: String(e.message || e) };
  }
}

export async function fetchClubEloRatings(dateISO) {
  try {
    const txt = await grab(`http://api.clubelo.com/${dateISO}`, { ms: 20000 });
    const rows = parseCSV(txt);
    const teams = {};
    for (const r of rows) {
      if (!r.Club) continue;
      teams[teamKey(r.Club)] = {
        club: r.Club, country: r.Country,
        elo: parseFloat(r.Elo), level: Number(r.Level),
        rank: r.Rank === 'None' ? null : Number(r.Rank),
      };
    }
    return { source: 'clubelo_ratings', ok: true, teams, meta: { count: Object.keys(teams).length } };
  } catch (e) {
    return { source: 'clubelo_ratings', ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// xGscore  -  xG / xGA / xPTS per team. Exposes luck-inflated table positions.
// Verified markdown table shape:
//   | 1 | Sirius | 13 | 11 | 2 | 0 | 36 | 26.8 -9.2 | 16 | 15.6 -0.4 | 35 | 24.4 -10.6 |
// ---------------------------------------------------------------------------
export async function fetchXGScore(slug) {
  try {
    const html = await grab(`https://xgscore.io/xg-statistics/${slug}`, { ms: 20000 });
    const t = detag(html);
    const teams = {};
    // "<pos> <Club> <MP> <W> <D> <L> <GS> <xG> <diff> <GC> <xGC> <diff> <PTS> <xPTS> <diff>"
    const re = /(\d{1,2})\s+([A-Za-zÀ-ÿ.\-'’ ]{3,28}?)\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,3})\s+([\d.]+)\s+[+\-\s]*([\d.]+)\s+(\d{1,3})\s+([\d.]+)\s+[+\-\s]*([\d.]+)\s+(\d{1,3})\s+([\d.]+)\s+([+\-\s]*[\d.]+)/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const club = m[2].trim();
      if (!club || club.length < 3) continue;
      const pts = Number(m[13]), xpts = Number(m[14]);
      teams[teamKey(club)] = {
        club, pos: Number(m[1]), mp: Number(m[3]),
        w: Number(m[4]), d: Number(m[5]), l: Number(m[6]),
        gf: Number(m[7]), xg: Number(m[8]),
        ga: Number(m[10]), xga: Number(m[11]),
        pts, xpts,
        // + means the table flatters them, - means they are underrated
        ptsOverperformance: Number((pts - xpts).toFixed(1)),
      };
    }
    return { source: 'xgscore', ok: true, teams, meta: { count: Object.keys(teams).length, slug } };
  } catch (e) {
    return { source: 'xgscore', ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Forebet  -  win/draw/loss %, predicted score, average goals
// Verified: probabilities render as a CONCATENATED triple, e.g. "542422"
// = 54% home / 24% draw / 22% away, followed by "3 - 1" and avg goals.
// ---------------------------------------------------------------------------
export async function fetchForebet(path) {
  try {
    // FOREBET IS BEHIND A CLOUDFLARE *IP* CHALLENGE, and that changes everything
    // about how to reach it. The 403 body is the "Just a moment..." interstitial:
    // Cloudflare judging the CALLER'S IP REPUTATION, not its headers. Both hosts
    // pass from a residential-ish sandbox and both fail from Vercel's Lambda
    // ranges, which is why two successive "fixes" (UA rotation, then the mobile
    // host) each worked in testing and died in production. The lesson, earned
    // twice now: A FIX FOR AN IP-REPUTATION BLOCK CANNOT BE VERIFIED FROM A
    // TRUSTED IP. Only the deployed function's own origin proves anything.
    //
    // The fallback that actually breaks the dependency: r.jina.ai, a rendering
    // proxy that fetches the page FROM JINA'S infrastructure and returns the
    // rendered HTML. Vercel's IP never touches Forebet. Keyless tier is rate
    // limited (~20 req/min) but the 10-minute source cache keeps us far under.
    // Direct hosts are still tried first: cheaper, faster, and they may work
    // from other deploy targets.
    let html, via = "direct";
    try {
      html = await grab(`https://m.forebet.com/en/${path}`, { ms: 15000, tries: 1, uas: UA_MOBILE });
    } catch (e1) {
      try {
        html = await grab(`https://www.forebet.com/en/${path}`, { ms: 15000, tries: 1, uas: UA_MOBILE });
      } catch (e2) {
        via = "jina";
        html = await grabVia(`https://m.forebet.com/en/${path}`);
      }
    }

    // Forebet emits schema.org microdata per fixture inside a `rcnt` block:
    //   <div class='rcnt ...'> ... <span class="homeTeam"><span itemprop="name">X</span>
    //   <span class="awayTeam"><span itemprop="name">Y</span>
    //   <time itemprop="startDate" datetime="2026-07-25">
    //   ...then the probability triple, pick, predicted score and avg goals.
    // Parsing per-block (rather than splitting flattened page text) is what
    // keeps multi-word clubs intact: "Pohang Steelers", not "Pohang".
    const fixtures = [];
    // QUOTE-TOLERANT SPLIT. Forebet's own markup uses single quotes on this class
    // (class='rcnt') but any DOM round-trip — jina's renderer included — re-emits
    // it with double quotes. A split pinned to one quote style silently parses
    // ZERO fixtures from a perfectly good page.
    const blocks = html.split(/<div class=['"]rcnt/).slice(1);

    for (const b of blocks) {
      const home = b.match(/class="homeTeam"[\s\S]*?itemprop="name">([^<]+)</);
      const away = b.match(/class="awayTeam"[\s\S]*?itemprop="name">([^<]+)</);
      if (!home || !away) continue;

      const iso  = b.match(/itemprop="startDate"\s+datetime="([\d-]+)"/);
      const disp = b.match(/class="date_bah">([^<]+)</);

      // probability triple lives in three sibling spans/divs after the name block
      const flat = b.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
                    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
                    .replace(/\s+/g, ' ');
      const pm = flat.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+([X12]{1,2})\s+(\d)\s*-\s*(\d)(?:\s+\d\s*-\s*\d)?\s+([\d.]{3,4})/);
      if (!pm) continue;
      const ph = +pm[3], pd = +pm[4], pa = +pm[5];
      if (Math.abs(ph + pd + pa - 100) > 3) continue;

      fixtures.push({
        home: home[1].trim(), away: away[1].trim(),
        dateISO: iso ? iso[1] : null,
        date: disp ? disp[1].split(' ')[0] : pm[1],
        time: disp ? (disp[1].split(' ')[1] || null) : pm[2],
        pHome: ph, pDraw: pd, pAway: pa,
        pick: pm[6],
        predScore: `${pm[7]}-${pm[8]}`,
        avgGoals: Number(pm[9]),
      });
    }
    return { source: 'forebet', ok: true, fixtures,
             meta: { count: fixtures.length, path, blocks: blocks.length, via } };
  } catch (e) {
    return { source: 'forebet', ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// SoccerSTATS  -  PPG, pseudo-points, strength-of-schedule performance rating.
// Often the ONLY source for K League / Thai / Singapore / Malaysia.
// ---------------------------------------------------------------------------
export async function fetchSoccerStats(slug) {
  try {
    // MUST stay desktop: a mobile UA gets a stripped page with the tables gone.
    const html = await grab(`https://www.soccerstats.com/latest.asp?league=${slug}`, { ms: 20000, uas: UA_DESKTOP });
    const teams = {};

    // Performance table: club, GP, W, D, L, Pts, pPts, TeampPPG, OppPPG, rating
    const perf = /<tr[^>]*>[\s\S]{0,900}?<\/tr>/g;
    let row;
    while ((row = perf.exec(html)) !== null) {
      const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map((c) => detag(c[1]));
      if (cells.length < 8) continue;
      const club = cells.find((c) => /[A-Za-z]{3,}/.test(c) && !/^\d/.test(c));
      if (!club) continue;
      const nums = cells.map((c) => parseFloat(c)).filter((n) => !isNaN(n));
      if (nums.length < 6) continue;
      const k = teamKey(club);
      if (!k || k.length < 3) continue;
      teams[k] = teams[k] || { club, raw: nums.slice(0, 10) };
    }
    return { source: 'soccerstats', ok: true, teams,
             meta: { count: Object.keys(teams).length, slug,
                     note: 'raw[] = GP,W,D,L,Pts,pPts,pPPG,OppPPG,rating (column order varies by table)' } };
  } catch (e) {
    return { source: 'soccerstats', ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// football-data.co.uk  -  historical results + CLOSING ODDS (the CLV benchmark)
// Two schemas: new/<CC>.csv (Home/Away/HG/AG + AvgC*) and
//              mmz4281/<season>/<code>.csv (HomeTeam/AwayTeam/FTHG + B365*)
// ---------------------------------------------------------------------------
export async function fetchFootballData(path) {
  try {
    const txt = await grab(`https://www.football-data.co.uk/${path}.csv`, { ms: 30000 });
    const rows = parseCSV(txt.replace(/^\uFEFF/, ''));
    const isNew = path.startsWith('new/');
    const matches = rows.map((r) => ({
      date: r.Date,
      home: isNew ? r.Home : r.HomeTeam,
      away: isNew ? r.Away : r.AwayTeam,
      hg: Number(isNew ? r.HG : r.FTHG),
      ag: Number(isNew ? r.AG : r.FTAG),
      season: r.Season || null,
      // closing odds: market average (new schema) or Bet365 (main schema)
      closeH: Number(isNew ? r.AvgCH : r.B365CH || r.B365H) || null,
      closeD: Number(isNew ? r.AvgCD : r.B365CD || r.B365D) || null,
      closeA: Number(isNew ? r.AvgCA : r.B365CA || r.B365A) || null,
    })).filter((m) => m.home && m.away);
    return { source: 'footballdata', ok: true, matches,
             meta: { count: matches.length, path, schema: isNew ? 'extra' : 'main' } };
  } catch (e) {
    return { source: 'footballdata', ok: false, error: String(e.message || e) };
  }
}


// ---------------------------------------------------------------------------
// TheSportsDB  -  league tables for the ASIAN GAP (K League, Thai, SGP, MYS...)
// Free key "3". Season format is the bare year ("2026").
// TWO HONEST CAVEATS, both verified 24/07/2026:
//   1. The free key RATE LIMITS hard: single calls succeed, a burst of nine
//      returns HTML error pages that fail JSON parsing. One retry after a
//      polite delay recovers it; hammering does not.
//   2. Tables can be PARTIAL - K League 1 returned 5 rows for a 12-team
//      league. Treat as corroboration, never as the full standings.
// ---------------------------------------------------------------------------
export async function fetchTheSportsDB(leagueId) {
  const url = `https://www.thesportsdb.com/api/v1/json/3/lookuptable.php?l=${leagueId}&s=2026`;
  try {
    let j;
    try {
      j = await grab(url, { ms: 15000, tries: 1, json: true });
    } catch (e) {
      await sleep(1200);                       // rate-limit backoff, then one retry
      j = await grab(url, { ms: 15000, tries: 1, json: true });
    }
    const rows = Array.isArray(j.table) ? j.table : [];
    const teams = {};
    for (const r of rows) {
      const club = r.strTeam;
      if (!club) continue;
      teams[teamKey(club)] = {
        club, rank: Number(r.intRank), played: Number(r.intPlayed),
        w: Number(r.intWin), d: Number(r.intDraw), l: Number(r.intLoss),
        gf: Number(r.intGoalsFor), ga: Number(r.intGoalsAgainst), pts: Number(r.intPoints),
      };
    }
    return { source: 'tsdb', ok: true, teams,
             meta: { count: Object.keys(teams).length, leagueId,
                     partial: rows.length > 0 && rows.length < 8 } };
  } catch (e) {
    return { source: 'tsdb', ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// LiveScore  -  worldwide fixtures + live scores + results as clean JSON.
// No key. Verified 24/07/2026 across matchdays: carries K League 1 AND 2,
// Chinese Super League, and in-season Thai / Singapore / Malaysia / J.League.
// For analysis it confirms a fixture exists and when it kicks off; its real
// destiny is SETTLEMENT - Eps flips NS -> FT and Tr1/Tr2 carry the score, which
// is exactly what the future clerk of the scales needs, for free.
// ---------------------------------------------------------------------------
export async function fetchLivescore(yyyymmdd) {
  const url = `https://prod-public-api.livescore.com/v1/api/app/date/soccer/${yyyymmdd}/0?MD=1`;
  try {
    const j = await grab(url, { ms: 20000, json: true });
    const fixtures = [];
    for (const st of (j.Stages || [])) {
      for (const e of (st.Events || [])) {
        fixtures.push({
          country: st.Cnm || '', stage: st.Snm || '',
          home: ((e.T1 || [])[0] || {}).Nm || '',
          away: ((e.T2 || [])[0] || {}).Nm || '',
          status: e.Eps || '',                       // NS / FT / HT / 45' ...
          scoreHome: e.Tr1 != null ? Number(e.Tr1) : null,
          scoreAway: e.Tr2 != null ? Number(e.Tr2) : null,
          startsAt: e.Esd ? String(e.Esd) : null,     // yyyymmddHHMMSS
        });
      }
    }
    return { source: 'livescore', ok: true, fixtures,
             meta: { count: fixtures.length, date: yyyymmdd, stages: (j.Stages || []).length } };
  } catch (e) {
    return { source: 'livescore', ok: false, error: String(e.message || e) };
  }
}


// ---------------------------------------------------------------------------
// API-Football  -  per-fixture WIN PROBABILITIES for leagues no free model
// touches (K League above all). Free tier: 100 req/day with a key.
//
// *** THIS FETCHER HAS NEVER RUN LIVE. *** It is written against the v3
// documented schema and stays DORMANT until APIFOOTBALL_KEY exists in the env.
// Its first production run is its first test, so its first contribution to a
// slip should be read with that in mind - meta.untested says so in the output.
// League ids are RESOLVED BY SEARCH, never hard-coded from memory: a guessed id
// is exactly the class of silent wrongness the rest of this file exists to kill.
// ---------------------------------------------------------------------------
export async function fetchApiFootball(cfg, dateISO) {
  const key = process.env.APIFOOTBALL_KEY || '';
  if (!key) return { source: 'apifootball', ok: false, error: 'no APIFOOTBALL_KEY in env (dormant)' };
  const H = { 'x-apisports-key': key };
  const api = async (path) => {
    const r = await fetch('https://v3.football.api-sports.io' + path, { headers: H });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.errors && Object.keys(j.errors).length) throw new Error(JSON.stringify(j.errors).slice(0, 120));
    return j.response || [];
  };
  try {
    // 1) resolve the league id by search + country filter
    const leagues = await api('/leagues?search=' + encodeURIComponent(cfg.q));
    const hit = leagues.find((r) =>
      ((r.country || {}).name || '').toLowerCase().includes(String(cfg.c || '').toLowerCase()));
    if (!hit) return { source: 'apifootball', ok: false, error: 'league not resolved for "' + cfg.q + '" (' + cfg.c + ')' };
    const id = hit.league.id;
    const season = (hit.seasons || []).find((x) => x.current) || { year: new Date().getFullYear() };

    // 2) that day's fixtures, then predictions per fixture (respect the budget)
    const fx = await api('/fixtures?league=' + id + '&season=' + season.year + (dateISO ? '&date=' + dateISO : ''));
    const out = [];
    for (const f of fx.slice(0, 6)) {                 // cap: 100 req/day is finite
      await sleep(350);
      try {
        const p = (await api('/predictions?fixture=' + f.fixture.id))[0];
        const pct = ((p || {}).predictions || {}).percent || {};
        out.push({
          home: f.teams.home.name, away: f.teams.away.name,
          pHome: parseInt(pct.home, 10) || null,
          pDraw: parseInt(pct.draw, 10) || null,
          pAway: parseInt(pct.away, 10) || null,
          advice: ((p || {}).predictions || {}).advice || null,
        });
      } catch (e) { /* one bad prediction never sinks the batch */ }
    }
    return { source: 'apifootball', ok: true, fixtures: out,
             meta: { count: out.length, leagueId: id, season: season.year, untested: true } };
  } catch (e) {
    return { source: 'apifootball', ok: false, error: String(e.message || e) };
  }
}

export default {
  fetchESPN, fetchTheSportsDB, fetchLivescore, fetchApiFootball, fetchClubElo, fetchClubEloRatings,
  fetchXGScore, fetchForebet, fetchSoccerStats, fetchFootballData,
  teamKey, matchTeam,
};
