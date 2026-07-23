# Meet Triage

Before analysing anything, rank the day's meets so effort goes where the edge
is richest.

## Ranking factors

Rank meets on:

1. **Field depth** — bigger, more competitive fields spread the tote pool and
   create more overbet-longshot mistakes to fade.
2. **Prize money** — higher stakes pull better form and more reliable analysis.
3. **Feature-race status** — Group/Listed/feature races attract deeper punditry.
4. **Analysis availability** — how much external opinion actually exists for the
   meet. A meet nobody covers can't produce a convergence grid.

## Region source toolkit (per-meet deep dives)

The 8am trawl and manual analysis draw on region-specific sources:

- **South Africa:** Gold Circle + Race Coast
- **Hong Kong / Malaysia:** iRace
- **Korea:** korearacing.live
- **Australia:** TAB (card source) + racing.com (opinion source)
- **France:** PMU JSON programme (merged réunions — SGPools "France" can merge
  1-3 PMU réunions into one card)
- **Broad form:** Racing & Sports is a DEAD END for automated pulls (Cloudflare
  JS challenge) but may still be readable manually via web_fetch.

## Card-matching rule (locked)

SGPools merges and renumbers source meets. Match cards **name-first**, never by
source numbering or by venue label (venue labels have been proven wrong, e.g.
"Australia (Perth)" was actually Rockhampton QLD one day). Names decide.

## Cross-check is mandatory here

Sectionals and pace maps run on EVERY meet at triage, not just the meets you
end up betting. This is a standing rule. If the bash network is off, use
web_search / web_fetch, don't skip.
