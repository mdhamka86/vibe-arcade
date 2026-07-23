---
name: stewards-room-codebase
description: Build and maintain the Stewards' Room / vibe-arcade codebase (Hammy's horse racing trawl and betting desk). Use when editing, debugging, or extending the Vercel serverless functions, the trawl pipeline, the convergence model, the source adapters (France/PMU, Australia/TAB/racing.com, etc.), or the stewards front-end. Encodes hard-won constraints (syd1-only, ESM-not-CommonJS, name-first card matching, verification ritual) so they are never re-learned the hard way. Triggers include work on trawl.js, propose.js, stewards.js, the vibe-arcade repo, or the Stewards' Room app.
license: Proprietary. For Hammy / hammyLabs use.
compatibility: Designed for Claude Code working in the vibe-arcade repo (Vercel serverless, Node ESM, Upstash Redis).
metadata:
  author: hammyLabs
  version: "1.0"
---

# The Stewards' Room — Codebase

Build and maintenance rules for the horse racing estate: the 8am trawl, the
convergence model, the source adapters, and the stewards front-end. This exists
so the scars from past sessions become guardrails, not repeat injuries.

## Stack and deploy facts

- Repo: `github.com/mdhamka86/vibe-arcade`, deploys to
  `vibe-arcade-omega.vercel.app`.
- Vercel serverless functions (Node), **Upstash Redis** for caching so the app
  opens lag-free.
- Model calls use `claude-sonnet-4-6`.
- Hammy deploys from **Windows / Git Bash** by copy-pasting generated files.
  Every file is verified with **exact byte and line counts before committing.**
  Honour that ritual: always emit byte/line counts with any file you produce.

## Non-negotiable constraints (these have bitten before)

### 1. Region is syd1, and it matters functionally
All serverless functions are pinned to the **syd1 (Sydney)** region. This is not
cosmetic: the Australian TAB API is geo-blocked from US Vercel and only reachable
from syd1. Some adapters (France/PMU, AU/TAB, racing.com opinion) **only work
from production (syd1)** and 403/401 locally. A clean 401 from a header-less
syd1 call means "path open, not yet proven" — prove authed calls actually work
from syd1 before committing an adapter.

### 2. ESM, not CommonJS
`api/` is declared ESM (`"type":"module"`). Use `import`/`export`, not
`require`/`module.exports`. JSON imports need the import attribute
(`with { type: 'json' }`). A past commit that flipped module type silently broke
ten CommonJS files while leaving ESM ones intact — a whole-desk outage. Do not
mix module systems.

### 3. vercel.json and maxDuration
The `vercel.json` `functions` block can't match `.cjs` files. Declare
`maxDuration` as inline config exports where needed. A maxDuration mismatch
(cap below real runtime) makes Vercel serve its **plain-text error page instead
of JSON**, which then throws "Unexpected token A" JSON parse errors downstream.
Keep caps above real runtime. Watch for stale references in `vercel.json` to
deleted files (a dangling `api/triage.js` ref silently broke every build once).

### 4. Card matching is name-first, locked
SGPools merges and renumbers source meets. Match **name-first** against the
SGPools card (>=50% overlap decides). Never trust source numbering or venue
labels — SGPools "Australia (Perth)" was Rockhampton QLD one day; "France"
merges 1-3 PMU réunions. Emit everything keyed by SGPools raceNo so the SSOT
layer never sees source numbering. Full adapter notes in
`references/adapters.md`.

## Recurring code smells to catch

- **Hardcoded ceilings tuned to today's biggest case** (size/time limits)
  silently truncate on the worst day. Recurred 3+ times. Always size limits to
  the **worst plausible case, not the average.**
- **Set-but-never-cleared state** riding along on re-runs (e.g. a stale Redis
  verdict on a `stage=sources` re-run that reads identical to fresh). Clear
  state you set.
- **200-with-HTML-lie blocks** — TAB returns a 200 with an HTML body when
  blocked, not a 403, so `r.ok` sails straight through. Validate the body shape,
  not just the status.
- **Silent day-late failures** — e.g. tabFinal results 404 on the previous day,
  so AU finals vanish silently if results are pulled a day late. Fail loud.

## Verification ritual (always)

For every file you produce or patch:

1. Node syntax check.
2. Offline unit test where feasible.
3. Exact **byte count and line count**, printed.
4. A deploy block Hammy can copy-paste.
5. For patches: Python patch scripts with **uniqueness-asserted anchors** (assert
   the anchor matches exactly once before replacing).

## Open calibration items (Hammy's call, don't auto-decide)

- **SSOT min-hit threshold:** the gate only fails a source at *literally zero*
  hits, so a homepage scored 1-of-183 and passed as a "verified opinion source"
  on a coin-flip coincidence. Needs a minimum-hit threshold calibrated against
  real tipster scores in stored packs. Hammy decides the number.
- **racing.com is non-load-bearing:** its key can rotate anytime; treat its
  death as graceful degradation to card-only, never a trawl-breaker.

## Reference files

- `references/adapters.md` — France/PMU, Australia/TAB, racing.com adapter
  details, verified match rates, and their traps.
- `references/pipeline.md` — the trawl -> SSOT -> propose -> stewards flow and
  the key files.
