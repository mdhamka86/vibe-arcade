# Results Recon

Triggered when the user says "results time" or "trawl the results".

## Critical first step

**Search chat history for that day's specific bets FIRST.** Never reconstruct
the day's betlist from memory. Find the actual slip that was logged, then go
trawl the results against it.

## Then trawl results

Anchor to the real current date, then pull the official results for each meet
on the slip (region sources per `triage.md`). Match horses by name against the
SGPools card.

## Day Summary output

Produce, in this shape:

1. **Day Summary header** — opening wallet, total stake, total payout, net P/L,
   ROI for the day.
2. **Bet-by-bet table** — each line from the slip with its result and P/L.
3. **Stats** — running/updated splits (WIN vs PLA, convergence bands,
   confidence calibration).
4. **Lessons** — honest notes on what the day taught the model. Flag any
   confidence-label inversion or WIN-underperformance the day reinforced.

## Keep the ledgers honest

- Wallet P/L and model P/L are separate lines.
- Misclicks hit the wallet but are excluded from model performance.
- Exotics report under their own `Ledger="Exotic"` line, not mixed into the
  core model ROI.
