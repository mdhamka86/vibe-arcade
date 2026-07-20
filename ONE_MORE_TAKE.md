# ONE_MORE_TAKE.md

Design specification for **ONE MORE TAKE!**, a light, funny, mobile-first web game about running a chaotic movie studio. The game takes the emotional core of *The Movies* and *Stunts & Effects*—discovering stars, casting films, surviving productions, directing stunts and watching the finished result—and compresses it into a fast browser tycoon built on the proven **Whisker Warriors** structure.

**Status:** v0.2 IMAGE-DRIVEN VERTICAL SLICE DEPLOYED (20/07/2026). Playable build is live at `public/one-more-take.html` and was pushed to `main` in commit `e782611`. The current loop includes studio creation, office dashboard, three-script slate, stock-photo talent casting, budget posture, four-scene production, post-production, marketing, generated premiere, results, archive, sound and versioned local saves. The visual layer now uses compressed remote photography with multi-source fallback chains and keeps inline SVG mainly for essential UI icons and emergency fallback art. Phase 1 is complete and the first Phase 3 loop is operational; engine extraction, deterministic tests, balancing and a full image-manifest audit remain before the vertical slice is considered passed. Immediate patch still required: correct `.action-card .action-art img` and `.ribbon strong` selectors in the deployed CSS. The core fantasy, architecture, scope, object contracts, build order and gates in this document remain binding. Scope expansion comes after the loop is fun, not before.

**Owner:** Hammy (hammyLabs)  
**Repo:** `mdhamka86/vibe-arcade`  
**Primary build:** `public/one-more-take.html`  
**Working title:** **ONE MORE TAKE!**  
**Tagline:** *Make movies. Manage egos. Pray for a hit.*

### Current implementation snapshot — v0.2

- Deployment path: `public/one-more-take.html`
- Repository: `mdhamka86/vibe-arcade`
- Latest pushed build commit: `e782611`
- Live route: `/one-more-take.html`
- Current content: 3 scripts, 6 actors, 2 directors and 12 authored scene crises
- Talent cards use remote stock-photo portraits
- Script cards, office hero, production scenes and office action cards are image-driven
- Remote image order: curated compressed stock URL, secondary remote fallback, neutral placeholder fallback
- Current development hosts include Unsplash CDN, Picsum and Placehold.co
- Inline SVG is restricted to essential controls, lightweight effects and last-resort fallback art
- Core simulation and saves remain usable when a remote image fails
- Known CSS patch: `.action-card.action-art img` must become `.action-card .action-art img`
- Known CSS patch: `.ribbonstrong` must become `.ribbon strong`

The generic Picsum and Placehold.co entries are resilience tools for the prototype, not final art provenance. Before public release, every visible production asset must be replaced or confirmed through a traceable manifest containing the exact source page, creator, licence and permitted use.

---

## 1. Why this exists

The goal is to build a lightweight spiritual successor to *The Movies* that works in a browser, feels good on a phone, and produces the same kind of personal stories:

- the unknown actor who becomes the face of the studio;
- the prestige drama ruined by an exploding horse;
- the cheap monster movie that becomes a cult classic;
- the beloved franchise driven into the ground by six unnecessary sequels;
- the impossible stunt that saves an otherwise terrible film;
- the difficult star Hammy keeps hiring despite overwhelming evidence that he should not.

The full simulation of a physical studio lot is deliberately not the centre of the game. Free-placement construction, hundreds of walking employees and real-time production scheduling would consume the project without guaranteeing fun.

The player fantasy is simpler:

> **Choose what to make, choose who makes it, survive the shoot, and watch what comes out.**

The game must be deep enough for meaningful decisions but light enough that one complete film can be produced in roughly five minutes.

The design borrows the data-driven, single-page structure of **Whisker Warriors**:

- reusable character cards;
- screen-based navigation;
- data objects as the source of truth;
- responsive mobile-first layout;
- short animated sequences;
- local browser saving;
- a strong visual identity without a heavy game engine.

The result should feel like a real hammyLabs game rather than a spreadsheet wearing movie-themed clothes.

---

## 2. Non-negotiables

These rules override feature enthusiasm and convenience.

### The finished movie is the payoff

A film cannot end with only a score table.

Every completed production must generate a short animated premiere sequence: scene panels, actor portraits, captions, camera movement, music stings, sound effects and a trailer-style summary of what the player made.

The player must be able to say:

> “Look at this absolute nonsense my studio released.”

### Failure must be funny before it is punishing

Bad decisions and bad luck may cause flops, injuries, feuds and bankruptcy pressure, but the game should turn those failures into memorable stories.

A disastrous scene should create a hilarious recap, not merely subtract twelve points.

### Stars are people, not stat sticks

Talent has:

- visible skills;
- personality traits;
- career history;
- relationships;
- preferences;
- morale;
- fame;
- demands;
- scars from previous productions.

The player should remember names and careers, not just numbers.

### Randomness is influenced, not arbitrary

Incidents come from understandable causes:

- a reckless actor creates stunt risks;
- rival actors create arguments;
- an exhausted crew creates technical failures;
- a low-budget monster costume creates comedy;
- strong chemistry creates improvised magic.

The game may surprise the player, but it must not feel like a slot machine.

### The studio lot is a dashboard, not a construction simulator

The lot is represented as an illustrated studio map with unlockable departments and set cards.

Version one has no free building placement, pathfinding or simulated workers wandering around.

### Every number must earn its place

The game should not expose twenty financial ledgers or six nearly identical quality ratings.

The core visible resources are:

- Cash
- Studio Reputation
- Audience Trust
- Prestige
- Production Capacity

Each must create a distinct decision.

### Mobile first

Every major action must work comfortably on a phone:

- no hover dependency;
- large tap targets;
- short text blocks;
- horizontally scrollable cards where appropriate;
- no dense desktop-only tables;
- no precision dragging.

### Saves must be safe and inspectable

The game auto-saves to `localStorage` after every meaningful phase.

The save object is versioned, validated before loading and exportable as JSON. A malformed save must fail safely rather than destroying progress.

