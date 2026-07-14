---
target: public/index.html
total_score: 30
p0_count: 0
p1_count: 1
timestamp: 2026-07-14T13-30-29Z
slug: public-index-html
---
Method: dual-agent (A: a6e97b6e90366696c · B: a3b014dfe6b9827ad)

# Critique — `public/index.html` (hammyLabs front door)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Good hover/`:active` feedback; `<title>…New!</title>` promises novelty nothing on the page marks. |
| 2 | Match System / Real World | 4 | Natural, personal language; bespoke metaphorical icons. Best trait on the page. |
| 3 | User Control and Freedom | 3 | Plain links + back button; nothing to trap. Largely n/a. |
| 4 | Consistency and Standards | 3 | Internally consistent, but contradicts its own DESIGN.md (paper-flat vs hover shadow; muted-as-body); `font-weight:650` isn't a loaded weight. |
| 5 | Error Prevention | 3 | Static link list; safe same-tab nav. n/a. |
| 6 | Recognition Rather Than Recall | 3 | Icons+names aid recognition, but the gold/green/violet badge code has no legend. |
| 7 | Flexibility and Efficiency | 2 | 16 equal-weight tiles, no search/filter/featured/recent. Must eyeball the whole wall. |
| 8 | Aesthetic and Minimalist | 3 | Clean palette, but low-contrast descriptions + redundant "Game" badges add avoidable noise. |
| 9 | Error Recovery | 3 | n/a for a launcher. |
| 10 | Help and Documentation | 3 | Self-explanatory; insider references aside. |
| **Total** | | **30/40** | **Good — solid foundation, not yet excellent** |

## Anti-Patterns Verdict

**Does it look AI-generated? No — it reads as human-made.** The single biggest anti-slop signal is 16 bespoke hand-drawn 24×24 line icons, each metaphorically matched to its app (no icon library), plus insider, specific copy that no generator would produce.

**LLM review:** Clean against the DON'T list — no gradient text, no glassmorphism, no hero-metric block, no numbered markers, no side-stripe borders, overflow handled (`-webkit-line-clamp:2` + `min-width:0`). Two motifs are the exact templated tells but are **defensible here**: (1) the tiny uppercase tracked kicker appears 4× (`.masthead .eyebrow` + three `.section-label`) — the one thing to watch, though it functions as real wayfinding; (2) the 16-item identical card grid — normally a DON'T, but a uniform list is the *correct* affordance for a launcher, and it's a genuine list, not fake-variety padding.

**Deterministic scan** (`detect.mjs`, exit 2, 11 findings across 4 rules):
- `overused-font` ×2 + `single-font` ×1 — all fire on Inter being the only family. **False positive:** Inter is a committed identity choice (documented in DESIGN.md); identity-preservation applies. Three findings, one non-issue.
- `design-system-font-size` ×6 (27px, 11.5px, 8.5px, 12px, 11px, 24px) + `design-system-radius` ×1 (9px) — advisory "off the ramp" flags. Mostly low-signal, **but two of them coincide with a real legibility problem**: the 8.5px badge text and 11.5px description text are genuinely small (see below).

**Visual overlays:** Not available — no browser automation tool is exposed in this session, so no in-page overlay was injected. Evidence is detector CLI + source facts only (not a degraded run: both isolated assessments completed).

## Overall Impression

This is a warm, genuinely human "proud shelf" that mostly earns its brief — and then mutes its own best asset. The wit and craft are real, but the item copy (the actual pitch for each app) is rendered in low-contrast grey at 11.5px, so the shelf reads slightly *faded* rather than proud, and the one burnt-orange "stamp" the brand promises is spent only inside 8.5px badges where nobody sees it at reading distance. **Biggest single opportunity: fix the contrast and spend the accent with intent — make the shelf look as confident as it sounds.**

## What's Working

1. **16 bespoke line icons** — unique, metaphorically apt (`stroke-width:1.6`, rounded caps), no library. Real craft and the strongest human signal on the page.
2. **Copy voice** — h1, tagline, Lab teaser, and footer love-note all hold the warm, self-deprecating maker's-workshop register without slipping corporate. The peak-end beat ("Made with love for Lil Naddy 🐱") lands.
3. **Disciplined restraint** — one paper palette, careful overflow handling, no slop tells. Technically tidy and on-brand.

## Priority Issues

**[P1] `.app-desc` fails WCAG AA and violates DESIGN.md's own rule.**
- **Why it matters:** This muted grey is the primary reading text for every shelf item — `.app-desc { color: var(--muted) /*#8A867C*/; font-size: 11.5px }` measures ≈3.6:1 on the white cards (AA needs 4.5:1). Both assessments landed here independently. DESIGN.md explicitly reserves `--muted` for labels and says reading text must be `#57544D` or darker. The whole "proud shelf" pitch is under-legible, worst for one-handed outdoor reading.
- **Fix:** `.app-desc` → `color: var(--ink-soft)` (`#57544D`, ≈7:1). Same for the 11px `.footer` and the 10px section labels if you want them to clear AA too.
- **Command:** `/impeccable harden`

