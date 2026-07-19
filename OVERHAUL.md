# THE OUTSIDER METHOD — OVERHAUL SPEC
**Date:** 19/07/2026 · **Status:** Betting suspended pending overhaul · **Journal ref:** v52 seed, rev 67

---

## Why we are here (the evidence)

All figures from the live stewards ledger, model legs only (Exotic excluded), settled legs as of 18/07/2026.

| Window | Legs | Net | ROI |
|---|---|---|---|
| Last 7 racing days (12/07–18/07) | 106 | −$249.80 | −22.3% |
| Everything before that | 379 | −$353.70 | −13.4% |
| Whole book | 485 | ≈ −$603 | ≈ −16% |

Three structural findings, each with its own fix in this spec:

1. **Price blindness.** 116 of 192 cashed PLA legs (60%) paid $1.00–$1.30 per $1. Average cashed PLA div is $1.41–$1.44 against a breakeven need of $1.63–$1.79. Nearly all WIN collects sit between $1.00 and $2.00. The model backs consensus favourites into a tote pool with high-teens takeout. This is unwinnable regardless of selection skill.
2. **The Med-High gate has inverted.** Early-sample calibration showed Med-High at +19.2%. Over all 199 settled Med-High legs it is now **−17.6%**, and its share of daily legs has crept from 36% to 60% (label creep / Goodhart's law: the gate became a target and stopped gating). The founding calibration rule is empirically dead.
3. **Source starvation didn't stand the model down.** When external sources were withheld (the Perth routing bug, thin Korea coverage), WIN legs were gated but PLA legs kept flowing off SGPools-internal-only "convergence", i.e. SGPools agreeing with itself. 15/07 AU: 7 legs, −$70 in one day under exactly these conditions. Recent AU book: −86.8% ROI.

---

## PHASE 0 — Deployed ✅

**0.1 · trawl.js: country-first region routing.**
`regionOf()` tested the UK course list (which contains `perth`, for Perth Racecourse, Scotland) before the Australia country test, so "Australia (Perth)" was tagged region UK, UK pundit sources were fetched, verification correctly found zero runner matches, and all external sources were withheld as wrong-meeting. Fix: explicit country words now win before any course-name heuristic. Same trap defused for Newcastle, Sandown, Ascot, Wellington.
*File: api/trawl.js · 38,743 bytes · 735 lines · pushed and live.*

---

## PHASE 1 — Patched, ready to deploy

**1.1 · propose.js: evidence grouper coverage.**
`regionOf()` in the evidence block didn't recognise Malaysia, Turkey, Germany, **or any ledger short code** (SA/FR/UK/MB/AU/PE/SK…). Because the betlog stores meets as short codes, virtually every settled leg fell into "Other" and the by-region evidence table fed to the model each morning was blind. The model never saw AU running at −86.8% or SK at 0-for-2.
*File: api/propose.js (delivered) · expected **55,248 bytes / 1,179 lines** · verify with `wc -c` before commit.*

**1.2 · Remove api/triage.js.**
Orphaned legacy v1 scanner (nothing calls it; front-end hits only trawl/stewards/propose). Still carries the silent stale-date fallback (`dates[0]`) that returned a six-day-old card on 17/07. Delete so nobody curls it by habit: `git rm api/triage.js`.

**Deploy block:**
```bash
cp ~/Downloads/propose.js ~/projects/vibe-arcade/api/propose.js
wc -c ~/projects/vibe-arcade/api/propose.js   # must be 55248
wc -l ~/projects/vibe-arcade/api/propose.js   # must be 1179
cd ~/projects/vibe-arcade
git rm api/triage.js
git add api/propose.js
git commit -m "fix: regionOf covers MY/TR/DE + ledger short codes; remove orphaned triage.js"
git push
```

---

## PHASE 2 — Gating & discipline (propose.js logic, no new data needed)

**2.1 · Stand-down rule (hard gate).**
If a meet's external sources are ALL withheld or absent, that meet gets **zero legs**. Not PLA-led legs, not "one speculative WIN". No independent external convergence = no convergence = no bet. Implementation: propose reads the trawl's per-meet source verdicts; any meet with 0 verified external sources is moved to `skipped` with reason `no external convergence`.

**2.2 · Anti-consensus PLA rule.**
Never place-bet the consensus #1 pick. The unanimous top pick is the $1.10–$1.30 dividend generator (60% of all historical PLA collects). If the model loves a race that strongly, allowed shapes are: the #2-ranked convergence horse PLA, or the #1 horse WIN-only (subject to 3.2 price floor once live, or Phase 2 interim: WIN-only where at least one quality source rates it clearly above the market's likely favourite).

**2.3 · Field-size floor.**
No PLA legs in fields of 8 or fewer. Three places in a tiny field breeds odds-on place divs (Scottsville R1 on 19/07, an 8-runner maiden sprint, is the archetype). Preferred PLA habitat: handicaps with 10+ runners.

**2.4 · Retire the Med-High gate as-is; cut Medium.**
Medium band: −32.9% recent, cut entirely. Med-High no longer functions as a quality gate (2. above); until the price layer lands, confidence labels revert to pure calibration gauges with **no** volume or selection privileges. The selection gate becomes: verified external convergence (2.1) + structural filters (2.2/2.3).

**2.5 · Volume follows source depth, not card size.**
Max legs per meet proportional to the number of independent verified external sources (e.g. 0 sources → 0 legs; 1 source → 2 legs max; 2+ sources → 4 legs max). Last week France carried 17 legs at −29.4% with zero external press while the deep-press UK book ran −5.9%. The trawl already counts verified sources per meet; propose enforces the cap.

---

## PHASE 3 — The price layer (the big build, and the only path to positive)

**3.1 · Trawl: scrape assessed/rated prices + morning odds into the pack.**
New trawl stage per meet, cached in Redis alongside sources:
- **Racing & Sports assessed prices** (AU, SA, HK — RAS publishes ratings-derived "assessed odds" per runner). Primary value benchmark.
- **Morning fixed-odds boards** from the existing per-region source roster (Racenet AU, Gold Circle/press SA, Racing Post spot-checks UK) as market anchor where tote approximates aren't reachable.
- Pack schema addition per runner: `{ assessed: 4.5, morning: 3.2, source: "ras" }`. Missing data is an explicit `null`, never a guess.

**3.2 · Propose: overlay maths + dividend floors.**
- **PLA floor:** projected place div ≥ **$1.60**, else pass.
- **WIN floor:** projected div ≥ **$2.50**, OR assessed price meaningfully shorter than market price (overlay ≥ ~20%).
- **Overlay definition:** `morning/tote price > assessed price` → the crowd underrates the horse → candidate. This flips the system from "who wins" to "what's mispriced", which is the only question a parimutuel market pays out on.
- Every leg logs `assessed`, `morningPrice`, and (post-race, via 5.1) `divPaid`, so the journal can compute a tote-flavoured closing-line-value measure over time.

**3.3 · Rollout discipline.**
Price layer ships in shadow mode first: one full week where propose computes the price verdict on every candidate leg and logs it, but the Phase 2 rules alone decide the book. Compare shadow-book vs actual before the floors go live.

---

## PHASE 4 — Convergence inversion (model philosophy)

The convergence grid stays, but its role flips: the consensus #1 becomes the **market anchor** (where the money is crushed), not the bet. The value tier is the horse ranked 2nd–3rd by *quality* sources (Gold Circle analyst, RAS ratings) that mass tips ignore. Weight source quality over source count: three syndicated tips repeating each other is one opinion, not three. This is the Outsider Method's founding law (avoid crowded money) finally pointed the right way round — the current engine is a crowded-money detector aimed at itself.

Prompt changes in propose: convergence output restructured as `{ anchor: horse, valueTier: [horses], loneOpinions: [...] }` and legs must come from valueTier unless a WIN-at-a-price case is made against the anchor.

---

## PHASE 5 — Settle data upgrade (make the journal able to teach)

**5.1 · stewards.js `settle` action captures, per leg:** actual finish position (integer, not "UNPLACED"), the dividend paid on the leg's horse (WIN and PLA where applicable), the favourite's div, and field size. Current log has 96 of 128 losing PLA legs with position "NONE", which made near-miss vs blowout analysis impossible.

**5.2 · Evidence block additions** (feeds the model each morning, now that 1.1 makes regions visible): ROI by price band ($<1.40 / 1.40–1.79 / 1.80–2.49 / 2.50+), ROI by field size, near-miss rate (4ths in PLA). Goal: the model learns "PLA under $1.40 has never been profitable" from its own ledger rather than a hard-coded rule.

---

## PHASE 6 — Pace as a scored input

Standing rule already demands pace maps at triage; upgrade from prose to a number. Deep-dive stage emits per race: `{ loneSpeed: horseNo | null, paceShape: "genuine" | "moderate" | "muddling" }` from iRace / RAS pace maps (AU, HK) and sectional data where published. A lone-speed flag on a valueTier horse is a bet-strengthener; a valueTier closer into a muddling pace is a downgrade. Front-runners with soft leads remain one of the few crowd-underweighted angles in public data.

---

## Journal & standing-rule updates (ratify on resume)

1. **Retire** the "+19.2% Med-High green band" calibration and the selection-bias rule built on it (falsified: −17.6% over 199 legs).
2. **Retire** the staking-gate plan ("bump to $7–8 after 35–40 green Med-High lines") — precondition can no longer be met under the old definition.
3. **Adopt** Phases 2–6 rules above as the new standing law once each phase deploys.
4. **Restart criteria:** betting resumes only when Phase 1 + Phase 2 are deployed and Phase 3 shadow mode is logging. Full stakes only after the shadow week is reviewed.

## Success metrics (what "fixed" looks like)

- Average cashed PLA dividend ≥ **$1.70** (from $1.41–$1.44).
- Zero legs on meets with no verified external source.
- Consensus-#1 PLA legs: **zero**.
- Review checkpoints at every 50 settled legs under the new rules; no ROI verdicts before 100 legs (variance floor).
- Book-level target for the first 100-leg block: beat −5% ROI (i.e. inside the takeout drag), then reassess for positive expectancy once the price layer is fully live.

## Build order

| # | Item | Type | Effort |
|---|---|---|---|
| 1 | Deploy propose.js patch + rm triage.js | git push | 5 min |
| 2 | Phase 2 gating rules in propose.js | code + prompt | 1 session |
| 3 | Phase 5.1 settle capture | stewards.js | 1 session |
| 4 | Phase 3.1 price scrape (RAS first, AU+SA) | trawl stage | 1–2 sessions |
| 5 | Phase 3.2 floors + shadow mode | propose.js | 1 session |
| 6 | Phase 4 convergence inversion | prompt rework | 1 session |
| 7 | Phase 6 pace scoring | deep-dive stage | 1 session |
| 8 | Phase 5.2 evidence bands | propose.js | small |