### No backend for version one

No accounts, database, cloud saves, live AI calls or server-side game logic are required for the core game.

The visual layer may fetch compressed royalty-free stock images while online. Core gameplay, saves and simulation must remain functional if an image host is unavailable. Each image slot walks an ordered source chain and ends in a lightweight non-blocking fallback; a failed host must never create an empty card, broken control or corrupted premiere.

### Content depth comes after loop quality

Twenty excellent events are better than two hundred repetitive ones.

The vertical slice must prove that selecting a script, casting, shooting, resolving incidents and watching a premiere is fun before the content library expands.

---

## 3. Core campaign structure

The player begins with:

- a tiny studio;
- `$250,000`;
- three unknown actors;
- one inexperienced director;
- one basic soundstage;
- access to Comedy, Horror and Crime scripts;
- one production slot per quarter.

A game year contains four quarters.

Each quarter, the player may produce one film, rest the studio, train talent or take a contract job for emergency cash.

At the end of the fourth quarter:

- annual financial results are calculated;
- careers age by one year;
- audience trends update;
- contracts may expire;
- awards season occurs;
- the next studio tier may unlock.

The campaign has no hard ending in version one. The long-term goal is to build a famous studio, fill the movie archive and create enduring stars and franchises.

A soft milestone ladder provides direction:

| Studio Tier | Identity | Unlock |
|---|---|---|
| 1 | Garage Pictures | Small scripts, one soundstage, unknown talent |
| 2 | Indie Contender | Drama and Romance, better crew, festivals |
| 3 | Rising Studio | Action, stunts, two productions per year bonus |
| 4 | Major Player | Sci-Fi, advanced effects, international release |
| 5 | Dream Factory | Tentpoles, prestige campaigns, legacy contracts |

The tier is based on a combination of cash stability, reputation, completed films and audience trust. One lucky blockbuster should help, but not instantly skip the whole game.

---

## 4. The core film loop

One complete movie follows seven phases.

### Phase 1 — Development

The player receives three screenplay pitches.

Each pitch includes:

- title;
- genre;
- premise;
- tone;
- target audience;
- base budget;
- required scene types;
- difficulty;
- commercial potential;
- prestige potential;
- hidden twist or production complication.

Example:

**GRANNY WITH A GUN**  
Action Comedy

*An elderly florist discovers that her begonias are being used to smuggle diamonds.*

Required scenes:

- quiet character introduction;
- chase;
- confrontation;
- major stunt.

The player may:

- greenlight one script;
- reject all three and pay for a fresh slate;
- purchase a rewrite;
- attach a studio-owned franchise;
- postpone the quarter.

### Phase 2 — Casting and crew

The player chooses:

- Director
- Lead
- Co-lead or supporting actor
- Optional third actor
- Cinematographer
- Optional stunt coordinator
- Optional effects supervisor

Every candidate card shows only the information needed for that job.

The player balances:

- skill fit;
- salary;
- fame;
- chemistry;
- availability;
- morale;
- genre preference;
- traits;
- existing feuds;
- career goals.

Casting an excellent actor in the wrong genre can still work, but should create risk and story.

### Phase 3 — Budget and production plan

The player allocates the project budget across six departments:

- Cast
- Sets
- Costumes
- Stunts
- Effects
- Post-production

Marketing is chosen after the shoot so the player can decide whether the finished film deserves support or should be quietly buried.

The budget interface uses simple tiers rather than exact accounting for every item:

- Shoestring
- Lean
- Standard
- Premium
- Reckless

Each tier shows the cash cost and the likely effect.

The player also chooses one production posture:

| Posture | Benefit | Risk |
|---|---|---|
| Safe Hands | Fewer disasters | Lower chance of exceptional scenes |
| Balanced | No modifier | No modifier |
| Let Them Cook | More improvisation | More volatility |
| Chasing Greatness | Prestige and performance ceiling | Overtime, ego and delay risk |
| Full Send | Stunts/effects ceiling | Injury and budget-overrun risk |

### Phase 4 — Production

A movie contains three to six scenes, depending on scale.

Each scene has:

- a scene type;
- two or more participating cast members;
- a primary department;
- one key skill check;
- a production event or decision;
- an outcome;
- a saved visual summary for the premiere.

Example:

> **Rex Valentine refuses to jump from the burning carriage.**

Choices:

**Use the stunt double**  
Safe. Costs `$12,000`. Slightly lowers Rex's scene contribution.

**Let Rex attempt it**  
High ceiling. Injury and delay risk.

**Rewrite the scene**  
Replace the carriage explosion with an argument beside a parked bicycle.

The game calculates the outcome after the choice and immediately shows a brief animation, quote or consequence.

The player is never asked to click through meaningless routine days. Every production interaction must contain a real choice, character beat or visible consequence.

### Phase 5 — Post-production

The player has a limited number of edit points based on crew quality and budget.

Possible actions:

- tighten the edit;
- extend the emotional ending;
- remove the weakest scene;
- hide a bad performance with reaction shots;
- add a dramatic score;
- add cheap comedy sound effects;
- upgrade a practical effect;
- insert an obvious digital explosion;
- dub an unusable line reading;
- create a confusing director's cut;
- reshoot one scene if time and cash allow.

Post-production cannot transform a disaster into a masterpiece, but it can rescue weaknesses or sharpen strengths.

### Phase 6 — Marketing and release

The player chooses:

- marketing spend;
- release window;
- campaign angle;
- whether to chase festivals or mass audiences.

Campaign angles include:

- Sell the Star
- Sell the Spectacle
- Sell the Romance
- Sell the Scandal
- Prestige Campaign
- Mystery Teaser
- “Based on a True Story” Despite Objections

The player can oversell a weak film, but this damages Audience Trust when people feel misled.

### Phase 7 — Premiere and aftermath

The game plays a short generated trailer or movie recap using the scenes saved during production.

The results then reveal:

- critic score;
- audience score;
- opening weekend;
- total box office;
- profit or loss;
- studio reputation change;
- audience trust change;
- talent fame and morale changes;
- injuries, feuds or romances;
- award eligibility;
- sequel potential;
- review excerpts;
- cult status or infamy.