**[P2] The gold "Game" badge is redundant on all 8 game cards.**
- **Why it matters:** Every card under the "Games" header also carries a gold `Game` badge — pure duplication of the section heading. It spends the brand's promised single "stamp" colour on zero-information noise, so gold reads as "= game" instead of "special." (The Tools section, by contrast, usefully mixes `Tool`/`AI-Powered`.)
- **Fix:** Drop the plain "Game" badge; reserve badges for genuine signal (AI-Powered, Tool, New).
- **Command:** `/impeccable distill`

**[P2] Wall of 16 equals with no featured entry — and a "New!" title nothing fulfils.**
- **Why it matters:** 16 equal-weight rows, nothing highlighted; `<title>hammyLabs - New!</title>` promises "new" but no tile is marked new, so the newest work is buried mid-list. No "start here" for a friend opening the link; mild wall-of-options (Hick's law) and the efficiency point-loss.
- **Fix:** Give the 1–2 newest a burnt-orange "New" stamp (spending the accent meaningfully) and/or float one featured tile above the Games section; consider newest-first ordering.
- **Command:** `/impeccable layout`

**[P2] No custom focus state on the tiles.**
- **Why it matters:** `.app-card` defines only `:hover` and `:active` — there is no `:focus-visible`/outline anywhere, so keyboard users get only the browser default ring, and the hover affordance is invisible on touch (the whole audience is mobile-first). DESIGN.md calls for a Workshop Rust focus ring.
- **Fix:** Add `.app-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`; give touch a clear pressed state.
- **Command:** `/impeccable harden`

**[P3] Hover lift + shadow contradicts the paper-flat doctrine (and never shows on mobile).**
- **Why it matters:** `.app-card:hover { box-shadow: 0 6px 18px rgba(28,27,24,0.06); transform: translateY(-1px) }` reads faintly SaaS-card and breaks DESIGN.md's "no shadows, ever." Alpha is subtle so it's minor, but the mobile-first audience never sees hover at all.
- **Fix:** Drop the `box-shadow`; keep the `border-color` shift (± the 1px lift), or swap for a paper "press."
- **Command:** `/impeccable quieter`

## Persona Red Flags

**Sam (accessibility-dependent) — most damaged.** `.app-desc` 3.6:1 @11.5px, `.footer` 11px, `.section-label`/`.masthead .eyebrow` 10px, `.app-badge` **8.5px** — all `#8A867C`, all fail AA and several are simply too small. No `:focus-visible` styling anywhere. (Done right: icons are correctly `aria-hidden`, links get accessible names from visible text, `lang` and viewport present.)

**Casey (distracted mobile).** 16 visually identical rows in one 500px column is a scroll wall — icons are the only differentiator and the "Game" badge slot is wasted. Hover feedback is invisible on touch; only `:active` responds. 11.5px muted copy is the hardest thing to read one-handed outdoors. (Tap targets ≈64px tall — fine.)

**Jordan (first-timer).** No legend for the badge colour code. Heavy inside-baseball copy ("Naddy," "NOVA book," "SGPools," "goes upstairs to VAR," "the Outsider Method") — but the stated audience *is* friends/partner, so this is charming, not broken. Low priority / context-appropriate.

## Minor Observations

- No `@media (prefers-reduced-motion)` guard on the transitions/transforms (L62/64/65). Cheap to add.
- `font-weight: 650` on `.app-name` isn't a loaded weight (import loads 400;500;600;700;800) — browsers synthesize inconsistently. Pick 600 or 700.
- `<title>hammyLabs - New!</title>` reads like leftover placeholder and mismatches the h1. Give it something durable.
- h1 "A small house of vibe-code." (no *-d*) vs the tagline/meta "vibe-coded" — the clipped form reads faintly like a typo.
- The two adjacent Powerbomb entries use near-identical wrestling icons; differentiate so the eye doesn't stutter.
- `@media (max-width:380px)` only adjusts body padding + h1; the small badge/desc sizes never scale for the smallest phones.
- The Lab card's dashed border is a genuinely nice "not-yet-live" signal — keep it.

## Questions to Consider

1. If every game already sits under a "Games" header, what is the gold "Game" badge *doing* — and could that reclaimed gold become the single burnt-orange stamp the brand promises but never actually spends?
2. The `<title>` says "New!" yet nothing is marked new. Should the shelf foreground *what changed since your friend last visited* — newest-first, or one featured tile — instead of 16 flat equals?
3. This is a love-note to a named audience. Should the descriptions drop the muted grey that makes them read like faded catalogue copy, so the shelf feels *hand-written* rather than *indexed*?
