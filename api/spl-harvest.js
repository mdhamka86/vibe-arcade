/**
 * SPL Fantasy — Harvest Scraper (Vercel serverless function)
 * Path suggestion: /api/spl-harvest.js
 *
 * Sweeps the SPL site into the exact shape of spl-fantasy-schema.md:
 *   1. Pulls all player identity records from wp-json (name, slug, position, club) — SOLID.
 *   2. Pulls the 8 club crests from wp-json/media — SOLID.
 *   3. Visits each player's TOTALS page and parses season-total stats — NEEDS TUNING (see notes).
 *
 * WHY TWO PARTS: the wp-json list gives identity but NOT the stat numbers (we confirmed this —
 * the numbers only render on the visible player page). So identity comes from the clean API,
 * numbers come from scraping each page.
 *
 * HONEST STATUS PER SECTION:
 *   - fetchAllPlayers / fetchCrests: built against JSON we have actually seen. Should work as-is.
 *   - parsePlayerStats: built against the RENDERED TEXT we saw, not the raw HTML. The label→value
 *     mapping is correct, but the exact regex/DOM selectors may need adjusting once you see one
 *     real page's HTML. Run debugSinglePlayer() FIRST on one slug before the full 222 sweep.
 *
 * No external deps. Uses global fetch (Node 18+ / Vercel default).
 */

const BASE = 'https://spl.sg';
const API = `${BASE}/wp-json/wp/v2`;

// Position taxonomy IDs → schema enum (confirmed from /player-position)
const POSITION_MAP = { 794: 'GK', 795: 'DEF', 796: 'MID', 797: 'FWD' };

// Club taxonomy id (team_name term) → display name.
// team_name term IDs seen on player records: 786 Albirex, 787 Balestier, 789 Geylang,
// 790 Hougang, 792 Tanjong Pagar, 793 Young Lions. Sailors/BG Tampines term IDs weren't in
// our sample — fill the two blanks after one API call (see resolveClubTerms()).
const CLUB_MAP = {
  786: 'Albirex Niigata FC (S)',
  787: 'Balestier Khalsa FC',
  789: 'Geylang International FC',
  790: 'Hougang United FC',
  792: 'Tanjong Pagar United FC',
  793: 'Young Lions',
  // 788 / 791: 'Lion City Sailors FC' / 'BG Tampines Rovers FC' — confirm via resolveClubTerms()
};

// Club crest media IDs — confirmed from /teams featured_media.
const CLUBS = [
  { id: 2796,  name: 'Albirex Niigata FC (S)',    slug: 'albirex',                  crestMediaId: 841 },
  { id: 10546, name: 'Balestier Khalsa FC',       slug: 'balestier-khalsa-fc',      crestMediaId: 842 },
  { id: 383,   name: 'BG Tampines Rovers FC',     slug: 'bg-tampines-rovers-fc',    crestMediaId: 129 },
  { id: 10584, name: 'Geylang International FC',   slug: 'geylang-international-fc', crestMediaId: 845 },
  { id: 10602, name: 'Hougang United FC',          slug: 'hougang-united-fc',        crestMediaId: 846 },
  { id: 381,   name: 'Lion City Sailors FC',       slug: 'lion-city-sailors-fc',     crestMediaId: 131 },
  { id: 10651, name: 'Tanjong Pagar United FC',    slug: 'tanjong-pagar-united-fc',  crestMediaId: 1130 },
  { id: 10681, name: 'Young Lions',                slug: 'young-lions',              crestMediaId: 849 },
];

const BRANDING = {
  leagueName: 'Singapore Premier League',
  leagueShort: 'SPL',
  season: '2025/26',
  logoUrl: 'https://spl.sg/wp-content/uploads/2025/08/2.png',
};

// Empty stats template — every schema field, so records are always uniform.
function emptyStats() {
  return {
    matches: 0, goals: 0, assists: 0, shots: 0, shotsOnTarget: 0, xg: 0,
    passes: 0, passesCompleted: 0, crosses: 0, successfulCrosses: 0,
    forwardPasses: 0, keyPasses: 0, passesFinalThird: 0, successfulPassesFinalThird: 0,
    touchInBox: 0, defensiveDuels: 0, interceptions: 0, defensiveActions: 0,
    duels: 0, duelsWon: 0, aerialDuels: 0, aerialDuelsWon: 0,
    dribbles: 0, successfulDribbles: 0, yellowCards: 0, redCards: 0,
    fouls: 0, offsides: 0, gkCleanSheets: 0, gkConceded: 0, gkShotsAgainst: 0, gkSaves: 0,
  };
}

