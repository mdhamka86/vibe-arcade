# ONE_MORE_TAKE.md

Design specification for **ONE MORE TAKE!**, a light, funny, mobile-first web game about running a chaotic movie studio. The game takes the emotional core of *The Movies* and *Stunts & Effects*—discovering stars, casting films, surviving productions, directing stunts and watching the finished result—and compresses it into a fast browser tycoon built on the proven **Whisker Warriors** structure.

**Status:** v1.0 PHASE 7 — STARS, SCANDALS & SEQUELS COMPLETE (21/07/2026). All v0.9 stunt, effects, injury, economy, awards, relationship, image-fallback and archive systems remain intact. Talent now ages at year-end and progresses every quarter through persistent morale, loyalty, fatigue, momentum, specialisation, goals, availability, sabbaticals and retirement risk. Training and Rest are proper quarter-consuming office actions. Successful releases can create deterministic franchise opportunities for sequels, reboots, spin-offs, rights sales or a deliberate leave-alone decision. Franchise records preserve lineage, cast and director continuity, goodwill, fatigue, rights, best and worst entries, scores and history. Demands, refusals, walkouts, recasting consequences, mild fictional publicity scandals, relationship labels and signature roles turn long campaigns into career stories. Saves now use version 7 while retaining non-destructive fallback loading and migration from v6, v5, v4, v3, v2 and v1. Forty-five embedded deterministic tests, in-browser Babel transpilation, runtime navigation and image-layout checks are green.

**Owner:** Hammy (hammyLabs)  
**Repo:** `mdhamka86/vibe-arcade`  
**Primary build:** `public/one-more-take.html`  
**Working title:** **ONE MORE TAKE!**  
**Tagline:** *Make movies. Manage egos. Pray for a hit.*

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

The visual layer may fetch hotlinked royalty-free stock images while online. Core gameplay, saves and simulation must remain functional if an image host is unavailable: every external image has an SVG, inline-art or CSS fallback rather than becoming a broken screen.

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
    type: "svg",
    archetype: "heartthrob",
    palette: "crimson-gold",
    variant: 3
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

- illustrated CSS backgrounds;
- inline SVG set art;
- SVG character portraits;
- parallax pans;
- zooms;
- wipes;
- title cards;
- impact flashes;
- silhouette stunts;
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
- compressed royalty-free stock photography for locations, sets, atmosphere and selected portraits;
- SVG overlays, masks, frames, icons and inline illustrated details in the same spirit as Whisker Warriors;
- large readable typography.

### Stock-image approach

The main photographic layer uses **royalty-free compressed stock images loaded from their original permitted remote URLs rather than stored in the repository**.

Stock images are best used for:

- studio backlots and soundstages;
- city streets, mansions, forests and other filming locations;
- genre atmosphere;
- props, costumes and production departments;
- screenplay cards and scene backdrops;
- selected talent portraits where the licence and subject-release terms clearly permit the intended use.

They are complemented by:

- inline SVG character or prop art;
- illustrated silhouettes;
- procedural poster graphics;
- SVG lighting, smoke, rain, fire and impact overlays;
- CSS colour treatments, grain, crops and vignette masks;
- line-art icons and interface decoration consistent with Whisker Warriors.

The stock layer must follow these rules:

1. Use only images whose licence permits commercial use and external embedding or hotlinking.
2. Record the source page, creator, licence, direct image URL and intended use in a central asset manifest.
3. Never use search-result thumbnails, scraped images, copyrighted film stills, celebrity likenesses or URLs with unclear rights.
4. Request appropriately compressed dimensions from image CDNs where supported; do not hotlink full-resolution originals into small cards.
5. Apply `loading="lazy"` and `decoding="async"` outside the currently active scene.
6. Use stable HTTPS URLs and avoid temporary, signed or expiring links.
7. Every hotlinked image must have a local SVG, inline-art or CSS fallback.
8. A failed image may reduce visual richness but must never block gameplay, obscure controls or corrupt a saved premiere.
9. Preserve attribution metadata even when visible attribution is not legally required, so the source can be audited or replaced later.
10. The asset manifest is the single source of truth; raw image URLs should not be scattered throughout UI components.

