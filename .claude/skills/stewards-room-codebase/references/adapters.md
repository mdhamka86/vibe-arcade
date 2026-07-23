# Source Adapters

All adapters follow the same pattern: fetch the source's card/opinion, match
name-first against the SGPools card, emit keyed by SGPools raceNo. Never leak
source numbering upward.

## Endpoint-first philosophy

Most "JavaScript sites" aren't hiding data, they serve it separately: the
page's JS calls a JSON/XHR endpoint. Fetch that endpoint directly and you get
cleaner data than any HTML scrape. Tier 1 of every adapter is endpoint
discovery. Rendered fallbacks only for stubborn high-value sources.

## France — PMU JSON (BUILT)

- Programme endpoint: `pmuProgramme(date)` at
  `/rest/client/61/programme/DDMMYYYY`.
- Flatten `reunions x courses`, match **name-first** against the SGPools card
  (>=50% overlap decides), emit keyed by SGPools raceNo.
- **KEY TRAP: SGPools "France" MERGES 1-3 PMU réunions** into one card
  (e.g. 22/07 = R4+R5, 07/07 = R1+R4). "Pick THE réunion" is WRONG — you must
  merge. Coupon order is NOT start-time order (diagnostic only, never gate on
  it).
- Loud per-race error on an unmatched race is correct and needed (15/07 SGPools
  carried a race outside PMU's programme, correctly rejected at 0%).
- Only reachable from production (syd1); 403s locally.
- Verified: 16-day check, 100% name match, 163 races, 15/16 days clean.

## Australia — two-source (BUILT, LIVE 22 July)

Same merge/renumber pattern as France, worse. SG "Australia" interleaves 2
source meets by start time; venue labels are worthless (names decide).

- **CARD source: TAB** (`api.beta.tab.com.au`, Tabcorp tote — already used for
  odds/results). Date+meeting addressable:
  `/racing/dates/YYYY-MM-DD/meetings?jurisdiction=NSW` returns ALL regions.
  Verified 38/38 races 100% name + 258/258 saddlecloth match across all 3 AU
  containers. Reuses `matchCard`.
  - CAUTION: TAB is **live-only** (today+tomorrow, no backfill) — can't
    retro-validate. A TAB block is a **200-with-HTML-lie, not a 403** (`r.ok`
    sails through) — validate body shape. tabFinal results 404 the previous day,
    so AU finals vanish silently if pulled a day late — fail loud.
- **OPINION source: racing.com GraphQL** (`graphql.rmdprod.racing.com`, AWS
  AppSync, client-side `x-api-key` lifted from their JS). `meetTips` / `bestBet`
  / tipster comments so AU clears convergence honestly.
  - racing.com is proven as **TIPS not CARD** (partial `raceEntries`) — opinion
    only.
  - Key can rotate anytime — treat as **NON-load-bearing**: its death degrades
    AU to card-only gracefully, never breaks the trawl.
  - Passed the syd1 gate 22 July (200/POST/real tips). A header-less syd1 call
    gives a clean 401 = path open but NOT proof; always prove authed from syd1.

## Dead end — Racing & Sports

Cloudflare JS challenge, needs a headless browser. Do NOT build automated pulls
on it. Manual web_fetch may still reach text for ad hoc analysis.

## Other region sources (trawl toolkit)

- South Africa: Gold Circle + Race Coast
- Hong Kong / Malaysia: iRace
- Korea: korearacing.live
- Broad form: Racing & Sports (manual only, see above)
