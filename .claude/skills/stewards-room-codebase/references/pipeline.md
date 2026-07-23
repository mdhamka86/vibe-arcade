# Pipeline & Key Files

## Flow

```
8am trawl (trawl.js)         deep per-meet dives, endpoint-first, cached in Redis
      |
      v
SSOT layer                   single source of truth; sees only SGPools raceNo,
                             never source numbering
      |
      v
convergence model (propose.js)   builds the grid, classifies bands, proposes betlist
      |
      v
Stewards' Room (stewards.js / stewards.html)   the desk: ledger, calibration, export
```

## Key files (as of the 22 July overhaul)

- `trawl.js` — the 8am deep trawl. Per-meet dives into tips/pundits/form
  (horses, jockeys, track, going, weather). Endpoint-level scraping + rendered
  fallbacks. Region routing lives here (watch `regionOf()` ordering — "Perth,
  Scotland" once matched before "Australia").
- `propose.js` — convergence model, band classification, betlist proposal.
- `stewards.js` / `stewards.html` — the front-end desk: Ledger, Calibration,
  export to the versioned xlsx workbook. Calibration tab computes WIN/PLA split
  and confidence tiers live off the corrected record.
- `probe.js` — token-guarded scouting endpoint for testing price/data sources
  from real production (syd1) before writing adapter code.
- `vercel.json` — function config. Keep maxDuration caps above real runtime;
  purge stale references to deleted files.

## SSOT integrity

The desk shows a green/amber/red lamp on whether the Redis copy is provably
byte-identical to the journal. Green means the cloud copy matches the row-by-row
journal built since Royal Ascot. Protect that invariant — never write to the
SSOT in a shape that can't be verified byte-identical.

## Redis discipline

Cache trawl output so the app opens lag-free, but clear any verdict/flag state
you set. A set-but-never-cleared verdict on a `stage=sources` re-run reads
identical to a fresh one and can suppress the very meets a fix just repaired.