// Exact SPL TOTALS label → schema key. Labels copied verbatim from the TOTALS page.
const LABEL_TO_KEY = {
  'Matches': 'matches', 'Goals': 'goals', 'Assists': 'assists',
  'Shots': 'shots', 'Shots On Target': 'shotsOnTarget', 'xG Shot': 'xg',
  'Passes': 'passes', 'Passes Completed': 'passesCompleted',
  'Crosses': 'crosses', 'Successful Crosses': 'successfulCrosses',
  'Forward Passes': 'forwardPasses', 'Key Passes': 'keyPasses',
  'Passes to Final Third': 'passesFinalThird',
  'Successful Passes to Final Third': 'successfulPassesFinalThird',
  'Touch in Box': 'touchInBox', 'Defensive Duels': 'defensiveDuels',
  'Interceptions': 'interceptions', 'Defensive Actions': 'defensiveActions',
  'Duels': 'duels', 'Duels Won': 'duelsWon',
  'Aerial Duels': 'aerialDuels', 'Aerial Duels Won': 'aerialDuelsWon',
  'Dribbles': 'dribbles', 'Successful Dribbles': 'successfulDribbles',
  'Yellow Cards': 'yellowCards', 'Red Cards': 'redCards',
  'Fouls': 'fouls', 'Offsides': 'offsides',
  'Gk Clean Sheets': 'gkCleanSheets', 'Gk Conceded Goals': 'gkConceded',
  'Gk Shots Against': 'gkShotsAgainst', 'Gk Saves': 'gkSaves',
};

async function getJson(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'Accept': 'text/html' } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.text();
}

/** 1. All player identity records (paginated at 100). SOLID — built on seen JSON. */
async function fetchAllPlayers() {
  const players = [];
  for (let page = 1; page <= 5; page++) {
    let batch;
    try {
      batch = await getJson(`${API}/advanced-player-stat?per_page=100&page=${page}`);
    } catch (e) {
      break; // 400 past last page is normal — stop.
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const p of batch) {
      const posId = Array.isArray(p['player-position']) ? p['player-position'][0] : null;
      const clubId = Array.isArray(p.team_name) ? p.team_name[0] : null;
      players.push({
        id: p.id,
        name: p.title.rendered,
        slug: p.slug,
        position: POSITION_MAP[posId] || 'MID', // fallback keeps record valid; flag below
        club: CLUB_MAP[clubId] || `UNKNOWN_CLUB_${clubId}`,
        photoUrl: '',
        stats: emptyStats(),
        fantasyPoints: 0,
        price: 0,
        _needsReview: !POSITION_MAP[posId] || !CLUB_MAP[clubId],
      });
    }
    if (batch.length < 100) break;
  }
  return players;
}

/** 2. Resolve the 8 crest media IDs → real image URLs. SOLID. */
async function fetchCrests() {
  const clubs = [];
  for (const c of CLUBS) {
    let crestUrl = '';
    try {
      const media = await getJson(`${API}/media/${c.crestMediaId}`);
      crestUrl = media.source_url || media.guid?.rendered || '';
    } catch (e) { /* leave blank, self-host later */ }
    clubs.push({ ...c, crestUrl });
  }
  return clubs;
}

/**
 * 3. Parse ONE player's TOTALS page. NEEDS TUNING against real HTML.
 *
 * The TOTALS page renders each stat as a label + number pair. We saw the rendered TEXT but not
 * the tags. This parser is deliberately tag-agnostic: it strips HTML to text, then for each known
 * label finds the number that follows it. Robust to layout, but VERIFY on one page first.
 */
