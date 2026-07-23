# Bet Slip Format

The slip mirrors the SGPools app entry flow so it can be keyed straight in.

## Structure

Group by **MEET**. Then one line per bet, in this exact field order:

`Race No / Horse Number / Bet Type / No. of Lots / Horse Name / Reason`

- **Race No** — the SGPools *integrated* race number. Never the source
  tipsheet's numbering. (Locked rule.)
- **Horse Number** — SGPools coupon/horse number.
- **Bet Type** — WIN or PLA (or an exotic type, see below).
- **No. of Lots** — count of $5 units. WIN $10 = 2 lots, PLA $5 = 1 lot.
- **Horse Name**
- **Reason** — the convergence note / why this spot qualified.

## Worked example

```
MEET: Kranji (Singapore)
R3 / 7 / WIN / 2 / Lim's Kosciuszko / Med-High: 4 of 5 pundits top-2, best sectional in field
R3 / 7 / PLA / 1 / Lim's Kosciuszko / (place cover on the same Med-High spot)
R5 / 2 / PLA / 1 / Golden Monkey / Marginal: only place insurance, pace map favourable
```

So a single Med-High spot produces two lines (WIN 2 lots + PLA 1 lot). A
marginal spot produces one PLA-only line.

## On confirmation

When the user confirms the slip, show:

- Total stake (sum of all lots x $5).
- Wallet before and wallet after.
- Flag any mismatch between expected and actual immediately.

## Exotic bets (capped side experiment)

TRIO / FORECAST / QUARTET are logged separately with `Ledger="Exotic"`, kept
apart from the main model ledger and capped.

State plainly whenever proposing one: exotics are higher variance than they
feel. Right horses in the wrong order still loses. Don't let a "we had all the
right horses" feeling disguise a losing bet.

## Ledger separation (locked)

- Wallet ledger and model ledger stay separate.
- A misclick counts financially in the wallet ledger but is NOT a model
  decision — never let it pollute model performance stats.
