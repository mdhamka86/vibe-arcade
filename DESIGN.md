---
name: hammyLabs / vibe-arcade
description: A small house of vibe-code — warm paper, ink, and one rust stamp.
colors:
  workshop-rust: "#A85A1E"
  workbench-green: "#3F6B3A"
  filament-violet: "#5B4B8A"
  warm-paper: "#F6F5F1"
  fresh-sheet: "#FFFFFF"
  bench-ink: "#1C1B18"
  soft-graphite: "#57544D"
  pencil-gray: "#8A867C"
  deckle-edge: "#E7E4DC"
  faint-rule: "#EFEDE7"
typography:
  display:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "27px"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.035em"
    fontFeature: "'cv02','cv03','cv04','cv11'"
  display-sm:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "24px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "16.5px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "14.5px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  caption:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.14em"
  micro:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "8.5px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.05em"
rounded:
  sm: "8px"
  md: "12px"
  pill: "20px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "18px"
  lg: "28px"
components:
  app-card:
    backgroundColor: "{colors.fresh-sheet}"
    textColor: "{colors.bench-ink}"
    rounded: "{rounded.md}"
    padding: "13px 14px"
  mark:
    backgroundColor: "{colors.workshop-rust}"
    textColor: "{colors.warm-paper}"
    rounded: "{rounded.sm}"
    size: "30px"
  badge-game:
    textColor: "{colors.workshop-rust}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
  badge-tool:
    textColor: "{colors.workbench-green}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
  badge-ai:
    textColor: "{colors.filament-violet}"
    rounded: "{rounded.pill}"
    padding: "2px 7px"
  app-icon:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.bench-ink}"
    rounded: "{rounded.sm}"
    size: "38px"
---

# Design System: hammyLabs / vibe-arcade

## 1. Overview

**Creative North Star: "The Cozy Workshop"**

hammyLabs looks like a maker's bench, not a company. The ground is warm paper, the
text is ink pressed into it, and a single burnt-orange — Workshop Rust — appears like
a stamp on the things worth noticing. Everything is set out on a shelf you'd be proud
to show a friend: an index of games and tools built by one person, by hand, at odd
hours. The whole system exists to make that shelf feel considered *and* to get you into
an app in a single tap. Craft and speed are the same goal here, not a trade.

The mood is quiet, warm, and human. This is a personal front door with fingerprints on
it — witty copy, a love note in the footer, a masthead that reads like a small press
rather than a product logo. The design carries the personality; it never sits on top of
it as decoration. When any choice could drift cold, techy, or mass-produced, the system
pulls it back toward paper, ink, and the hand that made it.

It explicitly rejects three things. It is **not a dark techy dashboard** — no neon on
black, no terminal cliché, no clinical tool-shell. It is **not a generic SaaS landing** —
no gradient hero, no identical feature-card grid, no "sign up free" polish. It is **not a
cluttered app store** — no dense wall of samey tiles, ratings, and badges shouting for
attention. Warmth and the human hand are the entire point; anything impersonal has failed.

