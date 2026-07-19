# FOREX_BRAIN.md

Design spec for the automated forex breakout system: a reasoning **brain** (server)
that trawls, converges, and originates breakout ideas, feeding a dumb **hands** layer
(MT5 Expert Advisor) that executes them under hard local guardrails.

Status: DESIGN. Nothing in this document is live. Build order and gates are defined
in Section 9 and are binding. Betting real money is the LAST switch, not the first.

Owner: Hammy (hammyLabs). Repo: mdhamka86/vibe-arcade.

---

## 1. Why this exists

The goal is a hands-off system that, on a session-weighted schedule, forms its own
view on the major forex pairs (trawl the source roster, read the news, converge the
signals, decide if a real breakout is setting up), and then places the trade on the
PhillipNova MT5 account with a coherent stop, target, and risk-based lot size.

The hard architectural fact that shapes everything: an MT5 Expert Advisor is a
sandboxed program. It can read prices, size and place orders, and loop 24/7 on the
VPS, but it CANNOT trawl the web, run JavaScript-rendered sources, read news, or
reason. Convergence and judgment need a brain (an LLM with real fetching), which
lives on a server, not inside the terminal.

Therefore the system is split in two:

- **Brain** (server): originates verdicts. Reuses the Stewards' Room / Exchange /
  Terminal backbone (Vercel serverless + Upstash Redis + Anthropic API).
- **Hands** (MT5 EA): reads the latest verdict from a Redis-backed endpoint,
  confirms the live-price breakout, sizes the lot, executes, and manages the trade.
  It never reasons.

The two halves communicate through one contract only: the **verdict object**
(Section 4).

---

## 2. Non-negotiables

These are the rules the whole system is designed around. They override convenience.

1. **The brain must not fail silently.** A trawl that half-works and emits a verdict
   from partial data is worse than no verdict. Every verdict declares which sources
   it actually reached (Section 5). Missing sources shrink conviction or force FLAT.
2. **FLAT is a first-class, common answer.** Doing nothing is the default, not a
   failure. Forcing a trade every cycle is how the account bleeds. This is the
   deliberate opposite of the Outsider Method "never stand down" idea rule, because
   that is a journal for scoring and this is real auto-execution.
3. **The hands never trust a raw lot size.** The verdict sends `riskPercent`; the EA
   computes the lot from its own live balance and the actual SL distance, then caps
   it locally. Size by the stop, never by a number handed down. (The Spread week-one
   lesson, encoded.)
4. **SL and TP are absolute prices, not distances.** Zero ambiguity for the EA to
   fumble. The brain does the arithmetic; the EA places finished numbers. (Same
   single-source-of-truth principle as the SGPools card-matching rule.)
5. **Stale verdicts are ignored.** Every verdict carries `expiresAt`. A VPS hiccup or
   a stalled brain must never cause the EA to act on an old view of a moved market.
6. **No verdict is acted on twice.** Every verdict carries a unique `verdictId`; the
   EA records which ids it has executed and refuses repeats.
7. **Guardrails live in the hands, not the brain.** The lot cap, the daily-loss
   circuit breaker, the max-open-positions limit: all enforced locally in the EA, so
   a compromised or buggy brain still cannot exceed the account's hard limits.

---

## 3. Watchlist (v1)

The seven USD majors, and only these, for version one:

| Pair | Nickname | Best session (Phuket UTC+7) |
|---|---|---|
| EUR/USD | Euro / fibre | London open (~3pm), LDN/NY overlap (8pm-midnight) |
| USD/JPY | Yen | Tokyo open (~7am), NY open (~8pm) |
| GBP/USD | Cable | London open (~3pm), LDN/NY overlap |
| USD/CHF | Swissy | London open |
| AUD/USD | Aussie | Tokyo/Asia open (~6-8am) |
| USD/CAD | Loonie | NY open (~8pm) |
| NZD/USD | Kiwi | Tokyo/Asia open |

