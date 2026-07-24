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

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function grab(url, { ms = 15000, tries = 2, json = false } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,text/csv,*/*' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return json ? await r.json() : await r.text();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(500);
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
    const html = await grab(`https://www.forebet.com/en/${path}`, { ms: 20000 });

    // Forebet emits schema.org microdata per fixture inside a `rcnt` block:
    //   <div class='rcnt ...'> ... <span class="homeTeam"><span itemprop="name">X</span>
    //   <span class="awayTeam"><span itemprop="name">Y</span>
    //   <time itemprop="startDate" datetime="2026-07-25">
    //   ...then the probability triple, pick, predicted score and avg goals.
    // Parsing per-block (rather than splitting flattened page text) is what
    // keeps multi-word clubs intact: "Pohang Steelers", not "Pohang".
    const fixtures = [];
    const blocks = html.split(/<div class='rcnt/).slice(1);

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
             meta: { count: fixtures.length, path, blocks: blocks.length } };
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
    const html = await grab(`https://www.soccerstats.com/latest.asp?league=${slug}`, { ms: 20000 });
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

export default {
  fetchESPN, fetchClubElo, fetchClubEloRatings,
  fetchXGScore, fetchForebet, fetchSoccerStats, fetchFootballData,
  teamKey, matchTeam,
};
