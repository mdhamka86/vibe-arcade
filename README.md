[Uploading RELEASE-v1.0.md…]()
# Outsider Triage — v1.0

**Released 22 June 2026 · hammyLabs · live at vibe-arcade-omega.vercel.app/triage2.html**

The first stable release of the meet-triage tool for The Outsider Method. Replaces
the old manual workflow (clicking into each SingaporePools meet and screenshotting
Race 1 by hand) with a one-tap mobile webapp. Estimated ~60% cut in daily racing admin.

---

## What it does

**Stage 1 — Rank meets (one tap)**
Scrapes the SingaporePools race-cards page server-side (no CORS), pulls every meet
for the chosen date, scans each full card, and ranks meets 0–100 by *diveability*.

Score weighting:
- Analysis-doc availability — 40 (the real signal: are tipster/analysis PDFs present)
- Class spread — 25 (graded/handicap vs all-maiden; maiden-heavy cards penalised)
- Field depth — 20
- Race count — 15

Core principle, learned the hard way: **prize money and raw field size are hygiene,
not edge.** The thing that predicts a model edge is whether external analysis exists
and whether the card has genuine class, not how big the prize is.

**Stage 2 — Deep read (per meet)**
On the meets that survive the ranking, fetches and extracts the text of that meet's
analysis PDFs (Integrated Form card, iRace Media Selections, Race Analysis) using a
serverless PDF parser. Hands the tipster selections back for the convergence read.

**Password gate**
Client-side SHA-256 password gate keeps casual visitors out. Stores only the hash,
never the plain password. (Not bulletproof — sized for a personal tool.)

---

## Architecture

- `public/triage2.html` — mobile page: password gate, ranked list, deep-read buttons
- `api/triage2.js` — Stage 1 serverless function (scan + rank), build marker "v1.0"
- `api/deep2.js` — Stage 2 serverless function (PDF text extraction via unpdf)
- `package.json` / `.nvmrc` — declares unpdf, pins Node 22
- `vercel.json` — function durations + memory

Where it fits the bigger picture: the tool is the **front of the workflow**. It ranks
and gathers, then the convergence judgement and the full Outsider Method bet-slip build
still happen in chat (with an independent-pundit web search, since the SP docs alone
aren't fully independent). Documented in the journal Model Notes.

---

## The road to v1.0 (build notes)

Getting here meant clearing a stack of real-world scraping gotchas, each a genuine layer:
1. CORS wall — solved by moving fetches server-side into Vercel functions.
2. Alternate card formats (DISTANCE:1300 vs -1300M-, spaced/odd currencies).
3. JS-rendered vs raw HTML link formats — PDFs are markdown links, not always `<a>` tags.
4. Label-bleed misclassifying PDFs — fixed by classifying on filename (_FORM_/_TIPSHEET_/_RFA_).
5. Function timeout — a catastrophic-backtracking regex on ~900KB pages; replaced with a
   fast indexOf scan (412ms → 86ms).
6. A stuck Vercel build cache serving an old function — sidestepped with fresh endpoint
   paths (triage2 / deep2).
7. Password gate added for v1.0.

---

## Ideas for later (post-v1.0)
- Protect the API endpoints with a key (stronger than page-gate alone)
- Optional: independent-source hooks beyond SP docs
- Point the arcade "Outsider Triage" tile at triage2.html