Expansion candidates for v2 once the core is proven: the yen crosses (EUR/JPY,
GBP/JPY), which suit the Asia-open window. Kept out of v1 to keep the trawl focused
and the API cost bounded. Broker symbol spelling must be confirmed against the live
PhillipNova symbol list before the EA consumes any verdict (the `symbol` field must
match exactly, suffixes and all).

---

## 4. The verdict object (the contract)

The single hand-off between brain and hands. Written to Redis by the brain, read by
the EA. One verdict per pair per cycle.

| Field | Type | Example | Purpose |
|---|---|---|---|
| `verdictId` | string | `"2026-07-20T08:00Z-eurusd"` | Unique; the EA never acts on the same id twice. |
| `symbol` | string | `"EURUSD"` | Exact broker symbol. Must match PhillipNova spelling. |
| `direction` | enum | `"BUY" \| "SELL" \| "FLAT"` | FLAT means stand down. Expected to be the common case. |
| `conviction` | int 0-100 | `72` | Brain confidence. EA has a minimum threshold below which it will not act. |
| `entryZone` | object | `{ "trigger": 1.0900, "maxChase": 1.0915 }` | Price level to break, and the furthest the EA may chase before refusing a late entry. |
| `slPrice` | float | `1.0812` | Absolute stop price. Not a distance. |
| `tpPrice` | float | `1.0920` | Absolute take-profit price. |
| `riskPercent` | float | `0.5` | EA sizes the lot from this plus the SL distance. Never a raw lot. |
| `expiresAt` | ISO time | `"2026-07-20T12:00Z"` | After this, the verdict is dead and ignored. |
| `sourcesReached` | object | `{ "hit": 9, "expected": 12, "missing": ["..."] }` | Trawl integrity. See Section 5. |
| `rationale` | string | `"ECB hawkish, EUR coiled under 1.0900..."` | Human-readable why. For the journal only; the EA ignores it. |

### Validation before an order

The EA must pass ALL of these before placing anything:

- `direction` is BUY or SELL (FLAT -> do nothing).
- `verdictId` not already in the executed set.
- `now < expiresAt`.
- `conviction >= EA_minConviction` (an EA input; starts high, e.g. 70).
- live price is on the correct side of `entryZone.trigger` (breakout confirmed now).
- live price has not passed `entryZone.maxChase` (not a late entry).
- `slPrice` and `tpPrice` are on the logically correct sides of entry for the
  direction, and the broker's minimum stop distance is respected.
- spread is within an EA-input ceiling (skip if blown out at the open).
- computed lot, after local cap, is >= broker minimum and <= the hard lot cap.

Any check failing = no order, log the reason. Silence is never an order.

---

## 5. Trawl integrity (the "must not fail" core)

The trawl-and-converge core is the critical element. Its correctness is worth more
than its coverage. The design principle: **the brain must always know how much of its
own picture is real, and must degrade honestly when it is not.**

Mechanisms:

- **Source manifest.** The brain holds an explicit list of the sources it intends to
  consult for a given pair and session. Each cycle it records which it actually
  reached vs which failed (timeout, JS-render failure, empty response). This becomes
  `sourcesReached` on the verdict.