Example manifest entry:

```js
{
  id: "stock-set-rainy-alley-01",
  kind: "SCENE_BACKGROUND",
  source: "ROYALTY_FREE_STOCK_PROVIDER",
  creator: "Creator Name",
  licence: "Commercial royalty-free / embedding permitted",
  sourcePage: "https://...",
  url: "https://...compressed-image...",
  fallbackArtId: "svg-rainy-alley",
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

Cards should feel collectible without becoming a card battler.

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

### Current development shape

The v1.0 deliverable remains one self-contained playable file:

```text
public/
  one-more-take.html             UI, data, pure engine and deterministic self-tests
```

The engine is defined before the React components and exposes its pure functions plus the 45-test report through `window.OMT_ENGINE` and `window.OMT_V10_TESTS` for diagnostics. React remains a consumer of that engine. No serverless function or separate module is required for deployment.

### Core state

Use one `useReducer` game state rather than dozens of loosely connected state hooks.

```js
{
  saveVersion: 7,
  build: "1.0-stars-scandals-sequels",
  meta: {
    createdAt: "ISO timestamp",
    updatedAt: "ISO timestamp"
  },
  studio: {
    name: "Hammy Pictures",
    cash: 250000,
    debt: 0,
    tier: 1,
    upgrades: [],
    status: "ACTIVE",
    rescues: 0,
    insolvencyStrikes: 0,
    reputation: 12,
    trust: 50,
    prestige: 5,
    year: 1,
    quarter: 1,
    lastQuarterlyCosts: null
  },
  archive: [],
  current: null,
  scriptSlate: null,
  lastRejectedSlateIds: [],
  relationships: {},
  awards: [],
  pendingAwardsYear: null,
  talentCareers: {},
  talentStatus: {},
  injuryHistory: [],
  franchises: {},
  franchiseOpportunities: [],
  scandals: [],
  history: [],
  rngSeed: 12345,
  settings: { sound: true },
  sound: true
}
```

### Pure engine boundary

The inlined engine currently exposes pure and testable functions for:

- game-state creation, validation and v1–v7 migration;
- project creation and deterministic screenplay slates;
- casting chemistry and persistent relationships;
- scene, film and release calculations;
- quarterly advancement, overhead and debt interest;
- studio-tier eligibility and promotion;
- permanent facility purchases and their simulation bonuses;
- deterministic market trends;
- contract offer generation and completion;
- loans, debt repayment and rescue financing;
- year-end awards and talent-career updates;
- quarterly career progression, ageing, training, rest, sabbaticals and retirement risk;
- talent demands, refusal/walkout resolution and fictional scandal outcomes;
- relationship labels, signature roles and persistent collaborator records;
- sequel eligibility, franchise choices, continuity, recasting, goodwill and fatigue;
- premiere finalisation and archive normalisation.

React remains the interface layer. It renders state, requests engine actions and persists the normalized root object; financial and simulation formulas stay outside UI components.

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

`oneMoreTake_save_v7`

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

`oneMoreTake_save_v7_backup`

Before writing a new save, validate and normalize it, then copy the previous valid v7 save to the backup key. Loading checks v7 and its backup, then v6, v5, v4, v3, v2 and their supported backups before finally checking the legacy v1 key. Older saves are migrated without deleting their original storage entries. This non-destructive rule is binding: a successful migration writes the new v7 save but never erases the source key.

### Export/import

The settings screen supports:

- Export Save
- Import Save
- Reset Studio

Import validates shape and save version before replacing anything.

### Performance

- Do not host a large raster library inside the repository.
- Hotlink compressed, correctly sized royalty-free stock variants rather than full-resolution originals.
- Preload only the current screen's hero image and the next likely production image.
- Lazy-load archive, roster and inactive-scene images.
- Portrait and background components must render their SVG/CSS fallback immediately, then enhance with stock photography when it loads.
- Cache successful remote images through normal browser caching; never require an image to be refetched before simulation can continue.
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

### Phase 1 — Static shell and design system

Build:

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

**Implementation status: LOCALLY PASSED — deployment smoke test pending.**

Built:

- version-2 root game state;
- normalized studio and MovieProject contracts;
- centralized talent and script data;
- deterministic seeded RNG;
- root `useReducer` update flow;
- v1 → v2 save migration;
- primary, legacy and backup save recovery;
- save validation before persistence;
- pure chemistry, scene, film-score, release and quarter functions;
- standalone engine module;
- seven-test Node suite;
- four-test in-browser diagnostic hook exposed as `window.OMT_PHASE2_TESTS`.

**Current evidence:** seven of seven Node tests green; four of four in-browser self-tests green; TypeScript JSX transpilation reports zero syntax diagnostics; a mocked runtime load completes without error.

**Passes when:** the v0.3 files are deployed and one full film is completed in a normal browser with migrated and fresh saves. No further engine work is required before that smoke test unless deployment exposes a defect.

### Phase 3 — One complete film

Build the full loop with one fixed script:

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

Current implementation status:

- **Nine scripts — complete in v0.5.** The original three are joined by Crime Thriller, Drama, Creature Horror, Disaster Action, Workplace Comedy and Romantic Drama projects.
- **Quarterly screenplay market — complete in v0.5.** Exactly three scripts are selected deterministically from the nine-script library for the current year and quarter.
- **Rejected-slate memory — complete in v0.5.** Rejecting all three advances the quarter and prevents those same three scripts from immediately returning.
- **Six actors and two directors — complete.**
- **Visible casting chemistry — complete in v0.5.** The Casting Room reports screen chemistry, genre fit, director control and a combined forecast before production approval.
- **Persistent relationships — first pass complete in v0.5.** Co-star and actor/director relationships change after release, survive save/load and affect later chemistry calculations.
- **Production-event breadth — partial.** All nine scripts currently carry four authored scene crises; a later Phase 4 pass should convert part of this into weighted contextual pools.
- **Awards ceremony — complete in v0.6.** Year-end advancement triggers a deterministic seven-category Golden Backlot ceremony exactly once per year, including serious and satirical awards. Winners update studio prestige, film records and persistent talent careers.
- **Expanded archive — complete in v0.6.** Every poster opens a full film record with cast, director, financials, production settings, scene ledger, incidents, relationship fallout and award wins.

**Passes when:** testers voluntarily make several films across multiple quarters, notice that screenplay markets change, make casting decisions based on remembered relationships, reach a year-end ceremony, and revisit specific productions through the detailed archive.

**Core Phase 4 status:** passed in v0.6. Weighted contextual incident pools remain desirable, but the complete multi-quarter story loop now exists.

### Phase 5 — Economy and progression

Implemented in v0.7:

- quarterly overhead and debt interest after films, slate rejection and contracts;
- three studio tiers with reputation, prestige and cash gates;
- six permanent upgrades that feed directly into production formulas;
- deterministic genre trends that affect audience response and box office;
- three deterministic contract offers per quarter;
- small and large loan products plus partial debt repayment;
- distress and insolvency tracking;
- one costly, humiliating rescue package per year;
- save-version-4 migration and financial history events.

**Implementation status:** complete in v0.7.

**Balance gate:** passes when live testing confirms that a multi-year campaign is challenging but recoverable, contracts do not dominate filmmaking, promotions arrive at a satisfying pace and rescue financing feels painful without becoming a death spiral.

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

**Implementation status:** complete in v1.0.

Implemented:

- year-end ageing and deterministic quarterly career progression;
- persistent morale, loyalty, fatigue, momentum, goals, availability, sabbaticals and retirement risk;
- skill growth, genre specialisation and quarter-consuming Training and Rest actions;
- career summaries covering hits, flops, awards, injuries, signature roles and frequent collaborators;
- sequel opportunities driven by audience response, profit, awards and cult status;
- sequels, reboots, spin-offs, rights sales and leave-alone decisions;
- franchise goodwill, fatigue, rights, lineage, instalment scoring, cast/director continuity and best/worst entries;
- recasting bonuses and penalties;
- salary, billing, creative-control, preferred-co-star and genre demands;
- deterministic refusals, walkouts and fictional publicity scandals;
- friendship, feud, mentorship and romance relationship labels;
- signature roles for successful actor–film combinations.

**Passed because:** multi-year saves now preserve enough causal career and franchise history for players to tell stories about specific stars, collaborators, incidents and instalments.

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

**Art approach:** royalty-free compressed stock images are hotlinked rather than stored in the repo. Each visual slot uses a finite multi-source chain—currently Unsplash, Picsum and Placehold.co—before revealing its non-blocking SVG/CSS fallback. v0.4 adds context-specific art direction: the same asset may define separate crops for a wide pitch card, cinematic production backdrop and tall theatrical poster, plus controlled scale, brightness, saturation and contrast. Key pitch art is now story-specific rather than merely genre-adjacent. Stock-photo portraits remain locked for actors and directors. SVG is retained mainly for essential controls and last-resort fallback art.

**Premiere:** mandatory generated visual recap, not numbers only.

**Randomness:** seeded and deterministic.

**Backend:** none for version one.

**Tone:** light, funny and character-driven rather than ruthless or spreadsheet-heavy.

**Build priority:** complete one-film loop before progression and content scale.


**Image rendering:** resolved. The missing-photo problem was CSS paint order, not failed hotlinks. The real `<img>` layer now sits above the absolutely positioned fallback layer.

**Talent portraits:** resolved. Use curated stock-photo portraits with multi-host fallbacks; procedural SVG faces are no longer the primary presentation.

**Studio naming:** resolved. The player may name the studio; “Hammy Pictures” remains the default.

**Campaign calendar:** resolved for v1. Use fictional Year/Quarter progression rather than real historical years.

**Phase 2 engine boundary:** resolved. The browser build inlines the engine for portability while the same pure functions are maintained in an `.mjs` module with Node tests.

**Script-slate control:** resolved. The player is never forced to greenlight a pitch. Rejecting all three consumes the current quarter, clears any selection, records `SCRIPT_SLATE_REJECTED` in studio history and returns the player to the office in the next quarter.

**Script-market size:** resolved for Phase 4. The library contains nine authored screenplays, while the player sees a deterministic market of exactly three each quarter.

**Immediate slate repeats:** resolved. A rejected three-script slate is excluded from the following quarter whenever the remaining library can supply three alternatives.

**Casting information:** resolved for the first relationship pass. Once lead, co-lead and director are selected, the game shows overall casting fit, actor chemistry, genre fit, director control and contextual notes before the player commits the budget.

**Persistent relationships:** resolved for v0.5. Co-star and actor/director relationship values are stored in the root save, modify future chemistry and are updated after every released film.

**Awards timing:** resolved for v0.6. Awards season runs whenever the calendar crosses from Q4 into the next year, whether the quarter ends through a premiere or rejection. Each year can generate only one ceremony.

**Awards persistence:** resolved for v0.6. Ceremony results, nominations, film wins, talent fame deltas and career records now live inside save version 4 and migrate safely from v3, v2 and v1.

**Archive depth:** resolved for the vertical slice. Archive posters open detailed production records instead of acting as decorative thumbnails.

**Stunt control:** resolved for v0.9. Every relevant stunt scene offers actor performs, stunt double, simplify, dangerous version and effects replacement. The decision records cost, risk, quality, delay, injury and signature-scene consequences.

**Effects philosophy:** resolved for v0.9. Practical, digital and hybrid effects have distinct costs, reliability, spectacle, prestige, time and genre-fit modifiers. The selected approach applies across the production and is preserved in the archive.

**Specialist hiring:** resolved for v0.9. A production may hire up to two specialists from stunt coordination, stunt performance, practical effects, digital effects and creature design. Fees, skill, traits and director compatibility feed deterministic outcomes.

**Injury availability:** resolved for v0.9. Actor injuries create explicit one-to-three-quarter recovery windows. Unavailable actors remain visible but cannot be cast; contract, rejection and release quarter advancement all progress recovery.

**Contextual production events:** first complete pass shipped in v0.9. Weighted selection uses genre, scene type, traits, director traits, relationships, stunt/effects approach, funding, specialists, owned upgrades, market trend and previous incidents. Exact results remain seeded.

### Still open — resolve during later content passes

1. Whether **ONE MORE TAKE!** becomes the permanent final title.
2. Whether higher studio tiers retain the three-card slate or unlock a broader scrollable script market.
3. Whether the player may directly rename every film.
4. Whether the unskipped premiere should remain roughly 15–25 seconds.
6. Whether a second production slot is purchased as an upgrade or granted by studio tier.
7. Whether insolvency should eventually permit permanent failure; v0.7 currently guarantees a costly recovery path.
8. Whether relationship-label thresholds should move more slowly in long campaigns; v1.0 starts friendship at +35, romance at +52, mentorship at +45 for actor/director pairs and feud at -35.
9. Whether quarterly overhead should rise with every individual upgrade rather than only with studio tier.
10. Whether the current retirement curve creates enough late-career jeopardy without making beloved veterans disappear too abruptly.
11. Whether Training at $15,000 plus quarterly costs and Rest at $6,000 plus quarterly costs are meaningful alternatives to making a film.
12. How much familiarity should protect sequels before originality loss and franchise fatigue dominate.
13. Whether recasting should ever create a positive discovery bonus rather than only reducing continuity and goodwill.
14. Whether publicity scandals occur often enough to create stories without overwhelming production outcomes.
15. Whether selling franchise rights pays too much for early studios or too little for established hits.

---

## v0.6 implementation record — Awards & Archive

Implemented in the deployable single-file build:

- save schema raised from version 2 to version 3;
- v2, v2 backup and v1 saves migrate into the new root contracts;
- root state now stores `awards`, `pendingAwardsYear` and `talentCareers`;
- Q4 premiere or Q4 slate rejection triggers awards for the completed year;
- ceremonies are deterministic from studio seed, eligible films and completed year;
- categories: Best Picture, Best Director, Best Performance, Best Stunt, Best Effects, Biggest Flop and Most Questionable Creative Decision;
- awards can run only once for a given year;
- serious wins add studio prestige;
- film credits and award wins modify persistent talent fame and career history;
- new releases store production budget, department levels, posture, post decision, campaign, marketing and notable incidents;
- archive posters open a complete film-detail screen;
- year-end results route directly into the ceremony and pending ceremonies remain recoverable from the office;
- embedded deterministic checks increased from eight to fourteen.

Validation completed for the prepared build:

- TypeScript JSX parser: zero syntax errors;
- PostCSS parser: clean;
- embedded engine suite: 14/14 passed;
- deployable and versioned HTML byte counts match.

---


## v0.7 implementation record — Studio Progression & Economy

Implemented in the deployable single-file build:

- save schema raised from version 3 to version 4;
- v3, v3 backup, v2, v2 backup and v1 saves migrate into the current root contracts;
- studio state now records tier, debt, owned upgrades, rescue usage, insolvency strikes, financial status and the last quarterly cost ledger;
- Garage Pictures, Independent Studio and Major Lot tiers use distinct promotion gates and quarterly overhead;
- Soundstage B, Talent Lounge, Competent Accounting Office, In-house Post Suite, Marketing Wing and Practical Effects Yard are permanent purchasable facilities;
- upgrade bonuses feed casting chemistry, scene outcomes, craft, coherence, spectacle, audience scoring, box office and overhead;
- quarterly settlement runs after a film release, script-slate rejection or completed contract;
- debt accrues 2.5% interest per quarter;
- deterministic market trends highlight one genre each quarter and provide a visible audience and box-office bonus;
- deterministic contract boards offer three emergency jobs each quarter, each consuming the production slot;
- players may take $100,000 or $250,000 loans, repay debt in chunks and access a once-per-year rescue below $75,000 cash;
- negative cash creates DISTRESSED status, while repeated or severe deficits create INSOLVENT status without deleting the campaign;
- film records store the studio tier, owned upgrades, market trend and quarterly costs active at release;
- the Studio Office now surfaces debt, tier, financial status, next-quarter costs and the live market trend;
- embedded deterministic checks increased from fourteen to nineteen.

Validation completed for the prepared build:

- TypeScript JSX transpilation: zero errors;
- embedded engine suite: 19/19 passed;
- deterministic contracts, promotions, upgrades, loans, repayments and quarterly settlement checks passed;
- deployable and versioned HTML byte counts match.

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


---

## v0.8 implementation record — Economy Balance & Pressure

### Balance goals

- Contract work must rescue a weak quarter without replacing filmmaking as the best long-term strategy.
- Debt must create visible pressure while remaining recoverable through good films, contracts or one annual rescue package.
- Studio promotions must feel earned, and higher tiers must carry meaningfully higher fixed costs.
- Insolvency must change available choices rather than exist as a cosmetic status label.

### Implemented systems

- Added a persistent `contractStreak` to the studio state.
- Consecutive contract quarters reduce fees through a bounded fatigue multiplier.
- Low reputation and audience trust further reduce available contract fees.
- Repeated contract work applies increasing reputation, trust and prestige penalties.
- Completing a feature film resets contract fatigue to zero.
- Rejecting a screenplay slate also breaks the contract streak, but still charges quarterly costs.
- Contract cards now show gross payment and projected net cash after overhead and debt interest.
- Added `calculateFinancialRunway()` with HEALTHY, WATCH, TIGHT and CRITICAL states.
- Studio Office now shows projected quarterly costs and remaining cash runway.
- Studio & Finance now records lifetime overhead and interest paid.
- Insolvent studios cannot start another film until their finances recover. Contract work and financing remain accessible.
- Added cumulative contract and overhead counters for future analytics and achievements.

### Automated balance audit

The deterministic audit selected the best-paying available contract for twelve consecutive quarters. The studio remained solvent and accumulated cash, but reputation and prestige collapsed to zero and trust fell sharply. This confirms the intended trade-off: contract work can keep the doors open, but a contract-only studio sacrifices the standing required for tier promotion and prestigious long-term growth.

The current numbers should still be watched during live play. The next tuning pass should compare three player profiles over five game years:

1. film-first with no borrowing;
2. balanced films and occasional contracts;
3. aggressive expansion funded by debt.

### Save compatibility

- Current save version: **5**.
- Automatically migrates save versions 4, 3, 2 and 1.
- New fields default safely when absent: `contractStreak`, `completedContracts`, and `lifetimeOverhead`.

### Validation

- TypeScript JSX transpilation diagnostics: **0**.
- Embedded engine tests: **22/22 passed**.
- Contract-fatigue test: passed.
- Film-resets-fatigue test: passed.
- Financial-runway test: passed.
- Twelve-quarter deterministic contract audit: completed.

---

## v0.9 implementation record — Stunts, Effects & Production Chaos

### Player-facing production systems

- Relevant scenes now replace the generic three-choice crisis with five stunt approaches: Actor Performs, Stunt Double, Simplify the Stunt, Attempt Dangerous Version and Replace It with Effects.
- Each stunt approach carries an explicit cash cost plus different risk, reliability, spectacle, performance, prestige and schedule values.
- Production planning now requires one effects approach: Practical Effects, Digital Effects or Hybrid Effects.
- Effects approaches have separate fees and different reliability, spectacle, prestige, production-time and genre-fit profiles.
- Five named hireable specialists are available: stunt coordinator Mara Voss, stunt performer Jax Rook, practical-effects supervisor Ines Calder, digital-effects supervisor Omar Quill and creature designer Bea Moss.
- A production may hire up to two specialists. Every specialist stores fee, discipline, skill, traits and compatibility with each director.
- Production-plan totals include effects fees and all hired-specialist fees. Scene-level stunt decisions are counted as production overruns in release profit and final studio cash.

### Deterministic risk and event model

- `calculateStuntOutcome()` is seeded from the project, scene and chosen approach.
- Injury probability combines screenplay difficulty, approach risk, production posture, stunt-department funding, actor willingness, accumulated fatigue, prior incidents, coordinator skill, stunt-performer mitigation, effects reliability and director compatibility.
- Actor willingness is visible on talent cards and derives from reliability plus traits such as Fearless, Stunt Curious, Quiet Professional and Refuses to Die On Screen.
- Injuries are MINOR, MODERATE or SERIOUS and create one-, two- or three-quarter recovery windows.
- Production delays accumulate in days and reduce coherence while remaining visible through release and archive records.
- Contextual events are selected from a weighted authored pool. Weights react to genre, scene type, actor and director traits, relationships, stunt/effects approach, funding, specialist disciplines, market trend, owned upgrades and previous incident IDs.
- Previous contextual events are sharply down-weighted to avoid immediate repetition within the same production.
- High-quality or successfully dangerous scenes can become named signature scenes.

### Persistence, premiere and archive

- Save schema raised from version 5 to version 6.
- v5, v5 backup, v4, v4 backup, v3, v3 backup, v2, v2 backup and v1 saves migrate into the current root contract.
- New root fields: `talentStatus` and `injuryHistory`.
- New project fields: `effectsApproach`, `specialistIds`, `fatigueByTalent`, `studioUpgrades`, `marketGenre`, `signatures` and `delays`.
- Talent status persists fatigue, injury text, severity and an absolute recovery quarter.
- Injured performers remain visible in the roster and casting room but cannot be selected until recovery completes.
- Quarter advancement through a film, contract or rejected slate reduces fatigue and resolves completed recovery windows.
- Film records now retain stunt approaches, risk values, effects approach, specialist snapshots, injuries, delay days, signature scenes, contextual incidents, consequences and stunt overruns.
- Premiere beats promote signature scenes and production injuries into the generated trailer rather than leaving them as archive-only data.
- Results and film-detail screens surface the same production history, including specialists and every recorded stunt approach.

### Compatibility and reliability fixes

- The single-file React/Babel architecture remains unchanged.
- All v0.8 economy, awards, relationships, script-market, image fallback and archive systems remain active.
- The recovered v0.8 source referenced `gameReducer` without defining it. v0.9 restores the reducer so new, continued and replaced game states initialize correctly.
- The real-image paint-order fix remains unchanged: remote images stay above non-blocking fallback art.

### Validation

- Babel React transpilation: passed with no syntax diagnostics.
- Embedded deterministic suite: **28/28 passed**.
- Component runtime smoke: title, casting, production plan, production, release, roster and film-detail components render against representative state.
- Dedicated tests cover deterministic stunt outcomes, specialist mitigation, injury persistence and recovery, contextual event determinism, v5-to-v6 migration and signature-scene archival.
- `git diff --check`: clean.

### Next phase

Phase 7 should deepen careers rather than widen production risk again: ageing, availability beyond injuries, role specialisation, franchises, sequels, recasting, scandals and long-term star/director career arcs.

---

## v1.0 implementation record — Stars, Scandals & Sequels

### Living careers

- Every actor and director has a normalized career record with age delta, fame delta, morale, loyalty, momentum, skill growth, genre specialisations, career goal, current status, retirement risk, hits, flops, injuries, awards, signature roles, collaborators, scandals and demand history.
- Quarter advancement updates fatigue, availability, morale, loyalty, momentum, inactivity and retirement risk. Q4 advancement also ages all talent by one year.
- Retirement and sabbatical outcomes are deterministic from the save seed, talent ID and quarter index. Existing injury recovery remains authoritative and continues to advance through releases, contract work, rejected slates, Training and Rest.
- Training costs $15,000 before quarterly studio costs, consumes the quarter and adds two points of persistent skill growth in the selected discipline.
- Rest costs $6,000 before quarterly studio costs, consumes the quarter, sharply reduces fatigue and improves morale and loyalty.
- The Studio Office links to a dedicated Career Center. The roster presents current age, status, goal, morale, loyalty, momentum, hits, flops, awards, injuries, specialisation, signature roles and frequent collaborator.

### Franchises and sequels

- `evaluateSequelEligibility()` checks strong audience response, profit, awards and cult-status divergence without asking React to reproduce the formula.
- Eligible films generate one persistent open opportunity. The archive offers Sequel, Reboot, Spin-off, Sell Rights and Leave Alone choices.
- Ordering a continuation creates a normal `MovieProject` carrying franchise ID, type, instalment number, parent film and preferred returning cast. The original film receives explicit ORIGINAL lineage in the archive.
- Franchise records store original film, instalment IDs, original cast, original director, goodwill, fatigue, rights status, entry audience scores, best entry, worst entry and an append-only history.
- Returning cast and director create familiarity and marketing advantages. Recasting reduces continuity and audience goodwill. Every new instalment increases fatigue, with successful audience response reducing part of that rise.
- Selling rights pays a deterministic share of known gross with a floor, changes the rights status to SOLD and prevents later in-house continuation.
- Results, Archive and Film Detail surface lineage, returning cast, recasts, goodwill, fatigue, rights and franchise history.

### Demands, walkouts and scandals

- Casting can generate seeded salary, billing, creative-control, preferred-co-star or genre-change demands from current morale, loyalty, momentum, fame, goal and the proposed role.
- Accepting a demand records its cost or creative consequence. Refusing it reduces morale and loyalty; sufficiently unhappy talent walks out and is removed from that casting slot.
- Mild fictional scandals are selected from an authored set about spoilers, props, method acting, billing and publicity feuds. They affect fame, studio trust, audience response and relationships without targeting real celebrities or protected classes.
- Relationship scores now resolve to Friendship, Feud, Mentorship or Romance labels when their deterministic thresholds are crossed.
- Successful actor–film combinations become signature roles, including strong originals before a franchise exists.

### Save version 7

New root fields:

- `franchiseOpportunities[]` — persistent development decisions and their resolution state;
- `scandals[]` — studio-wide publicity history;
- expanded `talentCareers{}` — normalized career progress, specialisation and personal history;
- expanded `franchises{}` — lineage, rights, fatigue, goodwill, entry scores and history.

New project fields:

- `baseTitle`;
- `demands[]` and `demandCosts`;
- `franchise` with ID, type, instalment, parent and preferred cast.

New film fields:

- `scandals[]`;
- franchise lineage, returning cast, recast IDs and calculated modifiers;
- relationship changes with their resulting label.

The loader reads the v7 primary and backup first, then supported v6, v5, v4, v3, v2 and v1 keys. Migration normalizes new collections and career records while retaining every legacy key. No migration deletes the source save.

### Validation

- Embedded deterministic engine suite: **45/45 passed**.
- New coverage includes ageing, retirement risk, Training, Rest, sequel eligibility, franchise fatigue, recasting, demands, walkouts, scandal generation and effects, relationship labels, v6-to-v7 migration, franchise choices, rights sales, archive lineage and signature roles.
- In-browser Babel React transpilation completed with no current syntax or runtime error.
- Runtime smoke covered new-studio creation, Studio Office, Career Center, Training quarter settlement, screenplay selection and Casting.
- Remote images loaded with natural dimensions in the exercised screens and no card or panel overflow was detected.

### Remaining Phase 8 work

- multi-year economy and career balance passes;
- onboarding and contextual help for career status, demands and franchise decisions;
- accessibility audit, keyboard focus and reduced-motion treatment;
- save export/import and recovery UI;
- archive filtering and clearer franchise navigation;
- more reviews, publicity incidents, demands and career-goal reactions;
- poster variation, additional audio and final mobile polish.