**Key Characteristics:**
- Warm paper ground (#F6F5F1), ink-on-paper text, one rust accent used sparingly.
- Flat by conviction — depth is drawn with borders, never lit with shadows.
- A single family (Inter) worked hard across weights, not a font pairing.
- Tiles are a considered index, not a catalogue — room to breathe over density.
- Voice-forward: the copy and the details are the brand.

## 2. Colors

A warm-neutral paper system carrying ink text and exactly one saturated accent, with two
narrow role-colors reserved for classifying what a tile *is*.

### Primary
- **Workshop Rust** (#A85A1E): The house stamp. A deep, hand-fired burnt-orange used only
  on "Game" badges, the primary accent token, and small moments that earn emphasis. Its
  scarcity is the point — it is a maker's mark, not a fill.

### Secondary
- **Workbench Green** (#3F6B3A): A muted forest green reserved for "Tool" badges. It reads
  as *utility* — the colour of ledger ink and workbench felt, never decorative.

### Tertiary
- **Filament Violet** (#5B4B8A): A soft, electric-leaning violet reserved for "AI-Powered"
  badges. It marks the apps with a live current running through them.

### Neutral
- **Warm Paper** (#F6F5F1): The body ground. Warm without being cream — the sheet
  everything is printed on.
- **Fresh Sheet** (#FFFFFF): Raised surface for tiles and icons. The one lighter step that
  lifts a card off the page without a shadow.
- **Bench Ink** (#1C1B18): Primary text and the masthead mark. Near-black with a warm bias,
  never pure #000.
- **Soft Graphite** (#57544D): Secondary reading text — taglines, the lab note. 6.9:1 on
  paper; the darkest of the "quiet" inks and the floor for anything read as a sentence.
- **Pencil Gray** (#8A867C): Metadata and labels only — section kickers, tile descriptions,
  the footer. At ~3.3:1 on paper it is a *label* colour, not a body colour.
- **Deckle Edge** (#E7E4DC): The 1px border that draws every tile and icon. The system's
  primary depth tool.
- **Faint Rule** (#EFEDE7): The softest divider, for icon strokes and hairline separators.

### Named Rules
**The One Stamp Rule.** Workshop Rust is a stamp, and the `hL` colophon mark is its home —
one small filled square, the maker's mark, and effectively the only place the primary accent
appears at rest. It never becomes a gradient, never washes across a section, and never
multiplies into decoration. The two role-colours (Green / Violet) speak *only* through
badges — the moment any colour becomes ornament, the system has broken.

**The Warm Contrast Rule.** Pencil Gray (#8A867C, 3.3:1) is for labels and metadata. Any
text meant to be *read as a sentence* uses Soft Graphite (#57544D) or darker. Light gray
"for elegance" is forbidden; warmth comes from the paper, not from washing out the ink.

## 3. Typography

**Display / Body / Label Font:** Inter (with system-ui, -apple-system, sans-serif fallback)

**Character:** One family, worked hard. hammyLabs deliberately runs a single humanist sans
across its whole weight range (400–800) rather than pairing families — the contrast comes
from weight and size, not from a second typeface. OpenType features `cv02 cv03 cv04 cv11`
are on everywhere, giving Inter its single-storey, slightly friendlier lowercase — a small
warmth that suits the workshop. This is a committed identity choice; treat Inter as fixed,
not as a default to reconsider.

### Hierarchy
A committed 7-step ramp; every literal on the page maps to one of these steps.
- **Display** (800, 27px → 24px on ≤380px, line-height 1.08, tracking −0.035em): The page
  headline only ("A small house of vibe-code."). Tight, confident, two lines, `text-wrap: balance`.
- **Headline** (650, 16.5px, tracking −0.01em): The featured tile's name — the one promoted,
  scaled-up landmark. Only the featured tile uses it.
- **Title** (650, 14.5px, tracking −0.01em): Regular tile names and the masthead name. The
  scannable layer — what your eye lands on when choosing an app.
- **Body** (400, 13.5px, line-height 1.55): The tagline, set in Soft Graphite. Keep measures
  short (≤ 42ch, as the tagline already is).
- **Caption** (400, 12px, line-height 1.4): Tile descriptions, the footer, and the lab note.
  Set in Soft Graphite (#57544D) — reading text, so it clears AA (**The Warm Contrast Rule**).
- **Label** (700, 10px, tracking 0.14em, UPPERCASE): Section kickers ("Games", "Tools & Apps"),
  set in Soft Graphite for presence, plus the masthead eyebrow.
- **Micro** (700, 8.5px, tracking 0.05em, UPPERCASE): Badges only — the tightest cut. A tag, not
  a reading size.

### Named Rules
**The Single Voice Rule.** One family, always. Never introduce a second typeface for
"contrast" — hierarchy is carried by weight (400 → 650 → 800) and size. A serif display or a
mono label would read as costume on this bench.

## 4. Elevation

This system is **flat at rest**. At rest, surfaces cast no shadow — depth is *drawn, not lit*:
a tile sits above the page through exactly two devices, the step from Warm Paper (#F6F5F1) up
to a Fresh Sheet (#FFFFFF) fill, and a 1px Deckle Edge (#E7E4DC) border around it. No resting
shadow, no blur, no glass.

State adds one — and only one — lit gesture: on hover a tile darkens its border toward #D4CFC4,
lifts a single pixel (`translateY(-1px)`), and casts a **whisper-soft** shadow
(`0 6px 18px rgba(28,27,24,0.06)`), then settles on press. That hover shadow is a deliberate
exception, not a licence for elevation elsewhere. (`prefers-reduced-motion` drops the lift.)

### Named Rules
**The Paper-Flat Rule.** Surfaces are flat at rest — the border and the paper-to-white step are
the only resting elevation. The sole shadow in the system is the whisper-soft hover lift on a
tile (alpha 0.06); nothing casts a resting shadow, and nothing uses blur or glass. If a
component needs a shadow to read at rest, the layout — not the lighting — is wrong.

## 5. Components

Components should feel **warm and tactile** — inviting, a little soft-edged, made by hand.
You should want to tap them.

### Buttons / Tiles (the signature component)
The app tile *is* the primary control here; there are no traditional buttons on the front
door.
- **Shape:** Gently rounded (12px / `{rounded.md}`).
- **Surface:** Fresh Sheet (#FFFFFF) on the paper ground, drawn with a 1px Deckle Edge border.
- **Layout:** A horizontal row — icon, then name + two-line description, then a chevron.
  Row-shaped, not a boxy grid cell; the list reads like an index, not a catalogue.
- **Hover / Focus:** Border darkens to #D4CFC4 and the row lifts 1px (a whisper-soft hover
  shadow is permitted — see Elevation). `:focus-visible` draws a 2px Workshop Rust ring
  (`outline-offset: 2px`); `:active` gives touch a visible press (border darken + paper tint),
  since hover never fires on a phone.

### Featured tile
- **What:** One tile — the newest / flagship app — promoted out of the grid and placed
  directly under the tagline, so the page has a single clear landmark (and delivers on the
  "New" in the title). There is only ever **one**.
- **Style:** The same tile, scaled up: 18px padding, a 48px icon (12px radius), a 16.5px name,
  and a three-line description. Distinction comes from **size and position**, not a second
  accent colour — the rust stamp stays on the mark alone.
- **Marker:** Carries the **New chip** (below). Never gains a coloured surface or border stripe.

### Badges
- **Style:** Pill (20px radius), 1px border in the badge's own colour, transparent fill, the
  text in that same colour. Tiny, uppercase, tracked (8.5px, 0.05em).
- **Roles:** Tool → Workbench Green · AI-Powered → Filament Violet. (The former plain "Game"
  badge was removed as redundant with the section header — a badge now appears only where it
  distinguishes an app from its neighbours, e.g. the one AI-powered game.) The
  border-and-text-in-one-hue treatment keeps them quiet; they classify, they don't shout.
- **The New chip:** A solid **Bench Ink** fill with paper text (not an outline pill) so it reads
  as a *status stamp*, distinct in kind from the outline role tags. Reserved for the featured
  tile. Deliberately **not** rust — the accent lives only on the mark (The One Stamp Rule).

### App Icons
- **Style:** 38px square, Warm Paper fill, Faint Rule (#EFEDE7) border, 8px radius. Line-art
  SVG glyphs, 1.6px stroke, `currentColor` in Bench Ink. Hand-drawn feel, never filled shapes.

### The Mark
- **Style:** A 30px Workshop Rust square, 8px radius, paper-coloured "hL" set in 800 weight
  (paper-on-rust ≈ 4.6:1). The system's single accent lives here — a maker's stamp / small-press
  colophon, not a logo lockup.

### Section Labels
- **Style:** A 10px uppercase tracked kicker ("Games") followed by a hairline rule that
  runs to the edge (`::after` 1px Deckle Edge). This is the *one* deliberate, named use of a
  tracked label in the system — it earns its place as a divider between shelves. Do not
  multiply it into an eyebrow above every element.

### The Lab Note
- **Style:** A dashed-border (#E7E4DC) callout, transparent fill, for "coming next" notes.
  The dashed edge signals *provisional* — a pinned-up sketch, not a shipped tile.

## 6. Do's and Don'ts

### Do:
- **Do** keep Warm Paper (#F6F5F1) as the ground and press ink into it. Warmth lives in the
  paper and the copy, never in washed-out gray text.
- **Do** treat Workshop Rust as a stamp — badges and rare emphasis only, never a fill or
  gradient.
- **Do** draw depth with the 1px Deckle Edge border and the paper-to-white step. Flat is the
  house style (**The Paper-Flat Rule**).
- **Do** carry hierarchy with Inter's weights (400 → 650 → 800). One family, always.
- **Do** keep body text at Soft Graphite (#57544D) or darker; reserve Pencil Gray for labels
  (**The Warm Contrast Rule**).
- **Do** let the tiles breathe — an index with room, not a packed grid.
- **Do** add a visible Workshop Rust focus-visible ring to every tappable tile.

### Don't:
- **Don't** build a dark techy dashboard — no neon-on-black, no terminal cliché, no clinical
  tool-shell.
- **Don't** build a generic SaaS/startup landing — no gradient hero, no identical feature-card
  grid, no "sign up free" polish.
- **Don't** build a cluttered app-store wall — no dense samey tiles, ratings, or badge pile-ups.
- **Don't** add resting shadows or reach for glassmorphism to fake depth — the only shadow in
  the system is the whisper-soft hover lift on a tile (alpha 0.06).
- **Don't** use `background-clip: text` gradient headings — emphasis is weight and size, in a
  single solid ink.
- **Don't** introduce a second typeface, or use mono as shorthand for "technical". Inter is the
  voice.
- **Don't** turn the section-label kicker into an eyebrow above every element — it is a shelf
  divider, used once per section, and nowhere else.
- **Don't** let role-colours (Rust / Green / Violet) escape their badges into decoration.
