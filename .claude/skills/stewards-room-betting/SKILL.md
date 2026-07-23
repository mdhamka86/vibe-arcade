---
name: stewards-room-betting
description: Runs Hammy's horse racing analysis and betting workflow (the Outsider Method) for SGPools/Singapore Pools parimutuel racing. Use when the user wants to analyse a raceday, triage meets, build a convergence grid, produce a bet slip, or run results recon. Triggers include "horsies", "the horses", "do the racing", "let's do the horsies", "results time", "trawl the results", or any mention of SGPools racing, meets, convergence, or the Outsider Method.
license: Proprietary. For Hammy / hammyLabs use.
metadata:
  author: hammyLabs
  version: "1.0"
---

# The Stewards' Room — Betting & Analysis

This skill encodes the full raceday workflow for the Outsider Method: how to
triage meets, reconstruct the convergence grid, apply staking rules, emit a
SGPools-format bet slip, and run results recon. It is the chat-side companion
to the automated Stewards' Room trawl app.

## Core premise (why the edge exists)

SGPools is a **parimutuel (tote) market**, not a fixed-odds book. The classic
bookmaker "back-favourites" edge is weak/eroded here. The real exploitable edge
is **fading or avoiding overbet longshots and milking the place (PLA) pool**.
WIN-pool bets underperform PLA structurally. Bias the whole book toward
**Medium-High convergence**, the only solidly green band (~+19.2% ROI).

Confidence labels are a **calibration gauge only, never a staking input**.
(History shows confidence-label inversion: High picks have underperformed
Low-Med.) Stake by convergence and the flat rules below, not by confidence and
never by emotion.

## The workflow, in order

1. **Anchor the date.** Always confirm the real current date before any search
   (use the time tool if available). Never assume raceday from memory.
2. **Triage the meets.** Rank on field depth, prize money, feature-race status,
   and analysis availability. See `references/triage.md`.
3. **Cross-check layer — on EVERY meet, no exceptions.** Sectionals + pace maps
   run at triage for every meet, not just the top picks. Never skip because the
   bash network is off; web_search/web_fetch still work.
4. **Mandatory external-opinion check — on EVERY meet analysed.** Not just the
   ones you fancy. This is a standing rule. Reconstruct the pundit grid, don't
   skim it. See `references/convergence.md` for how the grid is built.
5. **Build the convergence grid** and classify each spot's band.
6. **Apply staking rules** (below / `references/staking.md`) to turn the grid
   into a betlist.
7. **Emit the bet slip** in exact SGPools format. See `references/bet-slip.md`.
8. **On confirmation:** show total stake, wallet before/after, flag any
   mismatch.
9. **Results recon** when the user says "results time" or "trawl the results":
   FIRST search chat history for that day's specific bets, never rely on memory,
   then trawl results and produce the Day Summary. See `references/results.md`.

## Staking rules (flat-stake, locked from 26 June 2026)

- Standard unit is **$5**. All increments in $5 only.
- **Med-High convergence:** flat **$10 WIN + $5 PLA**.
- **Marginal spots:** **$5 PLA-only**.
- Lots = number of $5 units. So WIN $10 = 2 lots, PLA $5 = 1 lot.
- Do not chase losses. Do not size by emotion or by confidence label.
- A staking-change gate exists — do NOT bump sizing casually. See
  `references/staking.md` for the gate conditions.

## Bet slip format (SGPools app flow)

Group by **MEET**, then one line per bet:

`Race No / Horse Number / Bet Type / No. of Lots / Horse Name / Reason`

Full rules, worked example, and the exotic-bet handling are in
`references/bet-slip.md`.

## Ledger discipline (locked)

- Keep the **wallet ledger** separate from the **model ledger**.
- Misclicks count financially (wallet) but NOT as model decisions.
- Exotic bets (TRIO/FORECAST/QUARTET) are a capped side experiment, logged
  separately with `Ledger="Exotic"`. They are higher variance than they feel:
  right horses in the wrong order still loses. Say so explicitly when proposing
  one.
- All slips use SGPools **integrated race numbers and coupon codes**, never the
  source tipsheet's own numbering. This rule is locked.

## Output style

- Casual, warm, banterish. Address the user as Hammy, bro, or mate.
- No em dashes in prose.
- Space out long paragraphs.
- Don't end with a filler question just to keep talking; only ask when
  genuine clarification is needed.
- Validate claims (odds, form, going, results) via live search rather than
  asserting from memory.

## Reference files

- `references/triage.md` — meet triage and ranking
- `references/convergence.md` — building the pundit convergence grid
- `references/staking.md` — full staking rules and the sizing-change gate
- `references/bet-slip.md` — SGPools slip format, worked example, exotics
- `references/results.md` — results recon and the Day Summary format