The movie is permanently added to the archive.

---

## 5. The MovieProject object — the contract

The entire film is carried through one object.

This is the single source of truth for development, production, premiere, archive and save data.

```js
{
  projectId: "film-2026-q2-0042",
  seed: 918274,
  status: "DEVELOPMENT" | "CASTING" | "PLANNING" |
          "SHOOTING" | "POST" | "RELEASED" | "CANCELLED",

  title: "Granny With a Gun",
  franchiseId: null,
  sequelNumber: 0,

  scriptId: "script-action-comedy-07",
  genre: "ACTION",
  subgenre: "COMEDY",
  tone: "CHAOTIC",
  premise: "An elderly florist uncovers a diamond-smuggling ring.",

  targetAudience: ["ADULT", "MAINSTREAM"],
  requiredScenes: ["INTRO", "CHASE", "CONFRONTATION", "STUNT"],

  cast: {
    leadId: "talent-rex-valentine",
    supportIds: ["talent-mavis-stone"],
    cameoIds: []
  },

  crew: {
    directorId: "talent-milo-finch",
    cinematographerId: "crew-lena-park",
    stuntCoordinatorId: "crew-jo-dynamite",
    effectsSupervisorId: null
  },

  budget: {
    approved: 180000,
    cast: 50000,
    sets: 25000,
    costumes: 10000,
    stunts: 35000,
    effects: 15000,
    post: 25000,
    marketing: 20000,
    overrun: 0
  },

  posture: "FULL_SEND",

  scenes: [],
  incidents: [],
  relationshipsChanged: [],
  injuries: [],
  delays: 0,

  rawScores: {
    performance: 0,
    direction: 0,
    craft: 0,
    spectacle: 0,
    coherence: 0,
    originality: 0
  },

  release: {
    window: null,
    campaign: null,
    criticScore: null,
    audienceScore: null,
    openingWeekend: null,
    totalGross: null,
    profit: null,
    awards: [],
    tags: []
  },

  trailerBeats: [],
  createdAtTurn: 6,
  completedAtTurn: null
}
```

### Contract rules

- A project receives its `seed` when greenlit. All random production outcomes derive from this seed.
- A scene is appended, never silently overwritten.
- Every incident records its cause, choice and consequence.
- Money is recorded inside the project and mirrored in studio cash through one transaction function only.
- Released films become immutable archive records, except for adding later awards or sequel references.
- Cancelled films remain in studio history. Failure is part of the story.
- UI components may display derived values, but they never invent or independently mutate game truth.

---

## 6. Talent object

Actors, directors and senior crew use one shared base shape.

```js
{
  id: "talent-rex-valentine",
  name: "Rex Valentine",
  profession: "ACTOR",
  age: 34,

  portrait: {
    assetId: "portrait-rex-valentine",
    primaryUrl: "https://...compressed-stock-image...",
    fallbackUrls: [
      "https://...secondary-source...",
      "https://...neutral-placeholder..."
    ],
    crop: "50% 20%",
    fallbackArtId: "fallback-portrait"
  },

  skills: {
    acting: 63,
    comedy: 48,
    drama: 72,
    romance: 81,
    action: 14,
    horror: 33,
    improvisation: 66,
    professionalism: 28
  },

  fame: 54,
  morale: 67,
  energy: 72,
  salary: 25000,

  traits: [
    "TABLOID_MAGNET",
    "EXCELLENT_FAKE_CRYER",
    "REFUSES_TO_DIE_ON_SCREEN"
  ],

  preferences: {
    lovedGenres: ["ROMANCE", "DRAMA"],
    hatedGenres: ["HORROR"],
    careerGoal: "WIN_ACTING_AWARD"
  },

  relationships: {
    "talent-milo-finch": -42,
    "talent-mavis-stone": 61
  },

  contract: {
    studioExclusive: false,
    filmsRemaining: 0,
    salaryModifier: 1
  },

  career: {
    films: [],
    wins: 0,
    nominations: 0,
    injuries: 0,
    flops: 0,
    hits: 0,
    signatureRole: null
  }
}
```

### Talent principles

- Skills improve through use, training and mentorship.
- Fame raises salary and marketing power.
- Morale affects performance and incident risk.
- Energy falls during difficult productions and recovers between quarters.
- Traits create decisions, not passive flavour only.
- Relationships range from `-100` to `100`.
- Chemistry is calculated from relationship, trait compatibility, prior work and genre fit.
- Age changes slowly and creates career arcs without making older talent automatically worse.
- Directors and crew use role-specific skill sets but retain traits, morale, energy, fame and relationships.

---

## 7. Script, scene and event data

### Script object

Scripts are authored content shells with procedural title and detail variation.

```js
{
  id: "script-action-comedy-07",
  genre: "ACTION",
  subgenre: "COMEDY",
  titlePatterns: [
    "{RELATIVE} WITH A {WEAPON}",
    "{JOB} ON THE RUN"
  ],
  premise: "An elderly florist uncovers a diamond-smuggling ring.",
  tone: "CHAOTIC",
  targetAudience: ["ADULT", "MAINSTREAM"],
  requiredScenes: ["INTRO", "CHASE", "CONFRONTATION", "STUNT"],
  baseBudget: 140000,
  difficulty: 46,
  commercialPotential: 72,
  prestigePotential: 31,
  tags: ["ODD_COUPLE", "VEHICLE_STUNT", "FISH_OUT_OF_WATER"]
}
```

### Scene object

```js
{
  sceneId: "scene-0042-03",
  type: "STUNT",
  title: "The Burning Carriage",
  participants: ["talent-rex-valentine", "talent-mavis-stone"],
  department: "STUNTS",
  locationId: "set-old-street",

  baseDifficulty: 68,
  selectedChoiceId: "rex-does-own-stunt",

  modifiers: {
    skillFit: -12,
    chemistry: 8,
    morale: 3,
    budget: 14,
    director: 5,
    trend: 0
  },

  roll: 77,
  quality: 81,
  outcome: "EXCEPTIONAL",
  consequences: [
    { type: "INJURY_RISK_RESOLVED", value: "NEAR_MISS" },
    { type: "FAME", targetId: "talent-rex-valentine", amount: 6 }
  ],

  trailerBeat: {
    background: "old-street-fire",
    cast: ["talent-rex-valentine"],
    caption: "HE SHOULD NOT HAVE SURVIVED THIS.",
    effect: "explosion"
  }
}
```

