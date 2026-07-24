// /api/sources.js
//
// Ninety Plus - source registry.
//
// Every mapping below was VERIFIED by fetching the live page/endpoint and
// confirming real team names for that competition appear in the response.
// Nothing here is assumed from a site's claimed coverage.
//
// Verification date: 2026-07-24
//
// TIERING MATTERS. Coverage is NOT uniform across SGPools' 76 competitions:
//   - European + American leagues:  up to 6 sources
//   - K League / Thai:              2 sources (SoccerSTATS, Forebet)
//   - Singapore / Malaysia:         1 source  (SoccerSTATS)
// The scoring layer must surface this, or a 2-source K League agreement gets
// read with the same confidence as a 6-source Norwegian one. It shouldn't be.
//
// KNOWN DEAD ENDS (tested, do not retry):
//   FBref / Transfermarkt / WhoScored / FootyStats / PredictZ / WinDrawWin /
//   WorldFootball / PlaymakerStats / FootballCritic  -> 403 to server-side
//   BetExplorer -> odds render client-side; HTML has team names, no prices
//   football-data.co.uk KOR/CHL/COL -> silently serve NOR/CHN/POL. Not real.
//   Understat -> big-5 European leagues + Russia only. None of our Asian card.
//   Polymarket / Kalshi -> ~zero per-match football. Not worth a call.

export const SOURCES = {
  espn: {
    name: 'ESPN',
    kind: 'json',
    // fixtures, W-D-L record, 5-game form, DraftKings moneyline + O/U, standings
    gives: ['fixtures', 'form', 'record', 'market_odds', 'totals_line', 'standings'],
    grade: 'market',   // a second bookmaker's line, plus form
    weight: 1.0,
    note: 'Undocumented public API. 220 leagues. No K League.',
  },
  clubelo: {
    name: 'ClubElo',
    kind: 'csv',
    // Elo rating + FULL scoreline/goal-difference probability distribution
    gives: ['elo', 'prob_1x2', 'prob_scoreline', 'prob_totals'],
    grade: 'model',    // a full scoreline distribution: the strongest thing here
    weight: 1.25,          // highest: independent model, full distribution
    note: 'EUROPE ONLY (55 countries, ~594 clubs). No Asia, no Americas.',
  },
  xgscore: {
    name: 'xGscore',
    kind: 'html',
    // xG, xGA, xPTS (expected points) - exposes luck-inflated table positions
    gives: ['xg', 'xga', 'xpts', 'match_xg'],
    grade: 'model',    // expected points: exposes luck-inflated table position
    weight: 1.15,
    note: 'No Asian league coverage at all.',
  },
  forebet: {
    name: 'Forebet',
    kind: 'html',
    // explicit win/draw/loss %, predicted score, avg goals, Kelly criterion
    gives: ['prob_1x2', 'pred_score', 'avg_goals', 'kelly', 'trends'],
    grade: 'model',
    weight: 1.0,
    note: 'Widest model coverage incl. K League + J League.',
  },
  soccerstats: {
    name: 'SoccerSTATS',
    kind: 'html',
    // PPG, pseudo-points, strength-of-schedule performance rating, splits
    gives: ['ppg', 'ppts', 'perf_rating', 'home_away_split', 'over_under'],
    grade: 'table',    // describes what happened; states no opinion on what will
    weight: 0.9,
    note: 'Widest ASIAN reach. Often the ONLY source for SGP/MYS/THA.',
  },
  footballdata: {
    name: 'football-data.co.uk',
    kind: 'csv',
    // historical results + CLOSING ODDS -> the CLV benchmark
    gives: ['results_history', 'closing_odds', 'match_stats'],
    grade: 'market',   // closing odds: the CLV benchmark, not a pre-match read
    weight: 0.85,
    note: 'Historical only, not pre-match. Powers CLV, not the read.',
  },
  // ---- second-pass finds, 24/07/2026 ----
  tsdb: {
    name: 'TheSportsDB',
    kind: 'json',
    gives: ['standings'],
    grade: 'table',
    weight: 0.6,
    note: 'Free key. THE ASIAN TABLE FILL (K League, Thai, SGP, MYS). Rate-limited; tables can be PARTIAL (K League returned 5 of 12 rows) - corroboration, never the full standings.',
  },
  livescore: {
    name: 'LiveScore',
    kind: 'json',
    gives: ['fixtures', 'live_scores', 'results'],
    grade: 'fixture',  // confirms the match exists. Vital for settling, silent on value
    weight: 0.5,
    note: 'Keyless JSON, worldwide incl. K League 1 AND 2. Confirms fixtures now; its real destiny is SETTLEMENT (Eps flips NS->FT with the score).',
  },
  apifootball: {
    name: 'API-Football',
    kind: 'json',
    gives: ['prob_1x2', 'advice', 'standings', 'fixtures'],
    grade: 'model',
    weight: 1.0,
    // DORMANT UNTIL A KEY EXISTS. Free tier is 100 req/day and covers K League
    // with per-fixture win probabilities - the model layer Asia otherwise lacks.
    // The fetcher is written against documented schema but has NEVER RUN LIVE:
    // it activates the moment APIFOOTBALL_KEY lands in the env, and its first
    // production run is its first test. Treat its first slip accordingly.
    enabled: !!process.env.APIFOOTBALL_KEY,
    note: 'Keyed (free 100/day). K League win probabilities. UNTESTED until first live run.',
  },
};