function parsePlayerStats(html) {
  const stats = emptyStats();
  // Collapse to plain text with single spaces.
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // CRITICAL: the page renders TWO stat blocks in one document — the OVERVIEW/averages block
  // first, then the full "Total Statistics" block. Labels repeat across both (e.g. "Defensive
  // Duels" appears in both, with different numbers). We must parse ONLY the Total Statistics
  // block, so slice the text from that marker onward and discard everything above it.
  const marker = 'Total Statistics';
  const mIdx = text.indexOf(marker);
  if (mIdx >= 0) text = text.slice(mIdx + marker.length);
  // else: fall through and parse whole text (defensive fallback if marker text ever changes)

  // Process labels LONGEST-FIRST, blanking each matched span so shorter labels can't re-match
  // inside a longer phrase already consumed (Duels vs Defensive Duels, Goals vs Conceded Goals).
  const labels = Object.keys(LABEL_TO_KEY).sort((a, b) => b.length - a.length);
  for (const label of labels) {
    const re = new RegExp(escapeRe(label) + '\\s*:?\\s*(\\d+(?:\\.\\d+)?)');
    const m = text.match(re);
    if (m) {
      const key = LABEL_TO_KEY[label];
      stats[key] = key === 'xg' ? parseFloat(m[1]) : parseInt(m[1], 10);
      text = text.slice(0, m.index) + ' '.repeat(m[0].length) + text.slice(m.index + m[0].length);
    }
  }
  return stats;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Fetch + parse a single player's stats page by slug. */
async function fetchPlayerStats(slug) {
  const html = await getText(`${BASE}/advanced-player-stat/${slug}/`);
  return parsePlayerStats(html);
}

/**
 * Discover ALL matchweek recap posts by paginating the news API server-side.
 * No more manual page-by-page fetching — this walks every page itself and returns the full set.
 * Returns each recap's week number, slug, title, and link, sorted, with any gaps flagged.
 */
async function discoverMatchweeks() {
  const recaps = [];
  for (let page = 1; page <= 10; page++) {
    let batch;
    try {
      batch = await getJson(`${API}/posts?search=matchweek&per_page=100&page=${page}`);
    } catch (e) {
      break; // past the last page → stop
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const p of batch) {
      const m = p.slug && p.slug.match(/five-lessons-from-matchweek-(\d+)/i);
      if (m) {
        recaps.push({
          week: parseInt(m[1], 10),
          slug: p.slug,
          title: p.title?.rendered || '',
          link: p.link,
        });
      }
    }
    if (batch.length < 100) break; // last page reached
  }
  recaps.sort((a, b) => a.week - b.week);
  const weeks = recaps.map((r) => r.week);
  const maxWeek = weeks.length ? Math.max(...weeks) : 0;
  const missing = [];
  for (let i = 1; i <= maxWeek; i++) if (!weeks.includes(i)) missing.push(i);
  return { count: recaps.length, weeksPresent: weeks, missing, recaps };
}

/** DEBUG: run this on ONE slug first to verify parsing before the full sweep. */
async function debugSinglePlayer(slug = 'tin-matic') {
  const stats = await fetchPlayerStats(slug);
  const filled = Object.entries(stats).filter(([, v]) => v !== 0);
  return { slug, filledCount: filled.length, stats };
}

/** DEBUG RAW: return the collapsed text around the stats so we can see real label/value layout. */
async function debugRaw(slug = 'tin-matic') {
  const html = await getText(`${BASE}/advanced-player-stat/${slug}/`);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Grab a window around the first "Duels" so we see how Defensive Duels / Duels / Duels Won sit.
  const i = text.indexOf('Defensive Duels');
  const slice = i >= 0 ? text.slice(Math.max(0, i - 40), i + 220) : text.slice(0, 400);
  return { slug, textLength: text.length, duelsRegion: slice, head: text.slice(0, 600) };
}

/** Full harvest. Polite: small delay between page hits to avoid hammering the site. */
async function harvest({ limit = Infinity, delayMs = 300 } = {}) {
  const [players, clubs] = await Promise.all([fetchAllPlayers(), fetchCrests()]);
  const target = players.slice(0, limit);
  for (const p of target) {
    try {
      p.stats = await fetchPlayerStats(p.slug);
    } catch (e) {
      p._statsError = e.message;
    }
    await sleep(delayMs);
  }
  return { branding: BRANDING, clubs, players, harvestedAt: new Date().toISOString() };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- Vercel handler ---
// ?mode=debug&slug=tin-matic  → test one player's parse
// ?mode=identity              → players + crests, NO stat scraping (fast, always safe)
// ?mode=full&limit=5          → full harvest, optionally capped for a trial run
module.exports = async (req, res) => {
  const { mode = 'identity', slug, limit } = req.query || {};
  try {
    if (mode === 'debug') {
      return res.status(200).json(await debugSinglePlayer(slug || 'tin-matic'));
    }
    if (mode === 'raw') {
      return res.status(200).json(await debugRaw(slug || 'tin-matic'));
    }
    if (mode === 'matchweeks') {
      return res.status(200).json(await discoverMatchweeks());
    }
    if (mode === 'identity') {
      const [players, clubs] = await Promise.all([fetchAllPlayers(), fetchCrests()]);
      return res.status(200).json({ branding: BRANDING, clubs, players });
    }
    if (mode === 'full') {
      const data = await harvest({ limit: limit ? parseInt(limit, 10) : Infinity });
      return res.status(200).json(data);
    }
    return res.status(400).json({ error: `Unknown mode: ${mode}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Also export internals for local testing.
module.exports.fetchAllPlayers = fetchAllPlayers;
module.exports.fetchCrests = fetchCrests;
module.exports.parsePlayerStats = parsePlayerStats;
module.exports.debugSinglePlayer = debugSinglePlayer;
module.exports.debugRaw = debugRaw;
module.exports.discoverMatchweeks = discoverMatchweeks;
module.exports.harvest = harvest;