### Production event object

```js
{
  id: "event-refuses-stunt",
  phase: "SHOOTING",
  validSceneTypes: ["STUNT", "CHASE"],
  requirements: {
    anyTraits: ["COWARDLY", "PRECIOUS_FACE", "REFUSES_TO_DIE_ON_SCREEN"]
  },
  weight: 12,

  headline: "{ACTOR} refuses the stunt.",
  body: "The carriage is burning. The cameras are ready. {ACTOR} has reconsidered several life choices.",

  choices: [
    {
      id: "use-double",
      label: "Use the stunt double",
      cost: 12000,
      effects: ["SAFE", "STAR_SCENE_PENALTY_SMALL"]
    },
    {
      id: "actor-does-it",
      label: "Let {ACTOR} attempt it",
      effects: ["HIGH_VARIANCE", "INJURY_RISK", "FAME_UPSIDE"]
    },
    {
      id: "rewrite",
      label: "Rewrite the scene",
      effects: ["STUNT_REMOVED", "COHERENCE_RISK", "COST_LOW"]
    }
  ]
}
```

Events are authored templates. Names, pronouns, previous films, traits and relationships are inserted at runtime.

---

## 8. Simulation and scoring

The simulation must be understandable, tunable and testable.

The player does not need to see the exact formula, but outcomes should match the visible situation.

### Scene quality

Each scene starts from a base score of `50`.

Modifiers are added from:

- relevant actor skill;
- director skill;
- crew skill;
- cast chemistry;
- morale and energy;
- department budget;
- set suitability;
- script difficulty;
- production posture;
- event choice;
- traits;
- a seeded random roll.

Conceptually:

```text
sceneQuality =
  50
  + talentFit
  + directorContribution
  + crewContribution
  + chemistry
  + moraleEnergy
  + budgetSupport
  + choiceEffects
  + traitEffects
  + seededVariance
  - difficulty
  - activeProblems
```

Final scene quality is clamped to `0–100`.

Outcome bands:

| Quality | Outcome |
|---|---|
| 0–19 | Catastrophic |
| 20–39 | Poor |
| 40–59 | Usable |
| 60–74 | Strong |
| 75–89 | Exceptional |
| 90–100 | Iconic |

### Film craft scores

After shooting, scenes contribute to six internal scores:

- Performance
- Direction
- Craft
- Spectacle
- Coherence
- Originality

Genre weights differ.

Example:

- Action values Spectacle and Craft.
- Drama values Performance, Direction and Coherence.
- Comedy values Performance, Timing and Originality.
- Horror values Craft, Atmosphere and Originality.
- Romance values Performance, Chemistry and Coherence.
- Sci-Fi values Craft, Spectacle and Originality.

### Critic score

Critics favour:

- performance;
- direction;
- coherence;
- originality;
- prestige-friendly genre fit;
- restrained marketing claims;
- festival success.

Critics punish:

- incoherent rewrites;
- obvious franchise fatigue;
- cheap trend chasing;
- technical collapse;
- manipulative prestige campaigns on weak films.

### Audience score

Audiences favour:

- entertainment;
- stars they like;
- genre satisfaction;
- chemistry;
- memorable scenes;
- spectacle;
- honest marketing;
- franchise affection.

Audiences punish:

- misleading campaigns;
- broken genre promises;
- excessive runtime;
- exhausted franchises;
- unlikeable stars during scandals.

### Box office

Box office is driven by:

- audience interest before release;
- cast fame;
- genre trend;
- marketing;
- release window;
- studio reputation;
- critic and audience word of mouth;
- competition;
- sequel recognition;
- random market noise kept within a controlled band.

A strong film with weak marketing can grow slowly through word of mouth.

A poor film with enormous marketing can open strongly and collapse.

### Awards

Awards use category-specific scores and campaign effort.

A nomination is not guaranteed merely because a film has a high total score.

Examples:

- Best Performance checks the actor's scene contribution.
- Best Director checks direction and coherence.
- Best Stunt checks stunt scene quality and risk.
- Best Effects checks effects quality and budget efficiency.
- Best Picture checks the complete film.
- Most Unnecessary Sequel checks franchise fatigue and critical hostility.

### Profit

```text
profit =
  totalGross * studioRevenueShare
  - totalProductionSpend
  - marketingSpend
  - penalties
```

Version one uses one simplified revenue share rather than territory-by-territory distribution.

---

## 9. Character drama and studio memory

The game becomes memorable when systems remember what happened.

### Relationships

Relationships change through:

- successful collaboration;
- arguments;
- romances;
- betrayal;
- being protected from a dangerous stunt;
- being forced into a dangerous stunt;
- awards rivalry;
- repeated casting;
- public blame after a flop;
- loyalty during a crisis.

Relationship thresholds trigger labels:

| Score | Relationship |
|---|---|
| -100 to -61 | Nemeses |
| -60 to -21 | Hostile |
| -20 to 20 | Neutral |
| 21 to 60 | Friends |
| 61 to 100 | Inseparable |

### Signature roles

An actor may become associated with:

- a genre;
- a recurring character;
- a franchise;
- a type of scene;
- a famous co-star.

Signature roles increase marketing value but may create typecasting.

### Scandals

Scandals are light, fictional and comedic in version one:

- disastrous interview;
- feud posted publicly;
- fake accent controversy;
- award speech lasting forty minutes;
- caught insulting the studio mascot;
- suspiciously similar autobiography;
- method acting taken too far.

Scandals create choices:

- defend the star;
- apologise;
- suspend them;
- exploit the attention;
- quietly bury the story.

### Injuries

Injuries have duration and severity.

They may:

- reduce a relevant skill temporarily;
- force recasting;
- create sympathy and fame;
- affect morale;
- unlock a “comeback” story later.

No graphic injury content is required.

### Career history

Every talent page lists:

- films;
- roles;
- scene highlights;
- box office;
- awards;
- injuries;
- major relationships;
- career tags;
- best-known film.

The game should be able to generate a retirement summary worth reading.

---

## 10. Stunts & Effects system

The expansion-inspired layer must be meaningful without becoming a separate simulator.

### Stunt categories

- Fight
- Fall
- Vehicle
- Fire
- Water
- Height
- Creature
- Catastrophic Improvisation

Every stunt has:

- difficulty;
- spectacle ceiling;
- injury risk;
- equipment requirements;
- actor participation choice;
- stunt-double quality;
- possible trailer beat.

### Effects categories

- Practical Creature
- Miniature
- Weather
- Explosion
- Makeup
- Green Screen
- Digital Environment
- Questionable Optical Effect

Effects can be:

- underfunded;
- competent;
- impressive;
- accidentally charming;
- visibly terrible.

Bad effects do not always reduce audience enjoyment. Horror and Comedy films may gain cult appeal from memorable failures.

### Stunt and effects specialists

Specialists have traits and careers like actors.

A veteran stunt coordinator may:

- reduce injury risk;
- unlock more ambitious choices;
- improve actor confidence;
- become famous after iconic sequences.

An effects supervisor may:

- stretch a small budget;
- insist on practical effects;
- create cost overruns;
- rescue a bad scene in post.

---

## 11. Genres, trends and franchises

### Version-one genres

1. Comedy
2. Horror
3. Crime
4. Drama
5. Romance
6. Action
7. Sci-Fi

The player begins with three. Others unlock through studio tiers.

### Trends

Two major trends and one minor trend are active each year.

Examples:

- Monster Boom
- Audiences Want Escapism
- Gritty Crime Fatigue
- Romance Revival
- Practical Effects Nostalgia
- Superhero Exhaustion
- Prestige Biopic Fever
- Musicals Are Somehow Back
- Nobody Wants Three-Hour Movies
- International Stars Rising

Trends alter demand rather than deciding success outright.

A great film can beat a bad trend. A weak film cannot be saved merely because its genre is fashionable.

### Franchises

A released film with sufficient audience interest may become a franchise.

A franchise tracks:

```js
{
  franchiseId: "franchise-grandpa-cop",
  name: "Grandpa Cop",
  films: ["film-001", "film-007"],
  audienceAffection: 78,
  fatigue: 22,
  continuity: 65,
  signatureTalentIds: ["talent-arthur-vane"]
}
```

Sequels receive:

- lower development risk;
- stronger opening interest;
- returning-cast bonuses;
- continuity expectations;
- fatigue risk.

Possible titles:

- *Grandpa Cop*
- *Grandpa Cop II: Back in Retirement*
- *Grandpa Cop III: Pension Impossible*
- *Grandpa Cop IV: The Last Hip Replacement*

Recasting a beloved role creates a major decision and possible backlash.

---

## 12. Premiere generator

The premiere is a deterministic visual recap built from `trailerBeats`.

### Minimum structure

1. Studio logo
2. Title card
3. Three to six scene beats
4. One cast quote
5. One major incident reference
6. Final money shot
7. Release title
8. Review and box-office reveal

### Visual implementation

Version one uses:

- compressed stock-photo scene backdrops;
- stock-photo talent portraits;
- deterministic image crops and colour treatments;
- multi-source remote fallbacks;
- limited inline SVG for essential UI, masks and emergency art only;
- parallax pans;
- zooms;
- wipes;
- title cards;
- impact flashes;
- lightweight silhouette stunts where photography is unavailable;
- particles;
- simple sound effects;
- short generated captions.

No full animation rig or 3D scene editor is required.

Example trailer:

> **HAMMY PICTURES PRESENTS**  
> Rex Valentine enters the haunted bakery.  
> Lightning strikes.  
> Mavis Stone screams at the wrong door.  
> A demon made of bread rises from the oven.  
> **“THIS SUMMER… THE DOUGH WILL RISE.”**  
> *THE MOON IS HUNGRY*  
> Somehow rated 84% by audiences.

### Replay and archive

Every released film stores enough trailer data to replay its premiere later without rerunning the simulation.

---

## 13. Screens and navigation

### 1. Title screen

- Continue Studio
- New Studio
- Movie Archive
- How to Play
- Sound toggle
- “a hammyLabs joint”

### 2. Studio Office

The home dashboard.

Shows:

- current quarter and year;
- cash;
- reputation;
- audience trust;
- prestige;
- current trends;
- available production slot;
- urgent talent issues;
- latest film result.

Primary actions:

- Start a Film
- View Talent
- View Studio
- Movie Archive
- Awards / History

### 3. Script Desk

Three large screenplay cards.

Filter and reroll controls remain secondary.

### 4. Casting Room

Horizontal talent cards with comparison chips.

The selected cast appears in a persistent strip at the top.

### 5. Production Plan

Budget allocation, department cards and posture choice.

The “Begin Production” button includes projected spend and risk level.

### 6. Soundstage

Scene title, cast, visual set panel, event decision and immediate outcome.

A progress strip shows all scenes in the film.

### 7. Editing Room

Limited edit-point choices.

The weakest and strongest scenes are clearly marked.

### 8. Release Office

Marketing spend, campaign and release window.

### 9. Premiere

Full-screen animated sequence followed by results.

### 10. Talent Roster

Actor, director and crew cards.

Tap opens career details and relationships.

### 11. Movie Archive

Poster grid with filters:

- genre;
- year;
- hit/flop;
- franchise;
- awards;
- cult status.

### 12. Studio Map

Illustrated departments with upgrade cards.

No free placement.

---

## 14. Visual and audio direction

### Visual identity

A stylised late-night studio aesthetic:

- deep navy and charcoal backgrounds;
- warm marquee gold;
- muted red curtain accents;
- cream paper for scripts and reviews;
- cyan production-light highlights;
- visible grain and subtle projector texture;
- compressed royalty-free stock photography for locations, sets, atmosphere, script cards, office actions and talent portraits;
- restrained SVG masks, essential interface icons and lightweight fallback art in the same spirit as Whisker Warriors;
- large readable typography.

### Stock-image approach

The main photographic layer uses **royalty-free compressed stock images loaded from stable, permitted remote URLs rather than stored in the repository**. The prototype uses ordered multi-source URL arrays so a blocked or missing image host can fall through to another source without breaking the screen.

Stock images are best used for:

- studio backlots and soundstages;
- city streets, mansions, forests and other filming locations;
- genre atmosphere;
- props, costumes and production departments;
- screenplay cards and scene backdrops;
- selected talent portraits where the licence and subject-release terms clearly permit the intended use.

They are complemented by:

- CSS colour treatments, grain, crops and vignette masks;
- procedural poster typography and layout;
- lightweight lighting, smoke, rain, fire and impact effects;
- a small set of essential line icons;
- minimal SVG or illustrated fallback art only when remote photography cannot load.

Photography is the default visual language. Inline SVG must not become the primary artwork for screenplay cards, talent portraits, office actions, sets or premiere backdrops.

The stock layer must follow these rules:

1. Use only images whose licence permits commercial use and external embedding or hotlinking.
2. Record the source page, creator, licence, direct image URL and intended use in a central asset manifest.
3. Never use search-result thumbnails, scraped images, copyrighted film stills, celebrity likenesses or URLs with unclear rights.
4. Request appropriately compressed dimensions from image CDNs where supported; do not hotlink full-resolution originals into small cards.
5. Apply `loading="lazy"` and `decoding="async"` outside the currently active scene.
6. Use stable HTTPS URLs and avoid temporary, signed or expiring links.
7. Every image asset must define an ordered source array rather than a single fragile URL.
8. The final fallback must render without depending on the same host as the primary image.
9. A failed image may reduce visual richness but must never block gameplay, obscure controls or corrupt a saved premiere.
10. Preserve attribution metadata even when visible attribution is not legally required, so the source can be audited or replaced later.
11. The asset manifest is the single source of truth; raw image URLs should not be scattered throughout UI components.
12. Picsum and Placehold.co may be used as prototype resilience fallbacks, but they are not substitutes for final curated art provenance.
13. Before release, test every host from the deployed Vercel origin on mobile Chrome, desktop Chrome and at least one privacy-restricted browser mode.

Example manifest entry:

```js
{
  id: "stock-set-rainy-alley-01",
  kind: "SCENE_BACKGROUND",
  source: "ROYALTY_FREE_STOCK_PROVIDER",
  creator: "Creator Name",
  licence: "Commercial royalty-free / embedding permitted",
  sourcePage: "https://...",
  urls: [
    "https://...compressed-primary-image...",
    "https://...secondary-fallback-image...",
    "https://...neutral-placeholder..."
  ],
  fallbackArtId: "fallback-rainy-alley",
  crop: "50% 42%",
  treatment: "noir-blue",
  creditRequired: false
}
```

Avoid:

- gradient text;
- glassmorphism;
- generic neon cyberpunk;
- tiny dashboard text;
- overly realistic Hollywood branding;
- copyrighted studio marks;
- direct copies of real actors or films.

### Character cards

Talent cards borrow the strong hierarchy of Whisker Warriors:

- name and profession;
- portrait;
- key stats;
- traits;
- salary;
- morale and fame;
- short flavour line;
- clear selected state.

Cards should feel collectible without becoming a card battler. The portrait area uses stock photography by default; procedural SVG faces are no longer the main art direction.

### Posters

Every released film receives a procedural poster composed from:

- title;
- genre layout;
- selected palette;
- lead portraits or silhouettes;
- one scene prop;
- studio logo;
- tagline.

### Audio

Version one uses short generated Web Audio cues:

- projector start;
- clapperboard;
- cash;
- applause;
- boo;
- award sting;
- explosion;
- romantic swell;
- horror sting;
- typing;
- phone buzz.

Music remains short and abstract to avoid large assets and copyright issues.

Sound is optional and always user-toggleable.

---

## 15. Architecture

### Shipping shape

The primary playable build is:

`public/one-more-take.html`

Like Whisker Warriors, it can load React, ReactDOM, Babel and GSAP from CDNs and contain its interface, styles, data and gameplay logic in one portable file during the prototype stage.

### Recommended development split

To keep simulation testable:

```text
public/
  one-more-take.html
  one-more-take-seed.js          optional when content becomes large

lib/
  one-more-take-engine.mjs       pure simulation functions

tests/
  one-more-take-engine.test.mjs
```

The shipping HTML may inline the stable engine later. Development must not sacrifice testability merely to preserve one physical file.

### Core state

Use one `useReducer` game state rather than dozens of loosely connected state hooks.

```js
{
  saveVersion: 1,
  studio: {},
  talent: {},
  crew: {},
  projects: {},
  franchises: {},
  archive: [],
  currentProjectId: null,
  turn: 1,
  year: 1,
  quarter: 1,
  rngSeed: 12345,
  settings: {},
  history: []
}
```

### Pure engine boundary

The following functions remain pure and testable:

- `generateScriptSlate(state, seed)`
- `calculateChemistry(a, b, context)`
- `calculateSceneOutcome(project, scene, choice, state)`
- `applyConsequence(state, consequence)`
- `calculateFilmScores(project, state)`
- `calculateRelease(project, state)`
- `generateAwards(state, year)`
- `advanceQuarter(state)`
- `validateSave(raw)`
- `migrateSave(raw)`

React renders results and dispatches actions. It does not contain duplicate business rules.

### Seeded randomness

Use a small deterministic pseudo-random generator.

Every project has a seed.

Every random decision derives from:

```text
project seed + phase index + scene index + event index
```

Benefits:

- bugs can be reproduced;
- automated tests can assert outcomes;
- save/load does not change a film's fate;
- a premiere replay remains identical;
- balance comparisons are meaningful.

### Save key