// A source is in play unless it declares itself disabled (apifootball without a
// key). Totals everywhere derive from this, never from a hard-coded 6 - the
// first frontend shipped "X/6" as a literal and it survived two source
// additions before anyone noticed the denominator was a lie.
export function enabledSources() {
  return Object.keys(SOURCES).filter((k) => SOURCES[k].enabled !== false);
}
export function sourceTotal() { return enabledSources().length; }

// ---------------------------------------------------------------------------
// SGPools competition -> per-source identifier.
// null means: tested, source does not carry it.
// ---------------------------------------------------------------------------
export const LEAGUES = {
  // ===== EUROPE: deepest coverage =====
  'English Premier':      { espn:'eng.1', clubelo:'ENG', xgscore:'epl', forebet:'football-tips-and-predictions-for-england/premier-league', soccerstats:'england', footballdata:'mmz4281/2526/E0' },
  'English League Champ': { espn:'eng.2', clubelo:'ENG', xgscore:null, forebet:'football-tips-and-predictions-for-england/championship', soccerstats:null, footballdata:'mmz4281/2526/E1' },
  'English League One':   { espn:'eng.3', clubelo:'ENG', xgscore:null, forebet:null, soccerstats:null, footballdata:'mmz4281/2526/E2' },
  'English Cup':          { espn:'eng.fa', clubelo:'ENG', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'English League Cup':   { espn:'eng.league_cup', clubelo:'ENG', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Spanish League':       { espn:'esp.1', clubelo:'ESP', xgscore:'la-liga', forebet:'football-tips-and-predictions-for-spain/primera-division', soccerstats:'spain', footballdata:'mmz4281/2526/SP1' },
  'Spanish League Div 2': { espn:'esp.2', clubelo:'ESP', xgscore:null, forebet:null, soccerstats:null, footballdata:'mmz4281/2526/SP2' },
  'Spanish Cup':          { espn:'esp.copa_del_rey', clubelo:'ESP', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Italian League':       { espn:'ita.1', clubelo:'ITA', xgscore:'serie-a', forebet:'football-tips-and-predictions-for-italy/serie-a', soccerstats:'italy', footballdata:'mmz4281/2526/I1' },
  'Italian League Div 2': { espn:'ita.2', clubelo:'ITA', xgscore:null, forebet:null, soccerstats:null, footballdata:'mmz4281/2526/I2' },
  'Italian Cup':          { espn:'ita.coppa_italia', clubelo:'ITA', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'German League':        { espn:'ger.1', clubelo:'GER', xgscore:'bundesliga', forebet:'football-tips-and-predictions-for-germany/bundesliga', soccerstats:'germany', footballdata:'mmz4281/2526/D1' },
  'German League Div 2':  { espn:'ger.2', clubelo:'GER', xgscore:null, forebet:null, soccerstats:null, footballdata:'mmz4281/2526/D2' },
  'German Cup':           { espn:'ger.dfb_pokal', clubelo:'GER', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'French League':        { espn:'fra.1', clubelo:'FRA', xgscore:'league-1', forebet:'football-tips-and-predictions-for-france/ligue1', soccerstats:'france', footballdata:'mmz4281/2526/F1' },
  'French League Div 2':  { espn:'fra.2', clubelo:'FRA', xgscore:null, forebet:null, soccerstats:null, footballdata:'mmz4281/2526/F2' },
  'French Cup':           { espn:'fra.coupe_de_france', clubelo:'FRA', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Dutch League':         { espn:'ned.1', clubelo:'NED', xgscore:'eredivisie', forebet:'football-tips-and-predictions-for-netherlands/eredivisie', soccerstats:'netherlands', footballdata:'mmz4281/2526/N1' },
  'Dutch League Div 2':   { espn:'ned.2', clubelo:'NED', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Dutch Cup':            { espn:'ned.cup', clubelo:'NED', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Norwegian League':     { espn:'nor.1', clubelo:'NOR', xgscore:'norway-eliteserien', forebet:'football-tips-and-predictions-for-norway/eliteserien', soccerstats:'norway', footballdata:'new/NOR' },
  'Norwegian Cup':        { espn:null, clubelo:'NOR', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Swedish League':       { espn:'swe.1', clubelo:'SWE', xgscore:'sweden-allsvenskan', forebet:'football-tips-and-predictions-for-sweden/allsvenskan', soccerstats:'sweden', footballdata:'new/SWE' },
  'Swedish Cup':          { espn:null, clubelo:'SWE', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Russian League':       { espn:'rus.1', clubelo:'RUS', xgscore:null, forebet:'football-tips-and-predictions-for-russia/premier-liga', soccerstats:'russia', footballdata:'new/RUS' },
  'Russian Cup':          { espn:null, clubelo:'RUS', xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'UE Champions':         { espn:'uefa.champions', clubelo:'*', xgscore:null, forebet:'predictions-europe/uefa-champions-league', soccerstats:null, footballdata:null },
  'UE Europe':            { espn:'uefa.europa', clubelo:'*', xgscore:null, forebet:'predictions-europe/uefa-europa-league', soccerstats:null, footballdata:null },
  'UE Conference':        { espn:'uefa.europa.conf', clubelo:'*', xgscore:null, forebet:'predictions-europe/uefa-europa-conference-league', soccerstats:null, footballdata:null },

  // ===== AMERICAS: no ClubElo =====
  'US Soccer League':     { espn:'usa.1', clubelo:null, xgscore:'mls', forebet:'football-tips-and-predictions-for-usa/mls', soccerstats:'usa', footballdata:'new/USA' },
  'US Soccer Cup':        { espn:'usa.open', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Argentine League':     { espn:'arg.1', clubelo:null, xgscore:'argentina-primera', forebet:'football-tips-and-predictions-for-argentina/liga-profesional', soccerstats:'argentina', footballdata:'new/ARG' },
  'Brazilian League':     { espn:'bra.1', clubelo:null, xgscore:'brazil-serie-a', forebet:'football-tips-and-predictions-for-brazil/serie-a', soccerstats:'brazil', footballdata:'new/BRA' },
  'Brazilian Cup':        { espn:'bra.copa_do_brazil', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Paulista Champ':       { espn:'bra.camp.paulista', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Chilean League':       { espn:'chi.1', clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-chile/primera-division', soccerstats:'chile', footballdata:null },
  'Chilean Cup':          { espn:'chi.copa_chi', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Mexican League':       { espn:'mex.1', clubelo:null, xgscore:'liga-mx', forebet:'football-tips-and-predictions-for-mexico/liga-mx', soccerstats:'mexico', footballdata:'new/MEX' },
  'Libertadores Cup':     { espn:'conmebol.libertadores', clubelo:null, xgscore:null, forebet:'south-america/copa-libertadores', soccerstats:null, footballdata:null },
  'Sudamericana Cup':     { espn:'conmebol.sudamericana', clubelo:null, xgscore:null, forebet:'south-america/copa-sudamericana', soccerstats:null, footballdata:null },
  'N America Champions':  { espn:'concacaf.champions', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },

  // ===== ASIA: THIN. No ClubElo, no xG anywhere. =====
  'K League':             { espn:null, clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-south-korea/k-league-1', soccerstats:'southkorea', footballdata:null, tsdb:'4689', livescore:{c:'Korea',t:'K-League 1'}, apifootball:{q:'K League 1',c:'Korea'}, },
  'K Cup':                { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'J League':             { espn:'jpn.1', clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-japan/j1-league', soccerstats:null, footballdata:'new/JPN', tsdb:'4633', livescore:{c:'Japan',t:'J1'}, apifootball:{q:'J1 League',c:'Japan'}, },
  'J League Div 2':       { espn:null, clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-japan/j2-league', soccerstats:null, footballdata:null },
  'J League Div 3':       { espn:null, clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-japan/j3-league', soccerstats:null, footballdata:null },
  'J Cup':                { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'J League Cup':         { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Chinese League':       { espn:'chn.1', clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-china/super-league', soccerstats:'china', footballdata:'new/CHN', tsdb:'4359', livescore:{c:'China',t:'Super League'}, apifootball:{q:'Super League',c:'China'}, },
  'Thai League':          { espn:null, clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-thailand/thai-league-1', soccerstats:'thailand', footballdata:null, tsdb:'4743', livescore:{c:'Thailand',t:''}, apifootball:{q:'Thai League 1',c:'Thailand'}, },
  // NOTE: soccerstats/malaysia loads but its table layout differs from the
  // European pages and the generic parser extracts 0 teams. Treat M League as
  // effectively UNCOVERED until a bespoke parser exists.
  'M League':             { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:'malaysia', footballdata:null, parserGap:true, tsdb:'4792', livescore:{c:'Malaysia',t:''}, apifootball:{q:'Super League',c:'Malaysia'}, },
  'M Cup':                { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'M FA Cup':             { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Singapore Premier League': { espn:null, clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-singapore/premier-league', soccerstats:'singapore', footballdata:null, tsdb:'4795', livescore:{c:'Singapore',t:''}, apifootball:{q:'Premier League',c:'Singapore'}, },
  'Singapore Cup':        { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Indian S League':      { espn:'ind.1', clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-india/indian-super-league', soccerstats:'india', footballdata:null, tsdb:'4791', apifootball:{q:'Indian Super League',c:'India'}, },
  'Indian FB League':     { espn:'ind.2', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Saudi League':         { espn:'ksa.1', clubelo:null, xgscore:null, forebet:'football-tips-and-predictions-for-saudi-arabia/professional-league', soccerstats:'saudiarabia', footballdata:null, tsdb:'4668', apifootball:{q:'Pro League',c:'Saudi'}, },
  'A League':             { espn:'aus.1', clubelo:null, xgscore:null, forebet:'tips-and-predictions-for-australia/a-league', soccerstats:'australia', footballdata:null },
  'A League (Women)':     { espn:'aus.w.1', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'A Cup':                { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'AFF Championship':     { espn:'aff.championship', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Asian Champ':          { espn:'afc.champions', clubelo:null, xgscore:null, forebet:'predictions-asia/afc-champions-league', soccerstats:null, footballdata:null },
  'Asian Champ 2':        { espn:'afc.cup', clubelo:null, xgscore:null, forebet:'predictions-asia/afc-cup', soccerstats:null, footballdata:null },
  'Asian Cup Qualifiers': { espn:'afc.cupq', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Asian Cup (Women)':    { espn:'afc.w.asian.cup', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Asian Cup U23':        { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'SEA Games':            { espn:null, clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },

  // ===== INTERNATIONAL / OTHER =====
  'African Nations Cup':  { espn:'caf.nations', clubelo:null, xgscore:null, forebet:'predictions-africa/cup-of-nations', soccerstats:null, footballdata:null },
  'W Cup':                { espn:'fifa.world', clubelo:null, xgscore:null, forebet:'predictions-world/world-cup', soccerstats:null, footballdata:null },
  'W Cup - Qualifiers':   { espn:'fifa.worldq.afc', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'W Cup U20':            { espn:'fifa.world.u20', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'International Friendlies': { espn:'fifa.friendly', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
  'Club Friendlies':      { espn:'club.friendly', clubelo:null, xgscore:null, forebet:null, soccerstats:null, footballdata:null },
};

/** How many sources carry this competition, and which. */
export function coverageFor(league) {
  const m = LEAGUES[league];
  const enabled = enabledSources();
  if (!m) return { known: false, count: 0, sources: [], missing: enabled, total: enabled.length };
  const sources = enabled.filter((s) => m[s]);
  const missing = enabled.filter((s) => !m[s]);
  return { known: true, count: sources.length, sources, missing, total: enabled.length, map: m };
}

/** Coverage tier - drives how much confidence the scoring layer may claim. */
// WHAT A SOURCE CONTRIBUTES, counted separately.
//   model   - states a probability or expectation for THIS match (Elo, xG, Forebet)
//   market  - somebody else's price (ESPN line, closing odds)
//   table   - describes the season so far, no view on the match (SoccerSTATS, TSDB)
//   fixture - confirms the match exists (LiveScore)
export function gradeMix(league) {
  const c = coverageFor(league);
  const mix = { model: 0, market: 0, table: 0, fixture: 0 };
  (c.sources || []).forEach((k) => {
    const g = (SOURCES[k] || {}).grade;
    if (g && mix[g] != null) mix[g]++;
  });
  return mix;
}

// TIER BY WHAT THE SOURCES DO, NOT HOW MANY THERE ARE.
//
// The count-only version called K League "deep" the day it reached five sources.
// But those five were two models and three descriptions, against Norway's six
// which include a full scoreline distribution and expected points. Treating a
// partial league table as the equal of ClubElo flattened a real difference into
// one confident word, and the word was doing work it had not earned.
//
// A read is only as strong as the OPINIONS in it. Tables and fixture feeds are
// worth having — they corroborate, and they settle — but no stack of them adds
// up to a probability. So models set the ceiling and everything else refines it.
export function tierFor(league) {
  const c = coverageFor(league);
  if (!c.known) return { tier: 'unknown', label: 'Unmapped competition', cap: 'Low', mix: null };
  const m = gradeMix(league);
  const opinions = m.model + m.market;          // things with a view on this match
  const support = m.table + m.fixture;          // things that describe or confirm
  const label =
    c.count === 0 ? 'no sources'
      : m.model + ' model' + (m.model === 1 ? '' : 's') +
        (m.market ? ', ' + m.market + ' market' : '') +
        (support ? ', ' + support + ' supporting' : '');

  if (c.count === 0) return { tier: 'none', label, cap: 'None', mix: m };
  // DEEP means three independent opinions, at least two of them models. That is
  // Norway's shape (Elo + xG + Forebet, plus two market lines) and it is the only
  // shape where genuine disagreement between models can be weighed. Two models
  // and three tables is a good read, not a deep one: with only two opinions a
  // disagreement is a coin toss between them, with nothing to break the tie.
  if (m.model >= 2 && opinions >= 3) return { tier: 'deep', label, cap: 'High', mix: m };
  // Two models, or one model with a second opinion beside it.
  if (m.model >= 2 || (m.model >= 1 && opinions >= 2)) return { tier: 'medium', label, cap: 'Medium-High', mix: m };
  // Exactly one voice with a view. Tables cannot promote this.
  if (m.model === 1) return { tier: 'thin', label, cap: 'Medium', mix: m };
  // No model at all. However many tables are stacked up, nothing here has an
  // opinion about the match, and the label must not pretend otherwise.
  if (opinions >= 1) return { tier: 'thin', label, cap: 'Medium', mix: m };
  return { tier: 'single', label: label + ' (no model covers this competition)', cap: 'Low', mix: m };
}

export default { SOURCES, LEAGUES, coverageFor, tierFor, gradeMix, enabledSources, sourceTotal };