- **Endpoint-first fetching.** Many high-value sources are JS-rendered (the same
  problem the Stewards' Room trawl already solved). Prefer fetching the underlying
  JSON/XHR endpoint the page's JS calls; fall back to a rendered fetch only for
  stubborn high-value sources. Cache results in Redis so a later cycle is not blocked
  by a slow source.
- **Convergence floor.** If fewer than a configured number of independent sources
  were reached for a pair, the brain does not emit a directional verdict for that
  pair. It emits FLAT with a rationale noting the shortfall. Never fabricate
  conviction from thin data.
- **Source weighting mirrors the locked roster philosophy.** Prioritise the
  objective, crowd-underweighted sources (de-vig / +EV / closing-line / stats-model
  analogues) over pure tipster/consensus feeds, because the crowd piles onto the same
  obvious levels and the edge is in what the crowd underweights. NOTE: forex on
  PhillipNova is fixed-odds-like from the trader's seat, not a parimutuel tote, so the
  racing "fade the overbet longshot" framing does NOT transfer; the transferable part
  is only "prefer objective signal over consensus noise."
- **News awareness.** The brain must weight scheduled high-impact events (rate
  decisions, CPI, NFP, central-bank speakers). A breakout minutes before a red-folder
  event is usually a trap; the brain should either fade conviction or hold FLAT into
  the release. The trawl therefore includes an economic-calendar source and the
  verdict rationale should name any imminent event.

### Testing the trawl (heavily, as required)

The trawl is shaken down on paper long before any EA exists:

1. **Golden fixtures.** Capture real trawl outputs for known past sessions and assert
   the parser extracts the right fields. Any source that changes its shape breaks a
   test loudly, not silently.
2. **Source-failure simulation.** Force each source to time out / return empty / return
   garbage, and assert the brain degrades correctly (shrinks conviction or goes FLAT,
   never emits a confident verdict from partial data).
3. **Determinism check on the plumbing.** The fetch/parse/manifest layer is
   deterministic and unit-tested; only the reasoning layer is model-driven. Keep the
   boundary clean so failures are attributable.
4. **Convergence-floor test.** Feed it a pair with only one reachable source; assert
   it returns FLAT.
5. **Staleness test.** Assert every verdict has a sane `expiresAt` and that a verdict
   past expiry is rejected by the consumer logic.
6. **Shadow week.** Run the whole brain live-but-paper for at least a week: it writes
   real verdicts to Redis on the real schedule, and they are reviewed like trade notes.
   No EA, no orders. Verdicts must look sane before the hands are wired up.

---

## 6. Cadence

Session-weighted, cron-driven on the server (proven ground: the essenceofclaude
GitHub Actions cron already runs Claude on a schedule). All times Phuket (UTC+7).

Fire hourly through the high-energy windows, stay quiet in the dead local-afternoon
lull where breakouts tend to be fakeouts:

- **Asia / Tokyo open:** ~6am-11am, hourly. (AUD, NZD, JPY pairs.)
- **Local-afternoon lull:** ~12pm-2pm, skip or a single light check.
- **London open:** ~3pm, then hourly. (EUR, GBP, CHF.)
- **London / New York overlap (golden window):** ~7pm-midnight, tight hourly. The most
  liquid, most breakout-prone stretch of the day. All majors.
- **Post-overlap taper:** after midnight, wind down.

Roughly 12-14 firings a day concentrated where breakouts happen, not 24 even ones.

Day-of-week awareness: Friday afternoon into the weekend close is thin and choppy;
Sunday reopen is gappy; Monday Asia can gap on weekend news. The brain lightens up or
raises its conviction bar at these edges.

Historical note (for the rationale, not the code): the session rhythm is a ghost of
the physical dealing-desk hours of 1980s Tokyo/London/New York banks. The overlap is
hottest because that is when two sets of institutions were both at their desks. The
market went electronic and global, but the liquidity still follows those office hours.

---

## 7. Architecture

```
                          CRON (session-weighted schedule)
                                     |
                                     v
   +------------------------- BRAIN (server) --------------------------+
   |  trawl forex roster  ->  converge  ->  reason (Anthropic API)     |
   |  economic calendar   ->  source manifest + integrity check        |
   |  live price context  ->  originate breakout level, SL, TP, risk   |
   +----------------------------------+-------------------------------- +
                                      |  writes verdict object
                                      v
                             UPSTASH REDIS  (latest verdict per pair)
                                      ^
                                      |  GET latest verdict (JSON)
   +------------------------- HANDS (MT5 EA) --------------------------+
   |  one whitelisted WebRequest to own Redis-backed endpoint         |
   |  validate (Section 4) -> confirm live breakout -> size lot       |
   |  -> local caps -> execute -> manage (BE / trail / time exit)     |
   |  -> log every decision (acted or skipped) to journal             |
   +-------------------------------------------------------------------+
```

Serverless functions live in `api/` (e.g. `api/forex-brain.js`, `api/forex-verdict.js`).
Front-end monitor (a read-only dashboard of current verdicts and the journal) lives in
`public/forex-brain.html`. Redis key namespace: `forex:verdict:<symbol>` for the latest
verdict, `forex:journal:*` for the decision log. Design follows the desloppified
standard (no gradient text, no glassmorphism, clean minimal, ADHD-friendly, inline SVG
line-art icons).

Deploy note (locked repo rule): every front-end file goes to
`~/projects/vibe-arcade/public/<name>.html`, never the repo root; `exchange-seed.js`
-style pure data modules must NOT sit in `api/`. Verify byte counts with `wc -c` before
committing (the silent-truncation incident precedent).

---

## 8. The hands (MT5 EA) responsibilities

Deliberately dumb. In scope:

- One whitelisted `WebRequest` to the brain's Redis-backed verdict endpoint.
- Parse the returned JSON verdict (no reasoning; structured fields only).
- Run every validation check in Section 4.
- Confirm the breakout is real at the live price right now.
- Compute lot from `riskPercent`, live balance, and SL distance; apply local hard cap.
- Place the order with `slPrice` / `tpPrice`.
- Manage the open trade: break-even, trailing stop, optional time-based exit (this is
  where the Universal Breakout EA's management logic can be reused).
- Log every decision (acted OR skipped, with reason) to the journal endpoint.

Out of scope (never): trawling, reading news, reasoning, forming its own directional
view, overriding a verdict, sizing beyond the hard cap.

### Local guardrails (enforced in the EA)

- **Hard lot cap.** Starts at 0.01 micro-lots regardless of what `riskPercent` implies.
- **Daily-loss circuit breaker.** If realised loss for the day exceeds a set figure,
  stop opening new trades for the rest of the session.
- **Max open positions.** A small integer cap; no stacking into one view.
- **Min conviction gate.** Ignore verdicts below the threshold.
- **Spread ceiling.** Skip if the spread is blown out.
- **Kill switch.** A single input / global that disables all order placement (the EA
  still logs what it *would* have done). This is the master safety.

---

## 9. Build order and gates (binding)

Each phase must pass before the next begins. This is the whole risk-management spine.

- **Phase 1 - Brain core, paper only.** Build the trawl/converge/manifest/verdict
  pipeline. No EA. Passes when the golden-fixture, source-failure, convergence-floor,
  and staleness tests all pass.
- **Phase 2 - Shadow week.** Brain runs live-but-paper on the real schedule, writing
  verdicts to Redis. Reviewed daily like trade notes. Passes when a week of verdicts
  reads as sane (sensible FLAT rate, no confident calls off thin data, news respected).
- **Phase 3 - Hands in log-only mode.** EA fetches verdicts and writes what it WOULD
  have done to the journal, with the kill switch ON so it places nothing. Passes when
  logged decisions match what a human would consider reasonable over another week.
- **Phase 4 - Strategy Tester.** Run the execution logic against historical data to
  confirm the mechanics (sizing, SL/TP placement, management, caps) behave.
- **Phase 5 - Demo account, live orders.** Kill switch off, on a DEMO account only.
  Real order flow, fake money, real schedule, for a good long while.
- **Phase 6 - Live micro.** Only if Phases 1-5 look sound over weeks. Live account,
  0.01 lots, daily-loss breaker armed, kill switch reachable. Reviewed continuously.

No profitability claim is made or implied at any phase. The system can be built to be
rigorously TESTED; whether it has a real edge is decided by the evidence, not by
optimism.

---

## 10. Open questions (to resolve before Phase 1)

- Confirm exact PhillipNova broker symbol spelling for all seven majors (suffixes?).
- Confirm the broker server GMT offset (blocked on a weekday market-open reading; the
  `CheckBrokerOffset` script is ready). Needed so the brain and EA agree on session
  timing.
- Decide the convergence floor number (minimum independent sources per pair).
- Decide `EA_minConviction` starting value.
- Decide the daily-loss circuit-breaker figure for the demo and micro phases.
- Finalise the source manifest per pair/session from the locked forex roster.