`oneMoreTake_save_v1`

Save after:

- greenlighting;
- casting;
- budget approval;
- every scene;
- post-production;
- release;
- quarter advance;
- awards;
- settings changes.

Keep one backup key:

`oneMoreTake_save_v1_backup`

Before writing a new save, copy the last valid save to the backup key.

### Export/import

The settings screen supports:

- Export Save
- Import Save
- Reset Studio

Import validates shape and save version before replacing anything.

### Performance

- Do not host a large raster library inside the repository.
- Hotlink compressed, correctly sized royalty-free stock variants rather than full-resolution originals.
- Keep an ordered URL chain per asset: verified stock primary, independent secondary fallback, neutral final fallback.
- Preload only the current screen's hero image and the next likely production image.
- Lazy-load archive, roster and inactive-scene images.
- Portrait and background components must reserve their final dimensions before loading so failed or delayed images do not cause layout jumps or overlaps.
- Cache successful remote images through normal browser caching; never require an image to be refetched before simulation can continue.
- Test deployed image loading from the Vercel route itself; local browser success is not sufficient.
- Animations use transform and opacity.
- Honour `prefers-reduced-motion`.
- Keep the active DOM small; archive cards render lazily if necessary.
- Avoid rerendering the complete roster during scene animations.

---

## 16. Version-one content scope

The first complete version targets:

| Content | Target |
|---|---:|
| Genres | 7 |
| Script templates | 30 |
| Procedural title fragments | 120+ |
| Actors | 16 |
| Directors | 6 |
| Crew specialists | 8 |
| Traits | 40 |
| Production events | 60 |
| Scene templates | 35 |
| Sets | 12 |
| Costumes | 15 |
| Stunts | 12 |
| Effects | 12 |
| Trends | 16 |
| Marketing campaigns | 7 |
| Awards | 8 |
| Studio upgrades | 15 |
| Review snippets | 120 |
| Trailer caption templates | 100 |

This is a target, not permission to block launch until every number is reached.

The vertical slice uses a much smaller subset.

---

## 17. Vertical slice definition

The vertical slice proves the complete emotional loop.

### Included

- one studio;
- one year;
- three genres: Comedy, Horror, Action;
- six actors;
- two directors;
- two crew specialists;
- nine scripts;
- six sets;
- fifteen production events;
- four stunt/effect choices;
- three marketing campaigns;
- one awards ceremony;
- local save;
- movie archive;
- generated premiere.

### Pass condition

A tester can:

1. start a new studio;
2. choose a screenplay;
3. cast it;
4. allocate a budget;
5. make at least four production decisions;
6. perform one post-production action;
7. market and release the film;
8. watch a generated premiere;
9. understand why the film received its result;
10. immediately want to make another movie.

That final point is the real gate.

---

## 18. Testing

The simulation is tested before content scale.

### Determinism tests

Given the same:

- save;
- project;
- seed;
- choice;

the engine must produce the same result.

### Save tests

- valid save loads;
- malformed JSON fails safely;
- missing required fields fail validation;
- older version migrates;
- backup restore works;
- save after every production phase restores the exact phase.

### Economy tests

Simulate hundreds of studios and confirm:

- normal play does not guarantee bankruptcy;
- reckless play can fail;
- one hit does not create infinite money;
- one flop is survivable;
- emergency contract work can rescue a struggling studio;
- upper tiers require sustained success.

### Content eligibility tests

- events only appear in valid phases;
- stunt events require a stunt scene;
- relationship events require multiple participants;
- trait-specific events require the trait;
- no event references missing talent;
- no script requests an unavailable scene type.

### Formula tests

- better relevant skill should improve expected outcomes;
- higher budget should help with diminishing returns;
- chemistry should matter without overpowering all other factors;
- dangerous choices should have higher ceiling and downside;
- marketing cannot alter craft quality;
- critics and audiences may disagree;
- franchise fatigue lowers sequel response;
- strong word of mouth can produce legs.

### UI tests

Manual mobile checks at:

- 360×800;
- 390×844;
- 412×915;
- tablet;
- desktop.

Verify:

- no horizontal page overflow;
- cards remain readable;
- primary actions remain visible;
- modal text is scrollable;
- sound toggle persists;
- reduced-motion mode works;
- premiere can be skipped and replayed.

### Chaos tests

Force:

- actor injury;
- cast feud;
- budget overrun;
- missing specialist;
- cancelled film;
- negative cash;
- awards tie;
- empty script slate;
- archive with 100 films.

The game must fail visibly and recoverably, never silently.

---

## 19. Build order and gates

Each phase must pass before the next begins.

### Phase 1 — Static shell and design system — COMPLETE

Built:

- title screen;
- studio office;
- reusable cards;
- modal;
- toast;
- top bar;
- responsive layout;
- theme variables;
- icon system;
- sound toggle;
- screen navigation.

**Passes when:** every screen shell works on phone and desktop with placeholder data.

### Phase 2 — Data contracts and engine tests

Build:

- game state;
- talent object;
- script object;
- MovieProject object;
- seeded RNG;
- reducer actions;
- save validation;
- pure engine test harness.

**Passes when:** deterministic scene and save tests are green.

### Phase 3 — One complete film — OPERATIONAL, NOT YET PASSED

The current build completes the full loop with three fixed scripts:

- cast;
- budget;
- four scenes;
- production events;
- post;
- marketing;
- premiere;
- results;
- archive.

**Passes when:** one film can be completed without developer tools and the outcome is understandable.

### Phase 4 — Vertical slice content

Add:

- nine scripts;
- six actors;
- two directors;
- fifteen events;
- three genres;
- basic relationships;
- one awards ceremony.

**Passes when:** testers voluntarily start multiple studios or make several films in one sitting.

### Phase 5 — Economy and progression

Add:

- quarters;
- years;
- studio tiers;
- upgrades;
- contracts;
- trends;
- emergency jobs;
- bankruptcy recovery.

**Passes when:** a multi-year campaign remains challenging but recoverable.

### Phase 6 — Stunts & Effects

Add:

- stunt categories;
- injuries;
- stunt doubles;
- effects specialists;
- spectacle scenes;
- richer trailer visuals.

**Passes when:** stunt/effect choices create materially different films rather than cosmetic bonuses.

### Phase 7 — Careers and franchises

Add:

- ageing;
- career summaries;
- signature roles;
- sequels;
- fatigue;
- recasting;
- scandals;
- deeper relationships.

**Passes when:** players can tell stories about specific stars and franchises from their save.

### Phase 8 — Content expansion and polish

Expand toward the version-one content targets.

Add:

- balance passes;
- more review writing;
- poster variation;
- more sound;
- onboarding;
- accessibility;
- export/import;
- archive filtering.

**Passes when:** the game is stable, replayable and ready for public release.

No Phase 8 feature may be used to excuse an unfun Phase 3 loop.

---

## 20. Explicitly out of scope for version one

- Free-form studio-lot construction
- Worker pathfinding
- Full 3D scenes
- Manual camera positioning
- Timeline-based video editing
- User-recorded dialogue
- Real actor likenesses
- Real film licenses
- Real studio names
- Online multiplayer
- Cloud accounts
- Daily live events
- Microtransactions
- Ads
- AI-generated content required at runtime
- Territory-by-territory distribution
- Complex tax and financing simulation
- Union-law simulation
- Real-world political censorship simulation
- Modding tools
- Mobile app packaging
- Steam release

These may be revisited only after the browser game is complete and fun.

---

## 21. Tone and writing rules

The game is affectionate, chaotic and occasionally savage.

It should make fun of:

- ego;
- awards campaigning;
- franchise desperation;
- bad effects;
- tortured directors;
- dishonest marketing;
- method acting;
- executive notes;
- unnecessary sequels.

It should not rely on:

- cruelty toward protected groups;
- sexual harassment jokes;
- graphic injury;
- real celebrity scandals;
- punching down;
- endless meme references that will date quickly.

Review excerpts should feel specific to the generated film.

Examples:

- “The carriage stunt is magnificent. Everything around it appears to have been filmed under protest.”
- “Rex Valentine gives the performance of his career, though his career remains under investigation.”
- “A baffling, beautiful catastrophe.”
- “Children loved the monster. The monster was not meant to be funny.”
- “The sequel answers questions nobody remembers asking.”

---

## 22. Initial balancing defaults

These are starting points, not sacred values.

- Starting cash: `$250,000`
- Starting production slots: `1 per quarter`
- Typical small-film budget: `$80,000–$180,000`
- Typical early actor salary: `$8,000–$30,000`
- Marketing range: `$5,000–$100,000`
- Scene quality variance: approximately `±12`
- Relationship modifier cap: `±10`
- Morale/energy modifier cap: `±10`
- Budget modifier cap: `+18`
- Critical failure floor: always possible only when meaningful risk exists
- Iconic scene ceiling: unavailable without at least one strong underlying factor
- Audience Trust range: `0–100`
- Studio Reputation range: `0–100`
- Prestige range: `0–100`
- Bankruptcy warning: below `$40,000`
- Rescue contract offered: below `$20,000`
- Hard failure: none in v1; a distributor bailout resets reputation and adds debt pressure

The game should discourage save-scumming through humour and continuity, not by hiding or encrypting saves.

---

## 23. Open questions and decisions

### Resolved — 20/07/2026

**Game shape:** persistent studio campaign, not a roguelike run.

**Primary fantasy:** make films and build careers; physical lot management is secondary.

**Platform:** lightweight web game.

**Technical template:** Whisker Warriors-style React single-page build with GSAP animation and local saving.

**Art approach:** the interface is stock-photography dominant. Royalty-free compressed images are hotlinked from providers that permit the intended use, with ordered multi-source fallback arrays for resilience. Talent portraits, screenplay cards, office actions, sets and premiere backdrops use photography. SVG is limited to essential interface icons, masks, small effects and last-resort fallback art. Every production asset requires a traceable manifest entry before release.

**Premiere:** mandatory generated visual recap, not numbers only.

**Randomness:** seeded and deterministic.

**Backend:** none for version one.

**Tone:** light, funny and character-driven rather than ruthless or spreadsheet-heavy.

**Build priority:** complete one-film loop before progression and content scale.

**Deployment:** the canonical browser build lives at `public/one-more-take.html` and deploys through Vercel from the `main` branch.

**Image resilience:** current v0.2 assets use ordered remote source arrays. Compressed stock URLs are the preferred photographic primary; independent fallbacks prevent one blocked host from blanking the interface.

**Icon posture:** use very few inline SVG icons. Prefer typography, photography and clear layout; reserve icons for navigation, sound state and unambiguous utility actions.

### Still open — resolve during Phase 3 or Phase 4

1. Final title: **ONE MORE TAKE!** remains the working title.
2. Whether the fictional studio is named by the player or begins as “Hammy Pictures.”
3. Whether campaigns use real calendar years or fictional Year 1, Year 2 progression.
4. Exact starting roster and character names.
5. RESOLVED: actors and directors use curated stock-photo portraits with deterministic crops and remote fallback chains.
6. Whether scripts are always shown as three cards or become a scrollable market at higher tiers.
7. Whether the player may directly rename every film.
8. How long the unskipped premiere should run; target is 15–25 seconds.
9. Whether awards season occurs after every four films or strictly at year-end.
10. Whether a second production slot is an upgrade or only a late-game tier benefit.
11. Whether the v1 studio can permanently fail or always receives a humiliating rescue.
12. Whether the first public release includes Sci-Fi or holds it for the first major content update.

---

## 24. Definition of success

The game succeeds when a player remembers:

- the actors;
- the feuds;
- the injuries;
- the breakout roles;
- the stupid titles;
- the improbable hits;
- the beloved flops;
- the franchise that should have stopped three sequels ago.

The best result is not “I optimised the numbers.”

It is:

> “Mate, my washed-up romance actor insisted on doing his own fire stunt, broke the set, accidentally created the best scene of the year, won an award, then refused to return for the sequel.”

That is **ONE MORE TAKE!**
