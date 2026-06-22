const { useState, useRef, useEffect } = React;

// ===== THE WERKROOM: A Drag Race Season Run =====
// Quiz edition. The maxi challenge is an RPDR trivia round. Pass = safe/high/win.
// Fail = bottom two = Lip Sync For Your Life (a turn-based "Top That" duel).
// AI judges your drag name (fair but a touch generous) and your Library reads (extra sassy).

const QUEENS = [
  "Velvet Vandross", "Coco Cataclysm", "Mona Lott", "Bianca Sparkle",
  "Trixie Tornado", "Roxy Rampage", "Delta Dawn", "Sasha Supreme",
  "Lola Latex", "Gigi Glamazon", "Tonya Tea", "Vesper Vixen",
  "Nasty Nadine Naomi",
];

// Easter egg: Nasty Nadine Naomi is a fan-favorite powerhouse. Known for killer
// looks and a stunning body, she's one of the toughest queens to beat, gets a
// fixed glowing dossier in the Library, and is a stronger lip sync rival.
const STAR_QUEEN = "Nasty Nadine Naomi";
const STAR_QUEEN_DESC = "a runway assassin with killer looks and a stunning body. Eats every challenge for breakfast and never breaks a sweat.";

// Survival lip sync songs (the weekly bottom-two duels)
const LIPSYNC_SONGS = [
  "Stronger", "Survivor", "I'm Every Woman", "Vogue",
  "Bring Me To Life", "Free Your Mind", "No More Drama", "Show Me Love",
  "Express Yourself", "Cold Hearted", "Two of Hearts", "So Emotional",
  "Bootylicious", "Dreamlover", "Greatest Love of All", "Shackles",
  "Step It Up", "Maniac", "Whip My Hair", "I'm Coming Out",
  "Nasty Girl", "Physical", "Take Me or Leave Me", "Gimme More",
];

// Grand-finale "Lip Sync For The Crown" songs (bigger, more anthemic)
const LEGACY_SONGS = [
  "Born This Way", "I Will Survive", "Respect", "It's Raining Men",
  "This Is My Life", "And I Am Telling You I'm Not Going", "The Greatest Love of All",
  "Don't Rain on My Parade", "I'm Still Here", "Diamonds Are a Girl's Best Friend",
  "I'm Coming Out", "Let's Have a Kiki", "Survivor", "Stronger",
  "Edge of Glory", "Fighter", "Confident", "Roar",
];

// ---- ELIMINATION FAREWELLS ----
// When a queen is eliminated, she drops one witty RPDR-style farewell line.
// Big bank for variance across many weeks and many queens. The {q} token is
// swapped for the eliminated queen's name where useful. Mix of delusional,
// gracious, shady, tearful-but-iconic, and meme-y energies.
const FAREWELL_LINES = [
  "Don't be sad it's over, be glad you got to witness this body for as long as you did.",
  "I'm not crying, this is just my highlighter sweating.",
  "If I'm going home, at least I'm going home the prettiest.",
  "I came, I saw, I contoured. No regrets.",
  "Eliminated? On a technicality. The crown knows my name.",
  "Tell the producers I said the edit did me dirty, but I still ate.",
  "The other girls can keep the competition, I'm keeping my dignity and my wigs.",
  "I'd say good luck to the rest of you, but we both know luck isn't what got me here.",
  "Going home with my head high and my tuck higher.",
  "They didn't eliminate me, they just couldn't handle me.",
  "I'm too much glamour for one little stage anyway.",
  "Sashay? Honey, I'm gonna STRUT out of here.",
  "I leave you with this: I was robbed, and I look fabulous saying it.",
  "Cry for me later, gag over me forever.",
  "The judges made a mistake tonight, but the fans never will.",
  "I'm not the first legend to be sent home too soon, and I won't be the last.",
  "Keep my name in your mouth, girls, it's the closest you'll get to my talent.",
  "I'm leaving, but my influence is staying right here in this werk room.",
  "Don't worry about me, I land on my feet. In heels. Flawlessly.",
  "This isn't goodbye, this is 'see you on the reunion looking even better.'",
  "I gave you everything and you gave me a one-way ticket. Rude, but okay.",
  "At least now I get to sleep in while the rest of you suffer.",
  "I auditioned five times for this. I'll be back a sixth. Watch me.",
  "You can take me out of the competition but you cannot take the competition out of me.",
  "I'm the kind of queen they make documentaries about. This is just chapter one.",
  "Send me home, fine, but you'll be quoting me for seasons.",
  "I'm not bitter, I'm just better, and the math didn't math tonight.",
  "Tell my haters I said thank you, the obsession kept me warm.",
  "I'll allow it. The crown wasn't ready for me yet.",
  "I'm exiting stage left, but make it couture.",
  "I peaked in the werk room and I'd do it all again.",
  "I'm gonna miss reading you girls. Truly. It was my cardio.",
  "If loving myself this much is a crime, then lock me up, officer.",
  "I leave as I arrived: undeniable.",
  "The lip sync gods were busy tonight, clearly.",
  "I'm taking my talent, my looks, and my snacks. The rest of you can have the drama.",
  "History will be kind to me. The judges, not so much.",
  "I didn't lose, I just ran out of episodes.",
  "I'm a once-in-a-generation queen and you got me for a discount. You're welcome.",
  "Pack it up, pack it in, this queen is going out 10s across the board in my heart.",
  "I'd cry but my lashes cost more than the prize money.",
  "Mama always said go out with grace. Mama never met these judges.",
  "I'm not gagged, I'm just resting my gag face.",
  "Goodbye cruel werk room, hello brand deals.",
  "You'll see me again. Villains always come back.",
  "Even my exit is more iconic than half these girls' wins.",
  "Tell the camera I said 'and I oop' and let me leave with my legacy.",
  "I'm not going home, I'm going on tour. There's a difference, darling.",
  "I'll take the bullet, but I'm taking it in a full beat and a gown.",
  "This werk room was lucky to have me, and don't you forget it.",
];

// The "who left / how many remain" announcement gets variance too. {q} = queen,
// {n} = queens remaining, {plural} = "queen" or "queens".
const ELIM_ANNOUNCEMENTS = [
  "{q} has left the werk room. {n} {plural} remain.",
  "And just like that, {q} sashays away. {n} {plural} still in the race.",
  "{q} packs her wigs and exits. That leaves {n} {plural} chasing the crown.",
  "The lights dim on {q}. {n} {plural} remain in the running.",
  "{q} takes her final walk. Down to {n} {plural} now.",
  "Another sister gone: {q} has sashayed away, leaving {n} {plural} standing.",
  "{q} lipstick-kisses the mirror goodbye. {n} {plural} fight on.",
  "Say farewell to {q}. The competition narrows to {n} {plural}.",
  "{q} hangs up her heels for the season. {n} {plural} left to slay.",
  "The werk room loses {q} tonight. {n} hungry {plural} remain.",
];

// hilarious quips peppered through the games to keep it fun
const TEA_RIGHT_QUIPS = [
  "Gag. You really know your herstory, hunty.",
  "A scholar AND a showgirl. We love to see it.",
  "Correct! The library is officially open and you're shelved under genius.",
  "Yes mama. That brain is serving full-tuck realness.",
  "Ding ding ding. Somebody get this queen a teaching credential.",
  "Right again. You've clearly done your homework, professor.",
];
const TEA_WRONG_QUIPS = [
  "Oof. That tea was cold, sis. Reheat and try again.",
  "Wrong. Even Michelle Visage just gasped.",
  "Nope. That's not tea, that's a whole conspiracy theory.",
  "Incorrect, darling. The shade of it all.",
  "Sis... no. Go back to drag kindergarten.",
  "Wrong answer, but you said it with confidence. We respect the delusion.",
];
const SCRAMBLE_RIGHT_QUIPS = [
  "Word perfect. RuPaul is shook.",
  "You snatched that line like a wig at a brawl.",
  "Flawless. The lyrics bow down to you.",
  "Correct! You ate and left zero crumbs.",
];
const SCRAMBLE_WRONG_QUIPS = [
  "Close, but the lyrics said sashay away.",
  "Not quite, hunty. The words are out of drag.",
  "Scrambled like brunch, sis. Try the next one.",
  "Wrong order. The judges are clutching their pearls.",
];

// famous RuPaul-isms sprinkled onto the end screens for flavor
const RU_SIGNOFFS = [
  "If you can't love yourself, how in the hell you gonna love somebody else?",
  "We're all born naked and the rest is drag.",
  "Don't be jealous of my boogie.",
  "Good luck, and don't f*** it up.",
  "Now everybody say love.",
  "You're a winner, baby.",
  "Unitards! That should be the name of your album.",
  "Tell me something good, gurl... and may the best woman win.",
];

// ---- Lip Sync "Top That" duel ----
// The crowd's vibe rotates each round. A move scores big when it matches the
// vibe, fizzles when it clashes. Both queens reveal at the same time.
const VIBES = [
  { key: "hype", label: "HIGH ENERGY", emoji: "\u{1F525}", color: "#ff4d4d", note: "The beat drops. The crowd wants ENERGY." },
  { key: "emo", label: "EMOTIONAL", emoji: "\u{1F622}", color: "#6fa8ff", note: "A tender verse. They want feeling and story." },
  { key: "sexy", label: "SULTRY", emoji: "\u{1F90D}", color: "#d8b15a", note: "Slow and smoldering. Bring the seduction." },
  { key: "climax", label: "BIG FINISH", emoji: "\u{1F4A5}", color: "#ffd966", note: "The key change! Give them a SHOWSTOPPER." },
];

// Each move favors a vibe (matchBonus when vibe matches), has a base power,
// and a little flavor line. risk = how much it underperforms when off-vibe.
const LS_MOVES = [
  { name: "Death Drop", emoji: "\u{1F4A5}", fav: "climax", base: 6, risk: 3, flav: "drops into a perfect dead splits" },
  { name: "Reveal Look", emoji: "\u2728", fav: "climax", base: 6, risk: 3, flav: "rips the gown into a second look" },
  { name: "Power Belt Sync", emoji: "\u{1F3A4}", fav: "hype", base: 6, risk: 2, flav: "nails every word with attitude" },
  { name: "Cartwheel Combo", emoji: "\u{1F938}", fav: "hype", base: 5, risk: 2, flav: "tumbles across the stage" },
  { name: "Tearful Storytelling", emoji: "\u{1F622}", fav: "emo", base: 6, risk: 2, flav: "mouths the words like a confession" },
  { name: "Slow Hand Drama", emoji: "\u{1F590}\uFE0F", fav: "emo", base: 5, risk: 2, flav: "reaches out, aching, to the judges" },
  { name: "Body Roll", emoji: "\u{1F30A}", fav: "sexy", base: 6, risk: 2, flav: "rolls through every count of the beat" },
  { name: "Smolder & Strut", emoji: "\u{1F60F}", fav: "sexy", base: 5, risk: 2, flav: "works the runway with a slow burn" },
  { name: "Tongue Pop", emoji: "\u{1F445}", fav: "hype", base: 4, risk: 1, flav: "pops off a cheeky tongue snap" },
  { name: "Duck Walk", emoji: "\u{1F986}", fav: "sexy", base: 4, risk: 1, flav: "duck walks low across the floor" },
];

// ---- RPDR trivia bank ----
// Each: q, options[4], answer index (a), ep (episode/context), line (iconic quote).
// Pool is large enough that a full 9-week season never repeats a question.
const TRIVIA = [
  { q: "Who won the very first season of RuPaul's Drag Race (US)?", o: ["BeBe Zahara Benet", "Tyra Sanchez", "Raven", "Nina Flowers"], a: 0, ep: "Season 1 Finale (2009)", line: "The soft-focus 'vaseline on the lens' season that started it all." },
  { q: "Who won the very first All Stars season?", o: ["Chad Michaels", "Alaska", "Trixie Mattel", "Monet X Change"], a: 0, ep: "All Stars 1 Finale (2012)", line: "The much-debated team-format All Stars season." },
  { q: "Which queen won All Stars 2, beating Katya and Detox in the finale?", o: ["Alaska", "Roxxxy Andrews", "Tatianna", "Phi Phi O'Hara"], a: 0, ep: "All Stars 2 Finale (2016)", line: "'Thank you, but no.' Alaska's polarizing victory lap." },
  { q: "Jinkx Monsoon's celebrated Snatch Game impression was of whom?", o: ["Little Edie", "Cher", "Judy Garland", "Liza Minnelli"], a: 0, ep: "Season 5, Snatch Game", line: "'This is the BEST costume for the day.' Staunch, darling." },
  { q: "Which spin-off crowned Lawrence Chaney as its winner?", o: ["Drag Race UK Series 2", "Canada's Drag Race", "Drag Race Down Under", "Drag Race Espana"], a: 0, ep: "Drag Race UK S2 Finale (2021)", line: "Scotland's sweetheart takes the crown." },
  { q: "Which queen coined the exit catchphrase about her own stage name being repeated three times?", o: ["Vanessa Vanjie Mateo", "Asia O'Hara", "Monique Heart", "The Vixen"], a: 0, ep: "Season 10, Episode 1", line: "'Miss Vanjie... Miss Vanjie... Miss... Vanjie.' The backwards walk heard 'round the world." },
  { q: "Who delivered the infamous lip sync excuse blamed on her own back?", o: ["Mystique Summers Madison", "Shangela", "Kennedy Davenport", "Coco Montrese"], a: 0, ep: "Season 2, Episode 1", line: "'Backrolls?! ... I don't have no backrolls!'" },
  { q: "Sasha Velour's iconic rose-petal reveal happened during a lip sync to which song?", o: ["So Emotional", "Stronger", "Greatest Love of All", "Holding Out for a Hero"], a: 0, ep: "Season 9 Finale, vs Shea Coulee", line: "The wig comes off, the rose petals rain down. Lip sync history." },
  { q: "Which queen refused to remove her mask during a Season 9 lip sync?", o: ["Valentina", "Farrah Moan", "Nina Bo'nina Brown", "Kimora Blac"], a: 0, ep: "Season 9, Episode 9", line: "'I'd like to keep it on, please.' RuPaul: 'Girl, what is going on with you?'" },
  { q: "What is the term for a queen with classic, polished, competition-circuit drag?", o: ["Pageant queen", "Comedy queen", "Look queen", "Camp queen"], a: 0, ep: "Drag vocabulary", line: "Hair tall, gown beaded, every hair in place. Pure pageant." },
  { q: "Which winner is a singer-songwriter who plays autoharp and released the album Barbara?", o: ["Trixie Mattel", "Adore Delano", "Courtney Act", "Willam"], a: 0, ep: "Post-S7 / AS3 era", line: "'Oh honey...' From Skinny Legend to Grammy-adjacent folk star." },
  { q: "In ballroom culture, voguing poses are drawn primarily from what?", o: ["Fashion magazine poses", "Ballet positions", "Yoga", "Martial arts"], a: 0, ep: "Ballroom history", line: "Striking the poses of Vogue magazine, hence the name." },
  { q: "Which queen famously declared she was a model and told others to lower their eyes?", o: ["Mimi Imfurst", "Phi Phi O'Hara", "Willam", "Sharon Needles"], a: 0, ep: "Season 4 reunion", line: "'I'm a model. You better lower your eyes when you speak to me.'" },
  { q: "What does it mean to be 'cracking' on the runway?", o: ["Breaking character / losing composure", "Doing a split", "A flawless walk", "A wardrobe reveal"], a: 0, ep: "Drag vocabulary", line: "The illusion slips and the panic shows. Don't crack, queen." },
  { q: "Which goth-inspired queen won Season 4?", o: ["Sharon Needles", "Chad Michaels", "Phi Phi O'Hara", "Latrice Royale"], a: 0, ep: "Season 4 Finale (2012)", line: "'Party City' realness with a spooky, beautiful edge." },
  { q: "What is a 'gaff' used for in drag?", o: ["Holding the tuck in place", "Padding hips", "Securing a wig", "Cinching the waist"], a: 0, ep: "Drag vocabulary", line: "The unsung hero of a smooth silhouette." },
  { q: "Which queen is known for the catchphrase about looking over there?", o: ["Tatianna", "Raven", "Jujubee", "Manila Luzon"], a: 0, ep: "Season 2", line: "'Look over there!' The greatest deflection in herstory." },
  { q: "Bianca Del Rio is best known as which kind of queen?", o: ["Comedy / insult queen", "Pageant queen", "Dance queen", "Look queen"], a: 0, ep: "Season 6 winner", line: "'Not today, Satan. Not today.'" },
  { q: "What does 'tea' (or T) mean in drag slang?", o: ["Gossip / truth", "A drink break", "A type of dress", "A dance move"], a: 0, ep: "Drag vocabulary", line: "'What's the T?' Spill it, sis." },
  { q: "Which judge and former member of Seduction is RuPaul's right hand?", o: ["Michelle Visage", "Carson Kressley", "Ross Mathews", "Ts Madison"], a: 0, ep: "Series regular since S3", line: "'I just want you to give me more of YOU.'" },
  { q: "Which documentary popularized terms like 'shade' and 'reading'?", o: ["Paris Is Burning", "The Queen", "Pose", "Wigstock"], a: 0, ep: "1990 documentary", line: "'Shade is, I don't tell you you're ugly... I don't have to.'" },
  { q: "Who won All Stars 3 after returning in the finale?", o: ["Trixie Mattel", "Kennedy Davenport", "BenDeLaCreme", "Shangela"], a: 0, ep: "All Stars 3 Finale (2018)", line: "The most controversial finale twist in the franchise." },
  { q: "What does a 'merkin' refer to?", o: ["A pubic wig / crotch piece", "A type of heel", "A face powder", "A wig cap"], a: 0, ep: "Drag vocabulary", line: "Yes, it's a real word. Yes, it's exactly what you think." },
  { q: "Which plus-size queen had the meltdown about nuts near her face?", o: ["Latrice Royale", "The Vixen", "Tyra Sanchez", "Mimi Imfurst"], a: 0, ep: "Season 4, the infamous moment", line: "'Get those nuts away from my face!'" },
  { q: "What does it mean for a face to be 'beat'?", o: ["Heavily and skillfully made up", "Tired-looking", "Bare / no makeup", "Sweaty"], a: 0, ep: "Drag vocabulary", line: "Mug beat for the gods, contour for days." },
  { q: "The trilled catchphrase 'Okurrr' is associated with which queen?", o: ["Laganja Estranja", "Adore Delano", "Bianca Del Rio", "Alaska"], a: 0, ep: "Season 6", line: "'Okurrr!' Roll that R like your life depends on it." },
  { q: "Which US season featured Gottmik, the first openly transgender man to compete?", o: ["Season 13", "Season 9", "Season 11", "Season 6"], a: 0, ep: "Season 13 (2021)", line: "A milestone moment for the show's representation." },
  { q: "Peppermint, runner-up of Season 9, was notable as one of the first to do what?", o: ["Compete as an out trans woman from the start", "Win a comedy challenge", "Be a plus-size finalist", "Win Miss Congeniality"], a: 0, ep: "Season 9 (2017)", line: "Living her truth from day one on the main stage." },
  { q: "What is the 'Pit Crew'?", o: ["The shirtless male helpers on set", "The makeup team", "The backstage producers", "The lighting crew"], a: 0, ep: "Series staple", line: "'Gentlemen, start your engines...' and meet the Pit Crew." },
  { q: "Bob the Drag Queen won which season, famous for the 'purse first' walk?", o: ["Season 8", "Season 7", "Season 9", "Season 10"], a: 0, ep: "Season 8 (2016)", line: "'Purse first, walk into the room. Purse FIRST.'" },
  { q: "What does 'camp' refer to as a drag aesthetic?", o: ["Deliberately exaggerated, ironic, theatrical style", "Outdoor-themed looks", "Minimalist elegance", "Pageant glamour"], a: 0, ep: "Drag vocabulary", line: "So bad it's brilliant. Intentionally, lovingly over the top." },
  { q: "Which Season 9 winner is known for narrator energy and a rose-petal reveal?", o: ["Sasha Velour", "Shea Coulee", "Trinity Taylor", "Peppermint"], a: 0, ep: "Season 9 winner", line: "Drag as fine art, bald and beautiful." },
  { q: "What does 'lewk' imply?", o: ["A distinctive, intentional signature look", "A quick glance", "A runway mistake", "A lip sync warmup"], a: 0, ep: "Drag vocabulary", line: "Not just an outfit. A statement. A LEWK." },
  { q: "Who won All Stars 5?", o: ["Shea Coulee", "Miz Cracker", "Jujubee", "Blair St. Clair"], a: 0, ep: "All Stars 5 Finale (2020)", line: "Chicago's finest finally gets her crown." },
  { q: "What does it mean when a look is 'giving fish' or very 'fishy'?", o: ["Looking convincingly feminine", "Smelling bad", "Looking cheap", "Being nervous"], a: 0, ep: "Drag vocabulary", line: "So fishy you could serve her with chips." },
  { q: "Which UK queen, part of the Frock Destroyers, won Series 2?", o: ["Lawrence Chaney", "Bimini Bon-Boulash", "Tayce", "Ellie Diamond"], a: 0, ep: "Drag Race UK S2", line: "Break up a queen? Break up a... you know the rest." },
  { q: "What is the 'lipstick' used for in All Stars elimination twists?", o: ["Writing the name of who goes home", "Touching up before lip sync", "A reward prize", "Marking the runway"], a: 0, ep: "All Stars format", line: "The lip sync winners decide who sashays. Power moves only." },
  { q: "Which term describes artsy, unconventional, gender-bending drag?", o: ["Avant-garde / alternative drag", "Pageant drag", "Comedy drag", "Look drag"], a: 0, ep: "Drag vocabulary", line: "Rules? In THIS economy? Avant-garde says no." },
  { q: "Who is credited with the mantra about loving yourself first?", o: ["RuPaul", "Michelle Visage", "Latrice Royale", "Bianca Del Rio"], a: 0, ep: "Every episode's sign-off", line: "'If you can't love yourself, how in the hell you gonna love somebody else?'" },
  { q: "What is 'Untucked' primarily about?", o: ["Backstage drama between queens", "Runway critiques", "Makeup tutorials", "Lip sync rehearsals"], a: 0, ep: "Companion series", line: "'If you're not watching Untucked, you're only getting half the story.'" },
  { q: "What does 'the children' affectionately refer to?", o: ["Fans / younger queens / the community", "Backup dancers", "Judges", "Production crew"], a: 0, ep: "Drag vocabulary", line: "'The children are GAGGING.' A term of endearment." },
  { q: "Alyssa Edwards is iconic for which signature move?", o: ["The tongue pop", "The death drop", "The duckwalk", "The dip"], a: 0, ep: "Season 5 / All Stars 2", line: "'Get a grip... get a GRIP, girl.' *tongue pop*" },
  { q: "What is a 'reveal' garment designed to do?", o: ["Transform into a second look on stage", "Hide the tuck", "Pad the hips", "Cover the wig line"], a: 0, ep: "Runway technique", line: "One rip and SURPRISE, a whole new fantasy." },
  { q: "Which queen is the only one to win a US season and later an All Stars season?", o: ["Multiple have not; Chad Michaels won AS1 after S4 runner-up", "Alaska won S6 and AS2", "Jinkx won S5 and AS7", "Trixie won S7 and AS3"], a: 3, ep: "Across multiple seasons", line: "The crossover crown is rare and hard-won." },
  { q: "What does 'mugging' or 'beating your mug' mean?", o: ["Doing your makeup", "Robbing someone", "A dance", "Posing for photos"], a: 0, ep: "Drag vocabulary", line: "Beat that mug into next week, gorgeous." },
  { q: "What body-shaping garment cinches the waist?", o: ["A corset / cincher", "A gaff", "A merkin", "A bustle"], a: 0, ep: "Drag vocabulary", line: "Snatched waist, can't breathe, don't care." },
  { q: "'Realness' as a runway category means what?", o: ["Convincingly embodying a specific look", "Telling the truth", "Wearing no makeup", "Being yourself"], a: 0, ep: "Ballroom / runway term", line: "Executive realness. Banjee realness. The fantasy made flesh." },
  { q: "Jinkx Monsoon made history by winning which All Stars season?", o: ["All Stars 7", "All Stars 5", "All Stars 4", "All Stars 6"], a: 0, ep: "All Stars 7 (2022)", line: "The first 'Queen of All Queens.' Staunchest of them all." },
  { q: "What is the youngest a queen has won a regular US season (Jinkx, Season 5)?", o: ["Around 25", "Around 21", "Around 30", "Around 19"], a: 0, ep: "Season 5", line: "Proof that herstory and heart beat youth every time." },
  { q: "Which term means a fierce, exaggerated runway walk borrowed from ballroom?", o: ["Sashay", "Tuck", "Beat", "Cinch"], a: 0, ep: "Ballroom term", line: "'Sashay, shante.' Now werk that runway." },
  { q: "What is 'shade' best described as?", o: ["A clever, subtle, indirect insult", "A makeup contour", "Stage lighting", "A wig color"], a: 0, ep: "Paris Is Burning legacy", line: "'I don't tell you you're ugly. I don't have to, because you know you're ugly.'" },
  { q: "Which queen won Season 8 known for comedy and the Maya Angelou Snatch Game?", o: ["Bob the Drag Queen", "Naomi Smalls", "Kim Chi", "Chi Chi DeVayne"], a: 0, ep: "Season 8, Snatch Game", line: "'And still I rise.' A perfect Maya Angelou." },
];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Memory Match: iconic RPDR emoji/terms to pair ----
const MEMORY_CARDS = [
  { id: "vanjie", face: "\u{1F458}", label: "Miss Vanjie" },
  { id: "rose", face: "\u{1F339}", label: "Rose Reveal" },
  { id: "crown", face: "\u{1F451}", label: "The Crown" },
  { id: "lips", face: "\u{1F48B}", label: "Lip Sync" },
  { id: "fire", face: "\u{1F525}", label: "Sickening" },
  { id: "tea", face: "\u{1F375}", label: "The Tea" },
  { id: "nails", face: "\u{1F485}", label: "Okurrr" },
  { id: "mask", face: "\u{1F3AD}", label: "Valentina's Mask" },
  { id: "tongue", face: "\u{1F445}", label: "Tongue Pop" },
  { id: "books", face: "\u{1F4DA}", label: "The Library" },
];

// ---- Spill the Tea: sort each statement as FACT or SHADE (lie) ----
const TEA_STATEMENTS = [
  { text: "Jinkx Monsoon won All Stars 7, the 'Queen of All Queens' season.", fact: true },
  { text: "RuPaul has never hosted Drag Race; it's always been Michelle Visage.", fact: false },
  { text: "'Sashay away' is what RuPaul says to an eliminated queen.", fact: true },
  { text: "The reading challenge is a tribute to the film Paris Is Burning.", fact: true },
  { text: "Bianca Del Rio is famous as a pageant queen, not a comedy queen.", fact: false },
  { text: "Sasha Velour revealed rose petals under her wig in her finale lip sync.", fact: true },
  { text: "A 'gaff' is a wig used to pad the hips.", fact: false },
  { text: "Valentina refused to remove her mask during a Season 9 lip sync.", fact: true },
  { text: "'Throwing shade' means giving someone a sincere compliment.", fact: false },
  { text: "Bob the Drag Queen won Season 8 with the 'purse first' walk.", fact: true },
  { text: "Alyssa Edwards is best known for inventing the death drop.", fact: false },
  { text: "BeBe Zahara Benet won the very first season of US Drag Race.", fact: true },
  { text: "'Beating your mug' means messing up your makeup badly.", fact: false },
  { text: "The Pit Crew are the shirtless men who assist on set.", fact: true },
  { text: "'Fishy' is an insult meaning a queen looks cheap.", fact: false },
  { text: "Trixie Mattel won All Stars 3 and is a folk singer-songwriter.", fact: true },
];

// ---- Lyric Scramble: super-iconic RuPaul / Drag Race phrases to unscramble ----
// Kept to famous, unambiguous catchphrases so the answer is always recognizable.
const LYRIC_LINES = [
  { line: "if you cant love yourself how in the hell you gonna love somebody else", song: "RuPaul's signature sign-off" },
  { line: "gentlemen start your engines and may the best woman win", song: "RuPaul's challenge opener" },
  { line: "the time has come for you to lip sync for your life", song: "Lip Sync For Your Life" },
  { line: "good luck and dont fuck it up", song: "RuPaul's runway send-off" },
  { line: "shantay you stay", song: "RuPaul's safe verdict" },
  { line: "sashay away", song: "RuPaul's elimination verdict" },
  { line: "now everybody say love", song: "RuPaul's closing line" },
  { line: "the library is open", song: "The Reading Challenge" },
  { line: "reading is fundamental", song: "The Reading Challenge" },
  { line: "we are born naked and the rest is drag", song: "RuPaul's famous quote" },
  { line: "dont be jealous of my boogie", song: "RuPaul, Cover Girl" },
  { line: "you better work", song: "Supermodel, RuPaul" },
  { line: "cover girl put the bass in your walk", song: "Supermodel, RuPaul" },
  { line: "condragulations you are the winner", song: "RuPaul's win announcement" },
  { line: "this is the bottom two", song: "RuPaul, before the lip sync" },
  { line: "two queens stand before me", song: "RuPaul, before the lip sync" },
  { line: "and the time has come", song: "Lip Sync For Your Life" },
  { line: "category is", song: "The runway, RuPaul" },
  { line: "silence i have made my decision", song: "RuPaul, on the main stage" },
  { line: "she done already done had herses", song: "Shangela, fan-favorite ad-lib" },
  { line: "purse first", song: "Bob the Drag Queen" },
  { line: "back rolls", song: "Mystique, Season 2" },
  { line: "miss vanjie", song: "Vanessa Vanjie Mateo's exit" },
  { line: "lip sync for the crown", song: "The grand finale" },
];

// ---- Snatch Game: everyone is assigned a celebrity and writes a quote in
// character. The player types theirs; the AI writes the rivals' quotes and
// judges who was funniest. Big pool for replayability.
const SNATCH_CELEBS = [
  "Marilyn Monroe", "Cher", "Dolly Parton", "Maya Angelou", "Julia Child",
  "Oprah Winfrey", "Joan Rivers", "Lady Gaga", "Britney Spears", "Beyonce",
  "Snooki", "Paris Hilton", "Gordon Ramsay", "David Attenborough", "Bob Ross",
  "Donatella Versace", "Anna Wintour", "Martha Stewart", "RuPaul", "Tan France",
  "Whitney Houston", "Tina Turner", "Madonna", "Lizzo", "Adele",
  "A Kardashian", "Gwyneth Paltrow", "Mariah Carey", "Celine Dion", "Bjork",
  "Nicki Minaj", "Cardi B", "Edna Mode", "Miss Piggy", "Ariana Grande",
  "Keanu Reeves", "Jennifer Coolidge", "Christopher Walken", "Werner Herzog", "Fran Drescher",
];
// Snatch Game prompts (the fill-in RuPaul tosses to the panel)
const SNATCH_PROMPTS = [
  "RuPaul: 'The secret to my success is my ____.'",
  "RuPaul: 'On a first date, I always ____.'",
  "RuPaul: 'My idea of a perfect Saturday night is ____.'",
  "RuPaul: 'The most ridiculous thing in my fridge right now is ____.'",
  "RuPaul: 'My advice to the young queens out there is ____.'",
  "RuPaul: 'I knew I was famous when ____.'",
  "RuPaul: 'My hidden talent is ____.'",
  "RuPaul: 'The last thing I do before bed is ____.'",
  "RuPaul: 'My biggest pet peeve is ____.'",
  "RuPaul: 'If I ran the country, the first law I'd pass is ____.'",
  "RuPaul: 'My autobiography would be titled ____.'",
  "RuPaul: 'The key to a long career in showbiz is ____.'",
];

// ---- Untuck the Drama: read a backstage situation, pick the wisest response ----
// best = the diplomatic, mature, fan-favorite response that keeps the peace.
const UNTUCK_SCENARIOS = [
  {
    setup: "Another queen accuses you of copying her runway look. The room goes quiet.",
    options: ["'Copy YOU? Honey, I've never even looked at you twice.'", "'I hear you, that wasn't my intent. Let's both shine in our own way.'", "Storm out and slam the door."], best: 1,
  },
  {
    setup: "A fellow queen is crying in the corner after harsh critiques.",
    options: ["Ignore her, it's a competition.", "Film it for the drama.", "Sit with her and remind her the judges critique because they see potential."], best: 2,
  },
  {
    setup: "Two queens are screaming at each other and pull you in to take a side.",
    options: ["'I love you both, but I'm not getting in the middle. Let's cool off.'", "Pick the stronger queen's side to stay safe.", "Add fuel and enjoy the show."], best: 0,
  },
  {
    setup: "You overhear queens gossiping about your 'boring' drag.",
    options: ["Confront them aggressively in front of everyone.", "Let your next runway do the talking, and keep it cute.", "Cry and quit."], best: 1,
  },
  {
    setup: "A queen takes credit for a group idea that was actually yours.",
    options: ["'I'd love to clarify, that concept was mine, and I'm proud the team built on it.'", "Say nothing and seethe.", "Scream 'LIAR' across the werk room."], best: 0,
  },
  {
    setup: "The queen you're closest to just got eliminated and looks devastated.",
    options: ["'You changed this competition. This isn't the last we'll see of you.'", "'Well, someone had to go.'", "Avoid her so it's not awkward."], best: 0,
  },
  {
    setup: "A queen keeps interrupting you every time you speak in Untucked.",
    options: ["Talk louder and over her until she stops.", "'I let you finish, I'd appreciate the same. Can I share my piece?'", "Give up and stay silent the whole episode."], best: 1,
  },
  {
    setup: "You win the challenge, and a queen mutters that it was 'rigged.'",
    options: ["'Rigged? Sweetie, that's just called talent. But I hear you're frustrated.'", "Throw your prize in her face.", "Apologize for winning to keep the peace."], best: 0,
  },
  {
    setup: "A younger queen asks you for advice on her makeup, but it's genuinely rough.",
    options: ["Lie and say it's perfect.", "Laugh and tell the others how bad it is.", "Kindly offer a couple of specific tips and a brush or two."], best: 2,
  },
  {
    setup: "Production stirs the pot by telling you a queen 'talked badly' about you.",
    options: ["Believe it instantly and go off on her.", "'I'd rather hear it from her directly than from a producer. Let's not assume.'", "Plot quiet revenge all season."], best: 1,
  },
  {
    setup: "You're in the bottom and your lip sync opponent is shaking with nerves.",
    options: ["'Whatever happens, let's give them a show they'll never forget.'", "Psych her out by trash-talking before the music.", "Refuse to make eye contact and sulk."], best: 0,
  },
  {
    setup: "A queen makes a joke about your weight that crosses a line.",
    options: ["'That one stung, and I don't think you meant it to. Let's keep it kind.'", "Fire back with something even crueler.", "Pretend to laugh while seething inside."], best: 0,
  },
  {
    setup: "The other queens plan to gang up and read one queen mercilessly tonight.",
    options: ["Join in so you're not the odd one out.", "'A read is funny, but four-on-one isn't a read, it's a pile-on. I'll pass.'", "Secretly record it for blackmail."], best: 1,
  },
  {
    setup: "You accidentally ripped another queen's garment backstage.",
    options: ["Hide it and say nothing.", "Blame the Pit Crew.", "Own up immediately, apologize, and offer your sewing kit and help."], best: 2,
  },
  {
    setup: "A queen is spiraling, convinced she's going home, and bringing the room down.",
    options: ["'You don't know that yet. Let's focus on what you CAN control, your runway.'", "Agree that she's probably done for.", "Leave the room to escape the energy."], best: 0,
  },
  {
    setup: "Someone reveals a secret you told them in confidence to the whole cast.",
    options: ["Expose three of HER secrets in retaliation.", "'That was shared in trust. I'm hurt, and I need you to know that.'", "Deny it ever happened and gaslight everyone."], best: 1,
  },
  {
    setup: "A rival compliments you, but it feels backhanded and fake.",
    options: ["'Thank you, I'll take the compliment at face value and keep it pushing.'", "Snap 'I know what you meant by that.'", "Compliment her even more fakely in return."], best: 0,
  },
  {
    setup: "You're exhausted and a castmate asks for help with her look at 3am.",
    options: ["'I'm running on empty, but give me ten minutes and I've got you.'", "'Not my problem, figure it out.'", "Help her badly on purpose so she looks worse than you."], best: 0,
  },
  {
    setup: "A queen breaks down about something personal during a group chat.",
    options: ["Change the subject to yourself.", "Hold space for her and thank her for trusting the room.", "Use it as material for your next read."], best: 1,
  },
  {
    setup: "You realize mid-argument that you were actually in the wrong.",
    options: ["Double down so you don't look weak.", "'You know what, I've thought about it, and you're right. I'm sorry.'", "Storm off before anyone notices."], best: 1,
  },
];

// ---- Runway Realness: a theme is called; pick the most ON-THEME look item ----
// Each round gives a category of 3 options; the on-theme pick scores.
const RUNWAY_THEMES = [
  {
    theme: "Mermaid Gala Eleganza", rounds: [
      { cat: "Silhouette", options: ["A scaled fishtail gown", "A boxy power suit", "Cargo shorts"], best: 0 },
      { cat: "Color Story", options: ["Camo green", "Iridescent teal and pearl", "Black tie black"], best: 1 },
      { cat: "Headpiece", options: ["A trucker cap", "A coral-and-shell crown", "A beanie"], best: 1 },
    ],
  },
  {
    theme: "Old Hollywood Glamour", rounds: [
      { cat: "Gown", options: ["A bias-cut satin gown", "A neon rave bodysuit", "A potato sack"], best: 0 },
      { cat: "Hair", options: ["Messy bun", "Sculpted finger waves", "Liberty spikes"], best: 1 },
      { cat: "Accessory", options: ["A long cigarette holder and pearls", "A fanny pack", "A whistle"], best: 0 },
    ],
  },
  {
    theme: "Club Kid Avant-Garde", rounds: [
      { cat: "Silhouette", options: ["A conservative pantsuit", "A sculptural foam creature look", "A simple sundress"], best: 1 },
      { cat: "Makeup", options: ["Natural no-makeup look", "Alien prosthetics and graphic liner", "Subtle blush"], best: 1 },
      { cat: "Footwear", options: ["Sensible flats", "20-inch platform boots", "House slippers"], best: 1 },
    ],
  },
  {
    theme: "Country Western Couture", rounds: [
      { cat: "Outerwear", options: ["A fringed rhinestone duster", "A scuba wetsuit", "A raincoat"], best: 0 },
      { cat: "Footwear", options: ["Embellished cowboy boots", "Flip flops", "Ice skates"], best: 0 },
      { cat: "Accessory", options: ["A bedazzled bolo tie", "A snorkel", "A briefcase"], best: 0 },
    ],
  },
  {
    theme: "Galaxy Space Queen", rounds: [
      { cat: "Fabric", options: ["Burlap", "Holographic metallic lame", "Flannel"], best: 1 },
      { cat: "Headpiece", options: ["A halo of LED stars", "A sun hat", "A shower cap"], best: 0 },
      { cat: "Color Story", options: ["Beige on beige", "Cosmic purple and silver", "Hunter orange"], best: 1 },
    ],
  },
  {
    theme: "Garden Party Florals", rounds: [
      { cat: "Gown", options: ["A 3D floral applique gown", "A leather biker look", "A trash bag dress"], best: 0 },
      { cat: "Headpiece", options: ["A fresh-bloom flower crown", "A hard hat", "A swim cap"], best: 0 },
      { cat: "Palette", options: ["All black", "Pastel petals and green", "Neon yellow"], best: 1 },
    ],
  },
];

// challenge type registry; chosen at random each week (no back-to-back repeats)
const CHALLENGE_TYPES = ["trivia", "memory", "tea", "scramble", "snatch", "untuck", "runway"];
const CHALLENGE_META = {
  trivia: { name: "RuPaul Trivia", emoji: "\u{1F9E0}", tag: "MAXI CHALLENGE: TRIVIA" },
  memory: { name: "Conjoined Twin Challenge", emoji: "\u{1F46F}", tag: "MAXI CHALLENGE: CONJOINED TWINS" },
  tea: { name: "Spill The Tea", emoji: "\u{1F375}", tag: "MAXI CHALLENGE: FACT OR FICTION" },
  scramble: { name: "Lyric Scramble", emoji: "\u{1F3A4}", tag: "MAXI CHALLENGE: LYRIC SCRAMBLE" },
  snatch: { name: "The Snatch Game", emoji: "\u{1F3AD}", tag: "MAXI CHALLENGE: SNATCH GAME" },
  untuck: { name: "Untuck The Drama", emoji: "\u{1F9F5}", tag: "MAXI CHALLENGE: UNTUCKED" },
  runway: { name: "Runway Realness", emoji: "\u{1F457}", tag: "MAXI CHALLENGE: RUNWAY REALNESS" },
};

const TOTAL_WEEKS = 9;
const QUIZ_LEN = 4;        // questions per maxi challenge
const QUIZ_PASS = 3;       // correct answers needed to be safe

// ---------- AI judge (Claude in Claude) ----------
async function askClaude(prompt) {
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, max_tokens: 1000 }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "AI request failed");
  const text = data.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  // try a straight parse first; if the model wrapped the JSON in any prose,
  // fall back to extracting the first {...} object or [...] array we can find.
  try {
    return JSON.parse(clean);
  } catch (e) {
    const firstObj = clean.indexOf("{");
    const firstArr = clean.indexOf("[");
    let start = -1, open = "{", close = "}";
    if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) { start = firstArr; open = "["; close = "]"; }
    else if (firstObj !== -1) { start = firstObj; }
    if (start === -1) throw e;
    // walk to the matching closing bracket
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < clean.length; i++) {
      const c = clean[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) throw e;
    return JSON.parse(clean.slice(start, end + 1));
  }
}
async function judgeName(name) {
  const prompt = `You are the witty, theatrical head judge of a drag competition. A contestant chose the drag name "${name}". Score it out of 100 for cleverness, pun quality, and drag flair. Be FAIR but slightly GENEROUS: give the benefit of the doubt and lean a few points higher than your gut. A sharp pun or double-entendre scores 85-100, a decent play on words 65-84, something plain or literal still lands around 45-60 rather than failing hard. Only truly effortless or empty names go below 40. Respond ONLY with JSON, no markdown: {"score": <0-100>, "critique": "<one or two theatrical, warm sentences>"}`;
  return askClaude(prompt);
}
// Generate a fresh cast of rival drag queens for a new season. Punny, clever
// drag names, each with a one-line persona. Excludes the player's name.
async function generateCast(count, playerName) {
  // inject randomness so each season's cast feels fresh, not the same defaults
  const flavors = [
    "lean into food and drink puns", "lean into pop-culture and celebrity puns",
    "lean into geography and place-name puns", "lean into science and tech puns",
    "lean into horror and spooky puns", "lean into luxury and fashion-house puns",
    "lean into nature and animal puns", "lean into music and song-title puns",
    "lean into double-entendre innuendo (still tasteful)", "lean into historical and royalty puns",
    "lean into sporty and athletic puns", "lean into nautical and ocean puns",
  ];
  const flavorA = flavors[Math.floor(Math.random() * flavors.length)];
  const flavorB = flavors[Math.floor(Math.random() * flavors.length)];
  const seed = Math.floor(Math.random() * 100000);
  const prompt = `Invent a cast of ${count} ORIGINAL fictional drag queens for a Drag Race style competition (creative seed ${seed}, make this batch distinct from any typical defaults). Each needs a PUNNY, clever, original drag name (wordplay, double meanings, pop-culture twists, alliteration) and a short vivid one-line persona (8-15 words). For extra variety this season, ${flavorA}, and ${flavorB}, while still mixing archetypes: comedy queens, pageant queens, look queens, dancers, weirdos, divas. Surprise me, avoid obvious or overused drag-pun names. Avoid the name "${playerName}". Keep names tasteful and fun, never explicit.

Respond ONLY with JSON, no markdown: [{"name":"<punny drag name>","persona":"<one-line persona>"}, ...] with exactly ${count} unique entries.`;
  const res = await askClaude(prompt);
  const arr = Array.isArray(res) ? res : res.queens || res.cast || [];
  return arr;
}

// Judge the PLAYER's read of a target, given that target's description.
async function judgeLibraryRead(read, target, targetDesc, playerName) {
  const prompt = `You ARE RuPaul, hosting the Reading Challenge in the library. Stay fully in RuPaul's voice: warm but shady, theatrical, full of catchphrases and drag vernacular ("the library is open", "reading is fundamental", "oh she's GOOD", "hunty", "gag", "the shade of it all", "condragulations"). The queen "${playerName}" is reading a fellow queen "${target}", who is known for: "${targetDesc}". ${playerName}'s read is: "${read}".

Score it 0-100 on wit, originality, and how well it plays off ${target}'s quirk. REWARD clever wordplay generously, just like RuPaul does: a sharp PUN, a double-entendre, a callback to her quirk, or a genuine ZINGER scores 80-100. A funny but simple jab is 60-79; flat or mean-without-wit is under 50. React the way RuPaul actually would, gag and howl if it lands, gently tease if it flops, but never genuinely cruel. Respond ONLY with JSON, no markdown: {"score": <0-100>, "critique": "<two sentences in RuPaul's exact voice>"}`;
  return askClaude(prompt);
}

// Generate a fresh set of Spill the Tea statements (mix of true FACTS and false
// SHADE about Drag Race / drag culture). Each tagged with whether it's true.
async function generateTea(count) {
  const seed = Math.floor(Math.random() * 100000);
  const prompt = `Create ${count} statements about RuPaul's Drag Race and drag culture for a "Fact or Fiction" game (creative seed ${seed}, make this batch fresh and varied, mix famous and lesser-known trivia). Roughly half should be genuinely TRUE facts and half should be FALSE (plausible-sounding fiction). Keep each statement to one sentence. Vary the topics: winners, iconic moments, slang, lip syncs, judges, spin-offs, herstory. Make the false ones believable, not obviously wrong.

Respond ONLY with JSON, no markdown: [{"text":"<statement>","fact":<true if genuinely true, false if a lie>}, ...] with exactly ${count} entries, balanced between true and false.`;
  return askClaude(prompt);
}

// Generate a fresh Runway Realness theme with styling rounds. Each round gives a
// category and 3 look options; exactly one is clearly on-theme (the best index).
async function generateRunway() {
  const seed = Math.floor(Math.random() * 100000);
  const prompt = `Invent ONE original, vivid drag runway theme for a Drag Race style "Runway Realness" challenge (creative seed ${seed}, make it fresh and unexpected, not a generic default). Then create 3 styling rounds. Each round is a fashion CATEGORY (e.g. Silhouette, Fabric, Headpiece, Footwear, Color Story, Accessory) with exactly 3 options: ONE that is clearly perfectly on-theme, and TWO that are obviously WRONG for the theme (funny, mismatched, or mundane). Keep options short (3-7 words). 

Respond ONLY with JSON, no markdown: {"theme":"<the runway theme name>","rounds":[{"cat":"<category>","options":["<opt1>","<opt2>","<opt3>"],"best":<index 0-2 of the on-theme option>}, ...] with exactly 3 rounds}`;
  return askClaude(prompt);
}

// Generate fresh Untuck the Drama scenarios. The trick: all 3 options are
// roughly the SAME length and all sound plausible, so length is no longer a
// tell. Only one is genuinely the wise, mature, fan-favorite move.
async function generateUntuck(count) {
  const seed = Math.floor(Math.random() * 100000);
  const prompt = `Create ${count} backstage drama scenarios for a Drag Race "Untucked" challenge (creative seed ${seed}, make them fresh and varied). For each scenario, write 3 response options the contestant could choose.

CRITICAL design rules to make this genuinely challenging:
- All 3 options must be ROUGHLY THE SAME LENGTH (within a few words of each other). Never make the correct answer the longest.
- All 3 must sound PLAUSIBLE at a glance. The two wrong answers should be subtly wrong (passive-aggressive, conflict-avoidant, self-serving, or escalating) rather than cartoonishly bad.
- Exactly ONE is the genuinely wise, emotionally mature, fan-favorite response that de-escalates with grace.
- Randomize which index (0, 1, or 2) is best across the set.

Respond ONLY with JSON, no markdown: [{"setup":"<one-sentence situation>","options":["<opt1>","<opt2>","<opt3>"],"best":<index 0-2>}, ...] with exactly ${count} scenarios.`;
  return askClaude(prompt);
}

// Generate AI reads BETWEEN the rival queens for the leaderboard, each scored.
async function generateRivalReads(lineup) {
  const names = lineup.map((q) => q.name);
  const roster = lineup.map((q) => `${q.name}: ${q.desc}`).join("\n");
  const prompt = `In a drag Reading Challenge, each of these queens reads ONE other queen from the lineup (pick a fun target for each, not themselves). Write each read as a short, clever, playful one-liner (under 25 words) that plays off the target's description, and give each read a wit score 0-100 (vary them: some land at 60, some at 90). Lineup:\n${roster}\n\nRespond ONLY with JSON, no markdown: [{"reader":"<name>","target":"<name>","read":"<the one-liner>","score":<0-100>}, ...] with one entry per queen.`;
  const res = await askClaude(prompt);
  return Array.isArray(res) ? res : res.reads || [];
}

// RuPaul reacts to your Match Game performance with a PUN. Praise if you did
// well, a playful diss if you bombed. RuPaul loves wordplay (drag/memory puns).
async function generateRuPun(playerName, rank, total, didWell) {
  const mood = didWell
    ? `${playerName} just CRUSHED the Conjoined Twin (memory match) challenge, finishing rank ${rank} of ${total}. Praise her with a glowing, punny one-liner.`
    : `${playerName} bombed the Conjoined Twin (memory match) challenge, finishing near the bottom (rank ${rank} of ${total}). Gently DISS her with a playful, punny one-liner.`;
  const prompt = `You are RuPaul reacting to a contestant's performance in a memory-match maxi challenge. ${mood} Use RuPaul's signature wordplay and drag-flavored puns (lean into "match", "memory", "card", "pair", "flip", or drag terms). Keep it to ONE punchy sentence, theatrical and fun, never genuinely mean. Respond ONLY with JSON, no markdown: {"pun": "<one punny sentence>"}`;
  return askClaude(prompt);
}

// An eliminated queen's witty farewell line, generated fresh in her voice.
async function generateFarewell(queenName, persona, week) {
  const seed = Math.floor(Math.random() * 100000);
  const prompt = `You are a drag queen named "${queenName}" who has just been eliminated from a RuPaul's Drag Race style competition in week ${week}. Her persona: "${persona || "a fierce competitor"}". Write ONE witty, funny, RPDR-style farewell line she delivers on her way out (creative seed ${seed}). It can be delusional, gracious, shady, tearful-but-iconic, or meme-worthy, but it must be FUNNY and in her voice, never genuinely bitter or cruel. Keep it to one punchy sentence, first person. Respond ONLY with JSON, no markdown: {"farewell": "<her one-line farewell>"}`;
  return askClaude(prompt);
}

// Snatch Game: the AI writes each rival queen's in-character celebrity quote for
// the given prompt, then judges EVERYONE (including the player) and ranks them.
async function judgeSnatch(prompt, playerName, playerCeleb, playerQuote, rivals) {
  // rivals: [{queen, celeb}]
  const rivalList = rivals.map((r) => `${r.queen} is playing ${r.celeb}`).join("\n");
  const promptText = `It's the Snatch Game (celebrity impersonation comedy). RuPaul's prompt is: "${prompt}". Each queen answers IN CHARACTER as their assigned celebrity, aiming to be the funniest.

The player "${playerName}" is playing ${playerCeleb} and answered: "${playerQuote}"

These rival queens also need answers (write a short, funny, in-character one-liner for each, true to that celebrity's voice and the prompt):
${rivalList}

Now JUDGE all of them (player + rivals) on comedy and how well they captured their celebrity. Give each a funniness score 0-100 (vary them realistically). REWARD genuine wit generously, exactly like the real Snatch Game: a clever PUN, a sharp ZINGER, an unexpected punchline, or a spot-on impression of the celebrity's voice should score high (85-100). A solid-but-safe joke is 60-84. Dock generic, off-character, or low-effort answers below 50. Don't be stingy when someone is actually funny.

Respond ONLY with JSON, no markdown: {"entries":[{"queen":"<name>","celeb":"<celeb>","quote":"<their quote>","score":<0-100>,"isPlayer":<true/false>}, ...], "winner":"<queen name>", "ruReaction":"<RuPaul's one-line punny reaction to the funniest answer>"}. Include the player as one entry with isPlayer true and their exact quote.`;
  return askClaude(promptText);
}

// ---------- shared styles (module scope: built once, not on every render) ----------
const wrap = {
  fontFamily: "'Trebuchet MS','Segoe UI',sans-serif",
  background: "radial-gradient(ellipse at 50% 0%, #4a1840 0%, #260f24 42%, #0c0510 100%)",
  backgroundColor: "#0c0510",
  color: "#f3e9dd", minHeight: "100vh", padding: "20px 16px 60px",
  display: "flex", flexDirection: "column", alignItems: "center", boxSizing: "border-box",
};
const title = {
  fontFamily: "Georgia,'Times New Roman',serif", fontWeight: 900, letterSpacing: "1px", textAlign: "center",
  color: "#f7ecdc",
  textShadow: "0 0 24px rgba(244,221,154,0.35), 0 2px 0 rgba(0,0,0,0.4)",
};
const pill = {
  display: "inline-block", padding: "4px 14px", borderRadius: 999,
  background: "rgba(216,177,90,0.1)", border: "1px solid rgba(216,177,90,0.4)",
  color: "#efe4d4", fontSize: 13, margin: "2px",
};
const btn = {
  background: "linear-gradient(180deg,#f4dd9a,#d8b15a)", color: "#2a1024", border: "none",
  padding: "14px 28px", fontSize: 15, fontWeight: 800, borderRadius: 3, cursor: "pointer",
  boxShadow: "0 6px 22px rgba(216,177,90,0.32)", letterSpacing: "1px", textTransform: "uppercase",
};
const card = {
  background: "rgba(38,15,36,0.7)", border: "1px solid rgba(216,177,90,0.3)",
  borderRadius: 4, padding: 24, maxWidth: 480, width: "100%", textAlign: "center",
  backdropFilter: "blur(8px)",
};

// stable Header component (defined once so React never remounts it)
function Header() {
  return (
    <div style={{ textAlign: "center", marginBottom: 18 }}>
      <div style={{ fontSize: 10.5, letterSpacing: 5, color: "#d8b15a", marginBottom: 6, fontWeight: 600 }}>THE MAIN STAGE PRESENTS</div>
      <h1 style={{ ...title, fontSize: 32, margin: 0 }}>THE WERKROOM</h1>
      <div style={{ fontSize: 12, opacity: 0.75, letterSpacing: 4, color: "#caa6d8" }}>A DRAG RACE SEASON RUN</div>
    </div>
  );
}

// shared end-of-run recap: fun stats + a famous quote + replay nudge.
// `tone` controls the replay copy. Module scope so it isn't rebuilt each render.
const END_REPLAY_LINES = {
  winner: "A fresh cast of sisters is already waiting. Can you go back-to-back and prove this crown was no fluke?",
  runnerup: "The crown slipped away by a hair. Run it back with a brand-new cast and finish the job.",
  eliminated: "Every legend has a comeback story. New season, new queens, new chance to snatch that crown.",
};
function EndStat({ label, value, color }) {
  return (
    <div style={{ flex: "1 1 70px", minWidth: 70, padding: "8px 6px", borderRadius: 10, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(216,177,90,0.2)" }}>
      <div style={{ fontSize: 22, fontWeight: 900, color: color || "#ffd966" }}>{value}</div>
      <div style={{ fontSize: 10.5, opacity: 0.7, letterSpacing: 0.5 }}>{label}</div>
    </div>
  );
}
function EndRecap({ tone, runStats, week, signoff }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 11, opacity: 0.6, letterSpacing: 2, marginBottom: 8 }}>YOUR SEASON IN NUMBERS</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
        <EndStat label="CHALLENGE WINS" value={runStats.wins} color="#ffd966" />
        <EndStat label="HIGH FINISHES" value={runStats.highs} color="#d8b15a" />
        <EndStat label="LIP SYNCS WON" value={runStats.lipsyncWins} color="#4fdc7a" />
        <EndStat label="WEEKS LASTED" value={week} />
      </div>
      {runStats.bestRead > 0 && (
        <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 10, fontStyle: "italic" }}>
          Your sharpest read scored <b style={{ color: "#ffd966" }}>{runStats.bestRead}</b>{runStats.bestReadTarget ? " on " + runStats.bestReadTarget : ""}.
        </div>
      )}
      <div style={{ margin: "14px 0", padding: "12px 14px", borderRadius: 12, background: "rgba(255,217,102,0.08)", border: "1px solid rgba(255,217,102,0.3)" }}>
        <div style={{ fontSize: 14.5, fontStyle: "italic", lineHeight: 1.5, color: "#ffe9b0" }}>"{signoff}"</div>
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>RuPaul</div>
      </div>
      <p style={{ fontSize: 13.5, lineHeight: 1.55, opacity: 0.9 }}>{END_REPLAY_LINES[tone]}</p>
    </div>
  );
}

function DragRaceGame() {
  const [phase, setPhase] = useState("intro");
  const [week, setWeek] = useState(1);
  const [cast, setCast] = useState([]);          // active season's rival queen names (incl. Nadine)
  const [castPersonas, setCastPersonas] = useState({}); // name -> persona line
  const [castLoading, setCastLoading] = useState(false);
  const [queensLeft, setQueensLeft] = useState(QUEENS.length);
  const [challengeType, setChallengeType] = useState("trivia");
  const lastChallengeType = useRef(null); // prevent back-to-back repeats

  // who's still in the running this season (rival names only, player tracked separately)
  const activeRivals = useRef([]); // names of rivals not yet eliminated
  const usedFarewells = useRef(new Set()); // farewell lines used this season (variance)
  const usedAnnounce = useRef(new Set());  // announcement templates used this season

  // elimination beat (shown after a queen goes home)
  const [elim, setElim] = useState(null); // {name, farewell, announce, remaining} or null
  const [elimNext, setElimNext] = useState(null); // what to do after the elim screen: "advance" | "finale"
  const [elimLoading, setElimLoading] = useState(false);

  // quiz state
  const [quiz, setQuiz] = useState([]);       // array of question objects with shuffled options
  const [qIndex, setQIndex] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [picked, setPicked] = useState(null); // index picked for current q
  const [locked, setLocked] = useState(false);

  // memory match state
  const [memCards, setMemCards] = useState([]);   // {uid, id, face, label, flipped, matched}
  const [memFlipped, setMemFlipped] = useState([]); // uids currently face-up (max 2)
  const [memMoves, setMemMoves] = useState(0);
  const [memLock, setMemLock] = useState(false);
  const [memTime, setMemTime] = useState(0);      // seconds elapsed
  const memTimer = useRef(null);
  const [memDone, setMemDone] = useState(false);  // finished the board
  const [memPun, setMemPun] = useState("");       // RuPaul's punny reaction
  const [memRank, setMemRank] = useState(null);   // your rank among all queens
  const [memField, setMemField] = useState([]);   // [{name, time, isYou}] full leaderboard
  const [memBottomTwo, setMemBottomTwo] = useState([]); // names in bottom two
  const [memRouteBottom, setMemRouteBottom] = useState(false); // whether player is in bottom two

  // spill the tea state
  const [teaItems, setTeaItems] = useState([]);   // {text, fact, answered, correct}
  const [teaIndex, setTeaIndex] = useState(0);
  const [teaCorrect, setTeaCorrect] = useState(0);
  const [teaPicked, setTeaPicked] = useState(null); // last pick bool

  // lyric scramble state
  const [scrItems, setScrItems] = useState([]);   // rounds: {words[], song, answer}
  const [scrIndex, setScrIndex] = useState(0);
  const [scrPool, setScrPool] = useState([]);     // shuffled word tiles remaining
  const [scrBuilt, setScrBuilt] = useState([]);   // words placed so far
  const [scrCorrect, setScrCorrect] = useState(0);
  const [scrDone, setScrDone] = useState(false);  // current line locked/checked

  // untuck the drama uses a multiple-choice round shape
  const [mcRounds, setMcRounds] = useState([]);   // [{setup, options[], best, picked}]
  const [mcIndex, setMcIndex] = useState(0);
  const [mcCorrect, setMcCorrect] = useState(0);
  const [mcPicked, setMcPicked] = useState(null);

  // snatch game (write-a-quote) state
  const [snPrompt, setSnPrompt] = useState("");        // RuPaul's fill-in prompt
  const [snPlayerCeleb, setSnPlayerCeleb] = useState(""); // who the player plays
  const [snRivals, setSnRivals] = useState([]);        // [{queen, celeb}]
  const [snQuote, setSnQuote] = useState("");          // player's typed quote
  const [snStage, setSnStage] = useState("write");     // write, judged
  const [snEntries, setSnEntries] = useState([]);      // judged + ranked entries
  const [snWinner, setSnWinner] = useState("");
  const [snRu, setSnRu] = useState("");                // RuPaul's reaction
  const [snLoading, setSnLoading] = useState(false);

  // runway realness loading (AI theme generation)
  const [runwayLoading, setRunwayLoading] = useState(false);
  // spill the tea loading (AI statement generation)
  const [teaLoading, setTeaLoading] = useState(false);
  // untuck the drama loading (AI scenario generation)
  const [untuckLoading, setUntuckLoading] = useState(false);

  // generic challenge result
  const [chScore, setChScore] = useState(0);
  const [chMax, setChMax] = useState(QUIZ_LEN);

  // results
  const [resultPlacement, setResultPlacement] = useState("");
  // run stats for the end screen
  const [runStats, setRunStats] = useState({ wins: 0, highs: 0, safes: 0, bottoms: 0, lipsyncWins: 0, bestRead: 0, bestReadTarget: "", topQuips: [] });
  const [endSignoff, setEndSignoff] = useState(""); // RuPaul quote fixed when the run ends
  const [resultBlurb, setResultBlurb] = useState("");

  // character creation
  const [dragName, setDragName] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [nameScore, setNameScore] = useState(null);
  const [nameCritique, setNameCritique] = useState("");
  const [judging, setJudging] = useState(false);
  const [aiError, setAiError] = useState("");

  // reading (THE LIBRARY)
  const [libStage, setLibStage] = useState("intro"); // intro, reading, scored, leaderboard
  const [lineup, setLineup] = useState([]);          // [{name, desc}]
  const [readTarget, setReadTarget] = useState(null); // selected queen object
  const [readInput, setReadInput] = useState("");
  const [readScore, setReadScore] = useState(null);  // current attempt score
  const [readCritique, setReadCritique] = useState("");
  const [bankedScore, setBankedScore] = useState(null); // last graded score (the one that counts)
  const [bankedTarget, setBankedTarget] = useState(null);
  const [bankedRead, setBankedRead] = useState("");     // the player's banked read text
  const [rivalReads, setRivalReads] = useState([]);  // [{reader,target,read,score}]
  const [libLoading, setLibLoading] = useState(false);
  const [pendingPlacement, setPendingPlacement] = useState(null);

  // lip sync (Top That duel)
  const [lsSong, setLsSong] = useState("");
  const [legSong, setLegSong] = useState(""); // grand finale song
  const [lsOpponent, setLsOpponent] = useState("");
  const [lsResult, setLsResult] = useState(null);
  const [lsRound, setLsRound] = useState(0);        // 0-indexed round
  const [lsYouScore, setLsYouScore] = useState(0);
  const [lsRivalScore, setLsRivalScore] = useState(0);
  const [lsCombo, setLsCombo] = useState(0);         // your consecutive round-wins
  const [lsRivalCombo, setLsRivalCombo] = useState(0); // her consecutive round-wins
  const [lsLog, setLsLog] = useState([]);            // round-by-round recap
  const [lsRoundResult, setLsRoundResult] = useState(null); // {you, rival, vibe, youMove, rivalMove, outcome, showstopper}
  const usedQuestions = useRef(new Set()); // tracks question text used this season

  // FINALE: Lip Sync For The Crown
  const [finalist, setFinalist] = useState("");
  const [legStage, setLegStage] = useState("intro"); // intro, play, round, done
  const [legYou, setLegYou] = useState(0);
  const [legRival, setLegRival] = useState(0);
  const [legStamina, setLegStamina] = useState(100);
  const [legRound, setLegRound] = useState(0);
  const [legLog, setLegLog] = useState([]);
  const [legMomentUsed, setLegMomentUsed] = useState(false);
  const [legRoundResult, setLegRoundResult] = useState(null);
  const [legResult, setLegResult] = useState(null); // {won}

  // clean up the match-game timer if the component unmounts mid-game
  useEffect(() => {
    return () => {
      if (memTimer.current) clearInterval(memTimer.current);
    };
  }, []);

  // ---- builders for each weekly game ----
  const buildQuiz = () => {
    let available = TRIVIA.filter((t) => !usedQuestions.current.has(t.q));
    if (available.length < QUIZ_LEN) {
      usedQuestions.current = new Set();
      available = TRIVIA.slice();
    }
    const drawn = shuffle(available).slice(0, QUIZ_LEN);
    drawn.forEach((t) => usedQuestions.current.add(t.q));
    const qs = drawn.map((item) => {
      const opts = item.o.map((text, i) => ({ text, correct: i === item.a }));
      return { q: item.q, opts: shuffle(opts), ep: item.ep, line: item.line };
    });
    setQuiz(qs); setQIndex(0); setCorrectCount(0); setPicked(null); setLocked(false);
    setChMax(QUIZ_LEN);
  };

  const buildMemory = () => {
    const pick = shuffle(MEMORY_CARDS).slice(0, 6); // 6 pairs = 12 cards
    let uid = 0;
    const cards = shuffle(
      pick.flatMap((c) => [
        { ...c, uid: uid++, flipped: false, matched: false },
        { ...c, uid: uid++, flipped: false, matched: false },
      ])
    );
    setMemCards(cards); setMemFlipped([]); setMemMoves(0); setMemLock(false);
    setMemDone(false); setMemPun(""); setMemRank(null); setMemField([]); setMemBottomTwo([]);
    setMemTime(0);
    if (memTimer.current) clearInterval(memTimer.current);
    memTimer.current = setInterval(() => setMemTime((t) => t + 1), 1000);
    setChMax(6);
  };

  // Called when the player clears the board. Builds the full field (only queens
  // still in the running get a simulated time), ranks the player, finds the
  // bottom two, asks RuPaul for a punny reaction, then routes.
  const completeMemory = async (yourTime, yourMoves) => {
    if (memTimer.current) { clearInterval(memTimer.current); memTimer.current = null; }
    setMemDone(true);
    // only queens still in the competition compete this week
    const pool = activeRivals.current.length ? activeRivals.current : (cast.length ? cast : QUEENS.filter((q) => q !== dragName));
    const rivals = pool.map((name) => {
      let base;
      if (name === STAR_QUEEN) base = 14 + Math.random() * 10;       // 14-24s, strong
      else base = 18 + Math.random() * 34;                            // 18-52s spread
      return { name, time: Math.round(base), isYou: false };
    });
    const field = [...rivals, { name: dragName, time: yourTime, isYou: true }]
      .sort((a, b) => a.time - b.time); // fastest first
    const rank = field.findIndex((f) => f.isYou) + 1;
    const total = field.length;
    const bottomTwo = field.slice(-2).map((f) => f.name);
    const youInBottom = bottomTwo.includes(dragName);

    setMemField(field);
    setMemRank(rank);
    setMemBottomTwo(bottomTwo);

    // RuPaul's pun (top half = praise, bottom half = diss)
    const didWell = rank <= Math.ceil(total / 2);
    try {
      const res = await generateRuPun(dragName, rank, total, didWell);
      setMemPun(res.pun || "");
    } catch (e) {
      setMemPun(didWell
        ? "Condragulations, you really made a MATCH made in heaven!"
        : "Honey, your memory was so short you couldn't pair socks, let alone cards.");
    }
    setMemRouteBottom(youInBottom);
  };

  const buildTeaFromData = (statements) => {
    const items = statements.slice(0, 5).map((t) => ({ text: t.text, fact: !!t.fact, answered: false, correct: false }));
    setTeaItems(items); setTeaIndex(0); setTeaCorrect(0); setTeaPicked(null);
    setChMax(items.length);
  };

  const buildTea = async () => {
    setTeaLoading(true);
    buildTeaFromData(shuffle(TEA_STATEMENTS));
    try {
      const ai = await generateTea(5);
      if (Array.isArray(ai) && ai.length >= 5 &&
          ai.every((s) => s && typeof s.text === "string" && s.text.length > 5 && typeof s.fact === "boolean")) {
        setTeaIndex((idx) => {
          setTeaCorrect((cor) => {
            if (idx === 0 && cor === 0) buildTeaFromData(ai);
            return cor;
          });
          return idx;
        });
      }
    } catch (e) {
      // keep the fallback; game still plays
    } finally {
      setTeaLoading(false);
    }
  };

  const buildScramble = () => {
    const longer = LYRIC_LINES.filter((l) => l.line.split(" ").length >= 4);
    const pool = longer.length >= 3 ? longer : LYRIC_LINES;
    const rounds = shuffle(pool).slice(0, 3).map((l) => {
      const words = l.line.split(" ");
      return { answer: words, song: l.song };
    });
    setScrItems(rounds); setScrIndex(0); setScrCorrect(0); setScrDone(false);
    const first = rounds[0];
    setScrPool(shuffle(first.answer.map((w, i) => ({ w, key: i }))));
    setScrBuilt([]);
    setChMax(3);
  };

  const buildSnatch = () => {
    const celebs = shuffle(SNATCH_CELEBS);
    const prompt = SNATCH_PROMPTS[Math.floor(Math.random() * SNATCH_PROMPTS.length)];
    const rivalPool = shuffle(activeRivals.current.length ? activeRivals.current : (cast.length ? cast : QUEENS.filter((q) => q !== dragName))).slice(0, 3);
    const rivals = rivalPool.map((queen, i) => ({ queen, celeb: celebs[i + 1] }));
    setSnPrompt(prompt);
    setSnPlayerCeleb(celebs[0]);
    setSnRivals(rivals);
    setSnQuote(""); setSnStage("write"); setSnEntries([]); setSnWinner(""); setSnRu("");
    setChMax(1);
  };

  const submitSnatch = async () => {
    if (!snQuote.trim() || snLoading) return;
    setSnLoading(true); setAiError("");
    try {
      const res = await judgeSnatch(snPrompt, dragName, snPlayerCeleb, snQuote.trim(), snRivals);
      let entries = (res.entries || []).slice().sort((a, b) => b.score - a.score);
      if (!entries.some((e) => e.isPlayer)) {
        entries.push({ queen: dragName, celeb: snPlayerCeleb, quote: snQuote.trim(), score: 50, isPlayer: true });
        entries.sort((a, b) => b.score - a.score);
      }
      setSnEntries(entries);
      setSnWinner(res.winner || entries[0].queen);
      setSnRu(res.ruReaction || "");
      setSnStage("judged");
    } catch (e) {
      setAiError("The Snatch Game judges are catching their breath. Try submitting again.");
    } finally { setSnLoading(false); }
  };

  const finishSnatch = () => {
    const idx = snEntries.findIndex((e) => e.isPlayer);
    const total = snEntries.length || 1;
    const rank = idx === -1 ? Math.ceil(total / 2) : idx + 1;
    let score;
    if (rank === 1) score = total;
    else if (rank <= Math.ceil(total / 3)) score = Math.ceil(total * 0.8);
    else if (rank <= Math.ceil((total * 2) / 3)) score = Math.ceil(total * 0.6);
    else score = 0;
    finishWeeklyChallenge(score, total);
  };

  const buildUntuckFromData = (scenarios) => {
    const rounds = scenarios.slice(0, 4).map((r) => {
      const opts = r.options.map((text, i) => ({ text, best: i === r.best }));
      return { setup: r.setup, opts: shuffle(opts), picked: null };
    });
    setMcRounds(rounds); setMcIndex(0); setMcCorrect(0); setMcPicked(null);
    setChMax(rounds.length);
  };

  const buildUntuck = async () => {
    setUntuckLoading(true);
    buildUntuckFromData(shuffle(UNTUCK_SCENARIOS).slice(0, 4));
    try {
      const ai = await generateUntuck(4);
      if (Array.isArray(ai) && ai.length >= 4 &&
          ai.every((s) => s && typeof s.setup === "string" && Array.isArray(s.options) && s.options.length === 3 && s.best >= 0 && s.best < 3)) {
        setMcIndex((idx) => {
          setMcCorrect((cor) => {
            if (idx === 0 && cor === 0) buildUntuckFromData(ai);
            return cor;
          });
          return idx;
        });
      }
    } catch (e) {
      // keep the fallback; game still plays
    } finally {
      setUntuckLoading(false);
    }
  };

  const buildRunwayFromData = (theme) => {
    const rounds = theme.rounds.map((r) => {
      const opts = r.options.map((text, i) => ({ text, best: i === r.best }));
      return { setup: r.cat, theme: theme.theme, opts: shuffle(opts), picked: null };
    });
    setMcRounds(rounds); setMcIndex(0); setMcCorrect(0); setMcPicked(null);
    setChMax(rounds.length);
  };

  const buildRunway = async () => {
    setRunwayLoading(true);
    const fallback = RUNWAY_THEMES[Math.floor(Math.random() * RUNWAY_THEMES.length)];
    buildRunwayFromData(fallback);
    try {
      const ai = await generateRunway();
      if (ai && ai.theme && Array.isArray(ai.rounds) && ai.rounds.length >= 2 &&
          ai.rounds.every((r) => Array.isArray(r.options) && r.options.length === 3 && r.best >= 0 && r.best < 3)) {
        setMcIndex((idx) => {
          setMcCorrect((cor) => {
            if (idx === 0 && cor === 0) buildRunwayFromData({ theme: ai.theme, rounds: ai.rounds.slice(0, 4) });
            return cor;
          });
          return idx;
        });
      }
    } catch (e) {
      // keep the fallback theme; no error shown, the game still plays
    } finally {
      setRunwayLoading(false);
    }
  };

  const pickChallengeType = () => {
    let options = CHALLENGE_TYPES.filter((t) => t !== lastChallengeType.current);
    const t = options[Math.floor(Math.random() * options.length)];
    lastChallengeType.current = t;
    return t;
  };

  const startChallenge = () => {
    const t = pickChallengeType();
    setChallengeType(t);
    if (t === "trivia") buildQuiz();
    else if (t === "memory") buildMemory();
    else if (t === "tea") buildTea();
    else if (t === "scramble") buildScramble();
    else if (t === "snatch") buildSnatch();
    else if (t === "untuck") buildUntuck();
    else if (t === "runway") buildRunway();
    setPhase("challenge");
  };

  const beginSeason = () => {
    usedQuestions.current = new Set();
    usedFarewells.current = new Set();
    usedAnnounce.current = new Set();
    lastChallengeType.current = null;
    // everyone who isn't the player starts the season in the running
    activeRivals.current = (cast.length ? cast.slice() : QUEENS.filter((q) => q !== dragName));
    setWeek(1);
    setQueensLeft(cast.length || QUEENS.length);
    setRunStats({ wins: 0, highs: 0, safes: 0, bottoms: 0, lipsyncWins: 0, bestRead: 0, bestReadTarget: "", topQuips: [] });
    startChallenge();
  };

  // After the name is approved, generate a fresh rival cast (Nadine always in).
  const generateSeasonCast = async () => {
    setCastLoading(true); setAiError("");
    try {
      const aiCast = await generateCast(11, dragName); // 11 + Nadine = 12 rivals
      const personas = {};
      const names = [];
      for (const q of aiCast) {
        if (!q || !q.name) continue;
        const nm = String(q.name).trim();
        if (!nm || nm === dragName || nm === STAR_QUEEN || names.includes(nm)) continue;
        names.push(nm);
        personas[nm] = q.persona || "a queen of mystery";
      }
      for (const fallback of QUEENS) {
        if (names.length >= 11) break;
        if (fallback !== dragName && fallback !== STAR_QUEEN && !names.includes(fallback)) {
          names.push(fallback);
          personas[fallback] = "a seasoned competitor with tricks up her sleeve";
        }
      }
      personas[STAR_QUEEN] = STAR_QUEEN_DESC;
      const finalCast = [...names, STAR_QUEEN];
      setCast(finalCast);
      setCastPersonas(personas);
      setPhase("meetCast");
    } catch (e) {
      setAiError("The other queens are still getting into drag. Tap to try again.");
    } finally { setCastLoading(false); }
  };

  // ---- trivia interactions ----
  const answerQuestion = (optIndex) => {
    if (locked) return;
    setPicked(optIndex);
    setLocked(true);
    if (quiz[qIndex].opts[optIndex].correct) setCorrectCount((c) => c + 1);
  };
  const nextQuestion = () => {
    if (qIndex + 1 < quiz.length) {
      setQIndex((i) => i + 1); setPicked(null); setLocked(false);
    } else {
      finishWeeklyChallenge(correctCount, QUIZ_LEN);
    }
  };

  // ---- memory match interactions ----
  const flipCard = (uid) => {
    if (memLock) return;
    const card = memCards.find((c) => c.uid === uid);
    if (!card || card.flipped || card.matched) return;
    const nowFlipped = [...memFlipped, uid];
    setMemCards((cs) => cs.map((c) => (c.uid === uid ? { ...c, flipped: true } : c)));
    setMemFlipped(nowFlipped);
    if (nowFlipped.length === 2) {
      const moveCount = memMoves + 1;
      setMemMoves(moveCount);
      setMemLock(true);
      const [a, b] = nowFlipped.map((u) => memCards.find((c) => c.uid === u));
      const isMatch = a.id === b.id;
      const pairsBefore = memCards.filter((c) => c.matched).length / 2;
      const willWin = isMatch && pairsBefore + 1 >= 6;
      setTimeout(() => {
        setMemCards((cs) => cs.map((c) => {
          if (c.uid === a.uid || c.uid === b.uid) {
            return isMatch ? { ...c, matched: true } : { ...c, flipped: false };
          }
          return c;
        }));
        setMemFlipped([]);
        setMemLock(false);
        if (willWin) {
          setMemTime((finalTime) => {
            setPhase("memResult");
            completeMemory(finalTime, moveCount);
            return finalTime;
          });
        }
      }, 800);
    }
  };

  // ---- spill the tea interactions ----
  const answerTea = (saysFact) => {
    if (teaItems[teaIndex].answered) return;
    const correct = teaItems[teaIndex].fact === saysFact;
    setTeaPicked(saysFact);
    setTeaItems((items) => items.map((t, i) => (i === teaIndex ? { ...t, answered: true, correct } : t)));
    if (correct) setTeaCorrect((c) => c + 1);
  };
  const nextTea = () => {
    if (teaIndex + 1 < teaItems.length) {
      setTeaIndex((i) => i + 1); setTeaPicked(null);
    } else {
      finishWeeklyChallenge(teaCorrect, teaItems.length);
    }
  };

  // ---- lyric scramble interactions ----
  const placeWord = (tile) => {
    if (scrDone) return;
    setScrBuilt((b) => [...b, tile]);
    setScrPool((p) => p.filter((t) => t.key !== tile.key));
  };
  const unplaceWord = (tile) => {
    if (scrDone) return;
    setScrBuilt((b) => b.filter((t) => t.key !== tile.key));
    setScrPool((p) => [...p, tile]);
  };
  const checkScramble = () => {
    const round = scrItems[scrIndex];
    const built = scrBuilt.map((t) => t.w);
    const ok = built.length === round.answer.length && built.every((w, i) => w === round.answer[i]);
    if (ok) setScrCorrect((c) => c + 1);
    setScrDone(true);
    setScrItems((items) => items.map((it, i) => (i === scrIndex ? { ...it, gotIt: ok } : it)));
  };
  const nextScramble = () => {
    if (scrIndex + 1 < scrItems.length) {
      const ni = scrIndex + 1;
      setScrIndex(ni);
      setScrPool(shuffle(scrItems[ni].answer.map((w, i) => ({ w, key: i }))));
      setScrBuilt([]);
      setScrDone(false);
    } else {
      finishWeeklyChallenge(scrCorrect, scrItems.length);
    }
  };

  // ---- snatch game / untuck the drama (shared MC) interactions ----
  const answerMC = (optIndex) => {
    if (mcRounds[mcIndex].picked !== null) return;
    const isBest = mcRounds[mcIndex].opts[optIndex].best;
    setMcPicked(optIndex);
    setMcRounds((rs) => rs.map((r, i) => (i === mcIndex ? { ...r, picked: optIndex } : r)));
    if (isBest) setMcCorrect((c) => c + 1);
  };
  const nextMC = () => {
    if (mcIndex + 1 < mcRounds.length) {
      setMcIndex((i) => i + 1); setMcPicked(null);
    } else {
      finishWeeklyChallenge(mcCorrect, mcRounds.length);
    }
  };

  // ---- generic finisher: maps any game's (score/max) to a placement ----
  const finishWeeklyChallenge = (score, max) => {
    setChScore(score); setChMax(max);
    const pct = score / max;
    let placement, blurb;
    if (pct >= 0.99) {
      placement = "WIN";
      blurb = "Flawless! You ran away with this challenge. Condragulations, you are this week's winner.";
    } else if (pct >= 0.74) {
      placement = "HIGH";
      blurb = "Sharp work. The judges are impressed. You are safe and near the top.";
    } else if (pct >= 0.5) {
      placement = "SAFE";
      blurb = "A few wobbles, but you held your own. You live to slay another day. Safe.";
    } else {
      placement = "BOTTOM";
      blurb = "Ouch, that missed the mark. You're up for elimination. Time to lip sync for your life.";
    }
    if (week % 2 === 1) {
      setLibStage("intro");
      setLineup([]); setRivalReads([]);
      setReadTarget(null); setReadInput(""); setReadScore(null); setReadCritique("");
      setBankedScore(null); setBankedTarget(null); setBankedRead("");
      setPendingPlacement(placement);
      setPhase("reading");
      return;
    }
    setResultPlacement(placement);
    setResultBlurb(blurb);
    recordPlacement(placement);
    setPhase("results");
  };

  const applyReadBonus = (rScore) => {
    const order = ["BOTTOM", "SAFE", "HIGH", "WIN"];
    let placement = pendingPlacement;
    if (rScore >= 80) {
      const i = order.indexOf(placement);
      if (i < order.length - 1) placement = order[i + 1];
    }
    const blurbs = {
      WIN: "Flawless quiz AND a read that brought down the house. You win this week, hands down.",
      HIGH: "Smart on the panel and sharp in the library. The judges are charmed. You're safe up top.",
      SAFE: "Solid all around. Not the best week, but you sail through. Safe.",
      BOTTOM: "The library couldn't save you this time. You're in the bottom. Lip sync for your life.",
    };
    setResultPlacement(placement);
    setResultBlurb(blurbs[placement]);
    recordPlacement(placement);
    setPhase("results");
  };

  const recordPlacement = (placement) => {
    setRunStats((s) => {
      const next = { ...s };
      if (placement === "WIN") next.wins++;
      else if (placement === "HIGH") next.highs++;
      else if (placement === "SAFE") next.safes++;
      else if (placement === "BOTTOM") next.bottoms++;
      return next;
    });
  };

  const startSurvivalLipSync = (opponent) => {
    setLsSong(LIPSYNC_SONGS[Math.floor(Math.random() * LIPSYNC_SONGS.length)]);
    const pool = activeRivals.current.length ? activeRivals.current : (cast.length ? cast : QUEENS.filter((q) => q !== dragName));
    setLsOpponent(opponent || pool[Math.floor(Math.random() * pool.length)]);
    setLsResult(null); setLsRound(0); setLsYouScore(0); setLsRivalScore(0);
    setLsCombo(0); setLsRivalCombo(0); setLsLog([]); setLsRoundResult(null);
    setPhase("lipsync");
  };

  // ---- ELIMINATION BEAT ----
  // Remove the eliminated queen from the running, pick a witty farewell (AI with
  // a big static fallback), build the "who left / how many remain" line, and show
  // the elimination screen. `after` says where to go when the player taps continue.
  const eliminateQueen = async (name, after) => {
    // pull her from the active rivals list
    activeRivals.current = activeRivals.current.filter((n) => n !== name);
    const remaining = activeRivals.current.length + 1; // +1 for the player still in
    setQueensLeft(remaining);

    // pick a fresh announcement template (avoid repeats within the season)
    let announceTpl;
    const freshAnn = ELIM_ANNOUNCEMENTS.filter((t) => !usedAnnounce.current.has(t));
    if (freshAnn.length === 0) { usedAnnounce.current = new Set(); announceTpl = ELIM_ANNOUNCEMENTS[Math.floor(Math.random() * ELIM_ANNOUNCEMENTS.length)]; }
    else announceTpl = freshAnn[Math.floor(Math.random() * freshAnn.length)];
    usedAnnounce.current.add(announceTpl);
    const plural = remaining === 1 ? "queen" : "queens";
    const announce = announceTpl.replace("{q}", name).replace("{n}", remaining).replace("{plural}", plural);

    // pick a fresh static farewell as instant fallback
    let fallbackLine;
    const freshFw = FAREWELL_LINES.filter((l) => !usedFarewells.current.has(l));
    if (freshFw.length === 0) { usedFarewells.current = new Set(); fallbackLine = FAREWELL_LINES[Math.floor(Math.random() * FAREWELL_LINES.length)]; }
    else fallbackLine = freshFw[Math.floor(Math.random() * freshFw.length)];
    usedFarewells.current.add(fallbackLine);

    // show the screen immediately with the fallback, then upgrade via AI
    setElim({ name, farewell: fallbackLine, announce, remaining });
    setElimNext(after);
    setPhase("elimination");

    // try to get a fresher AI farewell in that queen's voice
    setElimLoading(true);
    try {
      const persona = castPersonas[name] || (name === STAR_QUEEN ? STAR_QUEEN_DESC : "a fierce competitor");
      const res = await generateFarewell(name, persona, week);
      if (res && res.farewell && typeof res.farewell === "string" && res.farewell.trim().length > 4) {
        setElim((e) => (e && e.name === name ? { ...e, farewell: res.farewell.trim() } : e));
      }
    } catch (err) {
      // keep the static fallback, no problem
    } finally {
      setElimLoading(false);
    }
  };

  // pick which rival sashays when the PLAYER survives a weekly lip sync or is safe.
  // Prefer the player's lip sync opponent if one was set; else the bottom-two
  // queen who isn't the player; else a random remaining rival.
  const pickEliminee = (preferred) => {
    if (preferred && preferred !== dragName && activeRivals.current.includes(preferred)) return preferred;
    const others = activeRivals.current.filter((n) => n !== STAR_QUEEN);
    // the star queen is hard to knock out early; she rarely goes pre-finale
    if (others.length) return others[Math.floor(Math.random() * others.length)];
    return activeRivals.current[Math.floor(Math.random() * activeRivals.current.length)];
  };

  const proceedFromResults = () => {
    if (resultPlacement === "BOTTOM") {
      startSurvivalLipSync();
    } else {
      // player is safe: a rival goes home this week
      const goner = pickEliminee(null);
      eliminateQueen(goner, "advance");
    }
  };

  // Match Game routing: bottom two lip sync, otherwise player safe and a rival goes.
  const continueFromMemory = () => {
    if (memRouteBottom) {
      const opponent = memBottomTwo.find((n) => n !== dragName);
      startSurvivalLipSync(opponent);
    } else {
      // safe: the slower of the bottom two sashays
      const goner = pickEliminee(memBottomTwo.find((n) => n !== dragName));
      eliminateQueen(goner, "advance");
    }
  };

  // after the elimination screen, continue the season (or roll into the finale)
  const continueFromElim = () => {
    setElim(null);
    if (elimNext === "finale") {
      goToFinale();
    } else {
      advanceWeek();
    }
  };

  // set up and enter the grand finale
  const goToFinale = () => {
    const pickFinalist = () => {
      const pool = activeRivals.current.length ? activeRivals.current : (cast.length ? cast : QUEENS.filter((q) => q !== dragName));
      if (pool.includes(STAR_QUEEN) && Math.random() < 0.45) return STAR_QUEEN;
      return pool[Math.floor(Math.random() * pool.length)];
    };
    const fin = pickFinalist();
    // lock the finale to exactly the two of you: everyone else is already out
    activeRivals.current = [fin];
    setQueensLeft(2);
    setFinalist(fin);
    setLegSong(LEGACY_SONGS[Math.floor(Math.random() * LEGACY_SONGS.length)]);
    setLegStage("intro");
    setLegYou(0); setLegRival(0); setLegStamina(100); setLegRound(0);
    setLegLog([]); setLegMomentUsed(false); setLegRoundResult(null);
    setPhase("legacy");
  };

  const advanceWeek = () => {
    const remaining = queensLeft; // already decremented during elimination
    if (remaining <= 2 || week >= TOTAL_WEEKS) {
      goToFinale();
    } else {
      const next = week + 1;
      setWeek(next);
      startChallenge();
    }
  };

  // ---- character creation ----
  const submitName = async () => {
    if (!nameInput.trim() || judging) return;
    setJudging(true); setAiError("");
    try {
      const res = await judgeName(nameInput.trim());
      setDragName(nameInput.trim());
      setNameScore(res.score); setNameCritique(res.critique);
    } catch (e) {
      setAiError("The judges are still beating their mugs. Try submitting again.");
    } finally { setJudging(false); }
  };

  // ---- THE LIBRARY ----
  const openLibrary = async () => {
    setLibLoading(true); setAiError("");
    try {
      const rivalPool = (activeRivals.current.length ? activeRivals.current : (cast.length ? cast : QUEENS.filter((q) => q !== dragName)));
      const others = shuffle(rivalPool.filter((q) => q !== STAR_QUEEN)).slice(0, 3);
      const poolNames = rivalPool.includes(STAR_QUEEN) ? [STAR_QUEEN, ...others] : others.slice(0, 4);
      const pool = shuffle(poolNames);
      const built = pool.map((name) => {
        if (name === STAR_QUEEN) return { name, desc: STAR_QUEEN_DESC, star: true };
        return { name, desc: castPersonas[name] || "a mysterious queen keeping her cards close" };
      });
      setLineup(built);
      setLibStage("reading");
    } catch (e) {
      setAiError("The library doors are jammed. Tap to try opening again.");
    } finally { setLibLoading(false); }
  };

  const submitLibraryRead = async () => {
    if (!readInput.trim() || !readTarget || judging) return;
    setJudging(true); setAiError("");
    try {
      const res = await judgeLibraryRead(readInput.trim(), readTarget.name, readTarget.desc, dragName);
      setReadScore(res.score); setReadCritique(res.critique);
      setBankedScore(res.score);
      setBankedTarget(readTarget.name);
      setBankedRead(readInput.trim());
      setRunStats((s) => res.score > s.bestRead ? { ...s, bestRead: res.score, bestReadTarget: readTarget.name } : s);
      setLibStage("scored");
    } catch (e) {
      setAiError("The judge stepped out for a sip of tea. Try your read again.");
    } finally { setJudging(false); }
  };

  const readAgain = () => {
    setReadInput(""); setReadScore(null); setReadCritique(""); setReadTarget(null);
    setLibStage("reading");
  };

  const finishLibrary = async () => {
    setLibLoading(true); setAiError("");
    try {
      const reads = await generateRivalReads(lineup);
      setRivalReads(reads);
      setLibStage("leaderboard");
    } catch (e) {
      setRivalReads([]);
      setLibStage("leaderboard");
    } finally { setLibLoading(false); }
  };

  // ---- lip sync "Top That" duel ----
  const LS_TOTAL_ROUNDS = 6;

  const vibeForRound = (r) => {
    if (r === LS_TOTAL_ROUNDS - 1) return VIBES[3]; // always end on BIG FINISH
    const seq = ["hype", "emo", "sexy", "hype", "climax"];
    const key = seq[r % seq.length];
    return VIBES.find((v) => v.key === key);
  };

  const scoreMove = (move, vibe) => {
    if (!move) return 0;
    if (move.fav === vibe.key) return move.base + 4;
    return Math.max(1, move.base - move.risk - 1);
  };

  const rivalPick = (vibe, rivalCombo) => {
    const isStar = lsOpponent === STAR_QUEEN;
    const readChance = isStar ? 0.9 : Math.min(0.85, 0.6 + week * 0.03);
    const onVibe = LS_MOVES.filter((m) => m.fav === vibe.key);
    if (Math.random() < readChance && onVibe.length) {
      return onVibe.sort((a, b) => b.base - a.base)[0];
    }
    const pool = LS_MOVES.filter((m) => m.fav !== vibe.key);
    return pool[Math.floor(Math.random() * pool.length)] || onVibe[0];
  };

  const playMove = (move) => {
    const vibe = vibeForRound(lsRound);
    const rMove = rivalPick(vibe, lsRivalCombo);
    let youPts = scoreMove(move, vibe);
    let rivalPts = scoreMove(rMove, vibe);

    const youOnVibe = move.fav === vibe.key;
    const rivalOnVibe = rMove.fav === vibe.key;

    const youWonRound = youPts > rivalPts;
    const rivalWonRound = rivalPts > youPts;

    let showstopper = false;
    let rivalShowstopper = false;
    let newCombo = lsCombo;
    let newRivalCombo = lsRivalCombo;

    if (youWonRound) {
      newCombo = lsCombo + 1;
      newRivalCombo = 0;
      if (newCombo >= 2 && youOnVibe) { showstopper = true; youPts = youPts * 2; }
    } else if (rivalWonRound) {
      newRivalCombo = lsRivalCombo + 1;
      newCombo = 0;
      if (newRivalCombo >= 2 && rivalOnVibe) { rivalShowstopper = true; rivalPts = rivalPts * 2; }
    }
    const finalYouWon = youPts > rivalPts;
    const finalRivalWon = rivalPts > youPts;
    const finalTie = youPts === rivalPts;

    const newYou = lsYouScore + youPts;
    const newRival = lsRivalScore + rivalPts;

    const outcome = finalTie ? "tie" : finalYouWon ? "you" : "rival";
    const entry = {
      round: lsRound + 1, vibe, youMove: move, rivalMove: rMove,
      youPts, rivalPts, outcome, showstopper, rivalShowstopper, youOnVibe,
    };

    setLsYouScore(newYou);
    setLsRivalScore(newRival);
    setLsCombo(newCombo);
    setLsRivalCombo(newRivalCombo);
    setLsLog((l) => [...l, entry]);
    setLsRoundResult(entry);

    if (lsRound + 1 >= LS_TOTAL_ROUNDS) {
      entry.final = { won: newYou >= newRival, you: newYou, rival: newRival };
    }
  };

  const nextRound = () => {
    if (lsRoundResult && lsRoundResult.final) {
      setLsResult(lsRoundResult.final);
      setPhase("lipsyncResult");
      return;
    }
    setLsRound((r) => r + 1);
    setLsRoundResult(null);
  };

  // after a survival lip sync: win = opponent goes home (with elim beat), lose = you're out
  const afterLipSync = () => {
    if (lsResult && lsResult.won) {
      setRunStats((s) => ({ ...s, lipsyncWins: s.lipsyncWins + 1 }));
      // the queen you beat sashays away
      const goner = pickEliminee(lsOpponent);
      eliminateQueen(goner, "advance");
    } else {
      setEndSignoff(RU_SIGNOFFS[Math.floor(Math.random() * RU_SIGNOFFS.length)]);
      setPhase("eliminated");
    }
  };

  // ---- FINALE: Lip Sync For The Crown ----
  const LEG_ROUNDS = 5;

  const legPlay = (choice) => {
    let youGain = 0, stamCost = 0, note = "";
    const stam = legStamina;

    if (choice === "hold") {
      youGain = 6 + Math.floor(Math.random() * 3);
      stamCost = -18;
      note = "You pace yourself, saving energy for the big moments.";
    } else if (choice === "allout") {
      if (stam >= 30) { youGain = 16 + Math.floor(Math.random() * 5); note = "You GO for it. Death drops, splits, the works. The crowd erupts!"; }
      else { youGain = 5 + Math.floor(Math.random() * 3); note = "You push hard but you're gassed. The energy just isn't there."; }
      stamCost = 30;
    } else if (choice === "moment") {
      if (stam >= 25) { youGain = 26 + Math.floor(Math.random() * 6); note = "YOUR CROWNING MOMENT. A jaw-dropping reveal that brings the house DOWN."; }
      else { youGain = 10 + Math.floor(Math.random() * 4); note = "You reach for greatness but you're running on empty. Still, a brave swing."; }
      stamCost = 25;
      setLegMomentUsed(true);
    }

    const newStam = Math.max(0, Math.min(100, stam - stamCost));

    let rivalGain;
    const isLast = legRound + 1 >= LEG_ROUNDS;
    const starBonus = finalist === STAR_QUEEN ? 1 : 0;
    if (isLast) rivalGain = 22 + starBonus + Math.floor(Math.random() * 8);
    else rivalGain = 12 + starBonus + Math.floor(Math.random() * 7);

    const newYou = legYou + youGain;
    const newRival = legRival + rivalGain;
    const entry = { round: legRound + 1, choice, youGain, rivalGain, note, stam: newStam };

    setLegYou(newYou);
    setLegRival(newRival);
    setLegStamina(newStam);
    setLegLog((l) => [...l, entry]);
    setLegRoundResult(entry);

    if (isLast) entry.final = { won: newYou >= newRival, you: newYou, rival: newRival };
  };

  const legNext = () => {
    if (legRoundResult && legRoundResult.final) {
      setLegResult(legRoundResult.final);
      setLegStage("done");
      return;
    }
    setLegRound((r) => r + 1);
    setLegRoundResult(null);
  };

  const afterLegacy = () => {
    setEndSignoff(RU_SIGNOFFS[Math.floor(Math.random() * RU_SIGNOFFS.length)]);
    if (legResult && legResult.won) setPhase("winner");
    else setPhase("runnerup");
  };

  // ---------- screens ----------

  if (phase === "intro") {
    const introWrap = {
      fontFamily: "'Trebuchet MS','Segoe UI',sans-serif",
      minHeight: "100vh", boxSizing: "border-box",
      padding: "0 18px 50px",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: "radial-gradient(ellipse at 50% 0%, #4a1840 0%, #260f24 40%, #0c0510 100%)",
      backgroundColor: "#0c0510",
      color: "#f3e9dd",
      position: "relative", overflow: "hidden",
    };
    const goldRule = {
      height: 1, width: "100%", maxWidth: 360,
      background: "linear-gradient(90deg, transparent, #d8b15a 18%, #f4dd9a 50%, #d8b15a 82%, transparent)",
      margin: "0 auto",
    };
    const ruPun = (text) => (
      <div style={{ fontSize: 14.5, lineHeight: 1.65, color: "#e9dcc8", opacity: 0.9, fontStyle: "italic", letterSpacing: 0.2 }}>{text}</div>
    );
    return (
      <div style={introWrap}>
        <div style={{ position: "absolute", top: "8%", left: "50%", transform: "translateX(-50%)", width: 420, height: 420, borderRadius: "50%", background: "radial-gradient(circle, rgba(216,177,90,0.18), transparent 65%)", pointerEvents: "none" }} />

        <div style={{ position: "relative", width: "100%", maxWidth: 480, textAlign: "center", zIndex: 1 }}>
          <div style={{ fontSize: 11.5, letterSpacing: 7, color: "#d8b15a", marginBottom: 18, fontWeight: 600 }}>
            THE MAIN STAGE PRESENTS
          </div>

          <div style={goldRule} />
          <h1 style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontWeight: 900, margin: "16px 0 8px", lineHeight: 0.95,
            fontSize: 52, letterSpacing: 1,
            color: "#f7ecdc",
            textShadow: "0 0 24px rgba(244,221,154,0.35), 0 2px 0 rgba(0,0,0,0.4)",
          }}>
            THE<br />WERKROOM
          </h1>
          <div style={{ fontSize: 12, letterSpacing: 6, color: "#caa6d8", marginBottom: 16 }}>
            A DRAG RACE SEASON RUN
          </div>
          <div style={goldRule} />

          <div style={{ margin: "26px auto 8px", maxWidth: 420, display: "flex", flexDirection: "column", gap: 12 }}>
            {ruPun("Welcome, my dear. The lights are hot, the panel is seated, and the only thing missing is you.")}
            {ruPun("Across nine weeks you'll werk every kind of challenge this stage can throw, then read your sisters in the library and lip sync when your back's against the wall.")}
            {ruPun("Make it to the final two and you'll lip sync for the crown. It doesn't come to the timid. It comes to the fierce.")}
          </div>

          <div style={{
            margin: "20px auto 26px", maxWidth: 420, padding: "16px 18px",
            border: "1px solid rgba(216,177,90,0.35)", borderRadius: 2,
            background: "rgba(216,177,90,0.05)",
          }}>
            <div style={{ fontSize: 10.5, letterSpacing: 4, color: "#d8b15a", marginBottom: 8 }}>THIS SEASON'S CATEGORIES</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "#efe4d4" }}>
              Trivia &middot; Conjoined Twins &middot; Spill the Tea &middot; Lyric Scramble &middot; Snatch Game &middot; Untucked &middot; Runway Realness
            </div>
          </div>

          <button
            onClick={() => { setNameInput(""); setNameScore(null); setNameCritique(""); setAiError(""); setPhase("create"); }}
            style={{
              background: "linear-gradient(180deg, #f4dd9a, #d8b15a)",
              color: "#2a1024", border: "none",
              padding: "15px 40px", fontSize: 15, fontWeight: 800, letterSpacing: 2,
              borderRadius: 2, cursor: "pointer",
              boxShadow: "0 6px 24px rgba(216,177,90,0.35)",
              textTransform: "uppercase",
            }}>
            Start Your Engines
          </button>
          <div style={{ fontSize: 11.5, letterSpacing: 1, color: "#caa6d8", opacity: 0.7, marginTop: 14, fontStyle: "italic" }}>
            And may the best woman win.
          </div>
          <div style={{ fontSize: 10.5, letterSpacing: 0.5, color: "#caa6d8", opacity: 0.5, marginTop: 28 }}>
            Made for lil Naddy. RuPaul pls don't sue me.
          </div>
        </div>
      </div>
    );
  }

  if (phase === "create") {
    return (
      <div style={wrap}>
        <Header />
        <div style={card}>
          <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>CHARACTER CREATION</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#ffd966", margin: "8px 0 4px" }}>Name Your Queen</div>
          <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.9 }}>
            Every legend starts with a name. Make it the punniest, cleverest drag name you can dream up. The head judge scores it out of 100 (and she's feeling generous today).
          </p>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitName(); }}
            placeholder="e.g. Anita Mandalay"
            disabled={judging}
            style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10, border: "2px solid rgba(216,177,90,0.4)", background: "rgba(20,8,26,0.8)", color: "#f3e9dd", fontSize: 16, textAlign: "center", margin: "12px 0", outline: "none" }}
          />
          <div style={{ fontSize: 11.5, color: "#caa6d8", opacity: 0.85, marginBottom: 10, fontStyle: "italic", lineHeight: 1.4 }}>
            The judge rewards clever puns and double meanings. A name that makes her gasp scores higher than one that just sounds pretty.
          </div>
          {aiError && <p style={{ color: "#caa6d8", fontSize: 13 }}>{aiError}</p>}
          {nameScore === null ? (
            <button style={{ ...btn, opacity: nameInput.trim() && !judging ? 1 : 0.4, pointerEvents: nameInput.trim() && !judging ? "auto" : "none" }} onClick={submitName}>
              {judging ? "The judges are deliberating..." : "Submit To The Judges"}
            </button>
          ) : (
            <div>
              <div style={{ fontSize: 50, fontWeight: 900, color: nameScore >= 80 ? "#ffd966" : nameScore >= 50 ? "#d8b15a" : "#caa6d8", textShadow: "0 0 20px rgba(216,177,90,0.4)" }}>
                {nameScore}<span style={{ fontSize: 22, opacity: 0.6 }}>/100</span>
              </div>
              <p style={{ fontSize: 15, fontStyle: "italic", lineHeight: 1.6 }}>"{nameCritique}"</p>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginTop: 8 }}>
                <button style={{ ...btn, background: "rgba(216,177,90,0.2)" }} onClick={() => { setNameScore(null); setNameCritique(""); }}>Try Another Name</button>
                <button style={{ ...btn, opacity: castLoading ? 0.5 : 1, pointerEvents: castLoading ? "none" : "auto" }} onClick={generateSeasonCast}>
                  {castLoading ? "The queens are arriving..." : "Werk With \"" + dragName + "\""}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === "meetCast") {
    return (
      <div style={wrap}>
        <Header />
        <div style={{ ...card, maxWidth: 500 }}>
          <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>MEET YOUR SISTERS</div>
          <p style={{ fontSize: 14, lineHeight: 1.55, marginTop: 8 }}>
            Welcome to the werk room, <b style={{ color: "#ffd966" }}>{dragName}</b>. Here are the {cast.length} queens you'll be battling for the crown. A fresh cast every season, so no two runs are alike.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 7, margin: "14px 0", textAlign: "left", maxHeight: 360, overflowY: "auto" }}>
            {cast.map((name) => {
              const star = name === STAR_QUEEN;
              return (
                <div key={name} style={{
                  padding: "9px 12px", borderRadius: 10,
                  border: star ? "2px solid rgba(255,217,102,0.6)" : "1px solid rgba(216,177,90,0.25)",
                  background: star ? "rgba(255,217,102,0.08)" : "rgba(30,12,36,0.75)",
                }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: star ? "#ffd966" : "#f3e9dd" }}>
                    {name}{star ? " (the one to beat)" : ""}
                  </div>
                  <div style={{ fontSize: 12.5, opacity: 0.82, fontStyle: "italic", lineHeight: 1.35 }}>
                    {castPersonas[name] || "a queen of mystery"}
                  </div>
                </div>
              );
            })}
          </div>
          <button style={btn} onClick={beginSeason}>Let The Games Begin</button>
        </div>
      </div>
    );
  }

  if (phase === "challenge") {
    const meta = CHALLENGE_META[challengeType];
    const ChallengeHeader = (
      <>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginBottom: 10 }}>
          <span style={pill}>{dragName}</span>
          <span style={pill}>Week {week}/{TOTAL_WEEKS}</span>
          <span style={pill}>{queensLeft} queens left</span>
        </div>
        <div style={{ ...card, padding: 14, marginBottom: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2 }}>{meta.tag}</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#ffd966" }}>{meta.emoji} {meta.name}</div>
        </div>
      </>
    );

    // ----- TRIVIA -----
    if (challengeType === "trivia") {
      const current = quiz[qIndex];
      if (!current) return null;
      return (
        <div style={wrap}>
          <Header />
          {ChallengeHeader}
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%", maxWidth: 440, marginBottom: 8, fontSize: 14 }}>
            <span>Question <b style={{ color: "#d8b15a" }}>{qIndex + 1}</b> / {quiz.length}</span>
            <span>Correct: <b style={{ color: "#ffd966" }}>{correctCount}</b></span>
          </div>
          <div style={{ ...card, textAlign: "left" }}>
            <div style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.4, marginBottom: 16 }}>{current.q}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {current.opts.map((opt, i) => {
                let bg = "rgba(216,177,90,0.10)", border = "1px solid rgba(216,177,90,0.35)";
                if (locked) {
                  if (opt.correct) { bg = "rgba(80,220,120,0.25)"; border = "2px solid #4fdc7a"; }
                  else if (i === picked) { bg = "rgba(255,80,80,0.25)"; border = "2px solid #ff5050"; }
                }
                return (
                  <button key={i} onClick={() => answerQuestion(i)} disabled={locked} style={{
                    textAlign: "left", padding: "12px 14px", borderRadius: 10, border, background: bg,
                    color: "#f3e9dd", fontSize: 15, fontWeight: 600, cursor: locked ? "default" : "pointer",
                  }}>
                    {opt.text}
                    {locked && opt.correct && <span style={{ float: "right" }}>{"\u2713"}</span>}
                    {locked && !opt.correct && i === picked && <span style={{ float: "right" }}>{"\u2717"}</span>}
                  </button>
                );
              })}
            </div>
            {locked && (
              <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 10, background: "rgba(255,217,102,0.10)", border: "1px solid rgba(255,217,102,0.35)" }}>
                <div style={{ fontSize: 11, letterSpacing: 1, color: "#ffd966", marginBottom: 4 }}>{current.ep}</div>
                <div style={{ fontSize: 13, fontStyle: "italic", lineHeight: 1.5, opacity: 0.92 }}>{current.line}</div>
              </div>
            )}
            {locked && (
              <button style={{ ...btn, marginTop: 14, width: "100%" }} onClick={nextQuestion}>
                {qIndex + 1 < quiz.length ? "Next Question" : "See The Verdict"}
              </button>
            )}
          </div>
        </div>
      );
    }

    // ----- MEMORY MATCH -----
    if (challengeType === "memory") {
      const pairsFound = memCards.filter((c) => c.matched).length / 2;
      return (
        <div style={wrap}>
          <Header />
          {ChallengeHeader}
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%", maxWidth: 380, marginBottom: 8, fontSize: 14 }}>
            <span>Pairs: <b style={{ color: "#ffd966" }}>{pairsFound}</b>/6</span>
            <span><b style={{ color: "#caa6d8" }}>{memTime}s</b></span>
            <span>Flips: <b style={{ color: "#d8b15a" }}>{memMoves}</b></span>
          </div>
          <p style={{ fontSize: 12.5, opacity: 0.78, maxWidth: 380, textAlign: "center", marginTop: 0, lineHeight: 1.45 }}>
            You're on the clock, every queen is timed. Match all 6 pairs FAST. The two slowest queens land in the bottom and lip sync for their lives.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, width: "100%", maxWidth: 380 }}>
            {memCards.map((c) => {
              const show = c.flipped || c.matched;
              return (
                <button key={c.uid} onClick={() => flipCard(c.uid)} disabled={memLock || show} style={{
                  aspectRatio: "3/4", borderRadius: 12, cursor: show ? "default" : "pointer",
                  border: c.matched ? "2px solid #4fdc7a" : "2px solid rgba(216,177,90,0.4)",
                  background: show ? "rgba(255,217,102,0.14)" : "linear-gradient(160deg,#5c2a64,#2a1030)",
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                  color: "#f3e9dd", transition: "all 0.2s",
                }}>
                  <div style={{ fontSize: 30 }}>{show ? c.face : "\u2753"}</div>
                  {show && <div style={{ fontSize: 9.5, opacity: 0.85, marginTop: 2, textAlign: "center", lineHeight: 1.1 }}>{c.label}</div>}
                </button>
              );
            })}
          </div>
        </div>
      );
    }

    // ----- SPILL THE TEA -----
    if (challengeType === "tea") {
      const item = teaItems[teaIndex];
      if (!item) return null;
      return (
        <div style={wrap}>
          <Header />
          {ChallengeHeader}
          {teaLoading && (
            <div style={{ fontSize: 12.5, color: "#ffd966", opacity: 0.85, marginBottom: 8 }}>
              The queens are dishing fresh gossip...
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%", maxWidth: 440, marginBottom: 8, fontSize: 14 }}>
            <span>Statement <b style={{ color: "#d8b15a" }}>{teaIndex + 1}</b> / {teaItems.length}</span>
            <span>Right: <b style={{ color: "#ffd966" }}>{teaCorrect}</b></span>
          </div>
          <div style={{ ...card }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, marginBottom: 8 }}>FACT, OR FICTION?</div>
            <div style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.45, minHeight: 60 }}>"{item.text}"</div>
            {!item.answered ? (
              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16 }}>
                <button style={{ ...btn, background: "linear-gradient(180deg,#5fd089,#2fa85a)", color: "#0c2014" }} onClick={() => answerTea(true)}>FACT</button>
                <button style={{ ...btn, background: "linear-gradient(180deg,#ff7a7a,#c92a2a)", color: "#2a0c0c" }} onClick={() => answerTea(false)}>FICTION</button>
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: item.correct ? "#4fdc7a" : "#caa6d8" }}>
                  {item.correct ? "Correct, the tea is piping hot!" : "Wrong, sis. Spill it back."} It was {item.fact ? "a FACT" : "pure FICTION"}.
                </div>
                <div style={{ fontSize: 13.5, fontStyle: "italic", opacity: 0.85, marginTop: 6, lineHeight: 1.45 }}>
                  {item.correct
                    ? TEA_RIGHT_QUIPS[teaIndex % TEA_RIGHT_QUIPS.length]
                    : TEA_WRONG_QUIPS[teaIndex % TEA_WRONG_QUIPS.length]}
                </div>
                <button style={{ ...btn, marginTop: 12, width: "100%" }} onClick={nextTea}>
                  {teaIndex + 1 < teaItems.length ? "Next" : "See The Verdict"}
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }

    // ----- LYRIC SCRAMBLE -----
    if (challengeType === "scramble") {
      const round = scrItems[scrIndex];
      if (!round) return null;
      const gotIt = round.gotIt;
      return (
        <div style={wrap}>
          <Header />
          {ChallengeHeader}
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%", maxWidth: 440, marginBottom: 8, fontSize: 14 }}>
            <span>Line <b style={{ color: "#d8b15a" }}>{scrIndex + 1}</b> / {scrItems.length}</span>
            <span>Right: <b style={{ color: "#ffd966" }}>{scrCorrect}</b></span>
          </div>
          <div style={{ ...card }}>
            <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 2, marginBottom: 4 }}>UNSCRAMBLE THE LYRIC</div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12, fontStyle: "italic" }}>from: {round.song}</div>

            <div style={{ minHeight: 50, display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", padding: 8, borderRadius: 10, background: "rgba(20,8,26,0.7)", border: "1px dashed rgba(216,177,90,0.4)", marginBottom: 12 }}>
              {scrBuilt.length === 0 && <span style={{ fontSize: 13, opacity: 0.5 }}>tap words below in order...</span>}
              {scrBuilt.map((t) => (
                <button key={t.key} onClick={() => unplaceWord(t)} disabled={scrDone} style={{
                  padding: "8px 12px", borderRadius: 8, border: "none", cursor: scrDone ? "default" : "pointer",
                  background: "linear-gradient(90deg,#d8b15a,#a87a3a)", color: "#fff", fontWeight: 700, fontSize: 14,
                }}>{t.w}</button>
              ))}
            </div>

            {!scrDone && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", marginBottom: 12 }}>
                {scrPool.map((t) => (
                  <button key={t.key} onClick={() => placeWord(t)} style={{
                    padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(216,177,90,0.4)", cursor: "pointer",
                    background: "rgba(216,177,90,0.12)", color: "#f3e9dd", fontWeight: 700, fontSize: 14,
                  }}>{t.w}</button>
                ))}
              </div>
            )}

            {scrDone && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: gotIt ? "#4fdc7a" : "#caa6d8" }}>
                  {gotIt ? "Nailed it!" : "Not quite. It was: \"" + round.answer.join(" ") + "\""}
                </div>
                <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.85, marginTop: 4 }}>
                  {gotIt
                    ? SCRAMBLE_RIGHT_QUIPS[scrIndex % SCRAMBLE_RIGHT_QUIPS.length]
                    : SCRAMBLE_WRONG_QUIPS[scrIndex % SCRAMBLE_WRONG_QUIPS.length]}
                </div>
              </div>
            )}

            {!scrDone ? (
              <button style={{ ...btn, width: "100%", opacity: scrPool.length === 0 ? 1 : 0.4, pointerEvents: scrPool.length === 0 ? "auto" : "none" }} onClick={checkScramble}>
                Lock It In
              </button>
            ) : (
              <button style={{ ...btn, width: "100%" }} onClick={nextScramble}>
                {scrIndex + 1 < scrItems.length ? "Next Line" : "See The Verdict"}
              </button>
            )}
          </div>
        </div>
      );
    }

    // ----- SNATCH GAME -----
    if (challengeType === "snatch") {
      return (
        <div style={wrap}>
          <Header />
          {ChallengeHeader}
          {snStage === "write" ? (
            <div style={{ ...card, textAlign: "left", maxWidth: 480 }}>
              <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 1, marginBottom: 4 }}>YOU ARE PLAYING</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#ffd966", marginBottom: 10 }}>{snPlayerCeleb}</div>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>The rest of the panel:</div>
              <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12, lineHeight: 1.5 }}>
                {snRivals.map((r) => <span key={r.queen}>{r.queen} as <b>{r.celeb}</b><br /></span>)}
              </div>
              <div style={{ padding: "10px 14px", borderRadius: 10, background: "rgba(255,217,102,0.1)", border: "1px solid rgba(255,217,102,0.35)", fontSize: 15.5, fontWeight: 600, lineHeight: 1.45, marginBottom: 12 }}>
                {snPrompt}
              </div>
              <div style={{ fontSize: 12.5, opacity: 0.75, marginBottom: 8, fontStyle: "italic", lineHeight: 1.4 }}>
                RuPaul rewards puns, zingers, and a spot-on impression. Stay in {snPlayerCeleb}'s voice and land a punchline, the funniest queen takes the win.
              </div>
              <textarea
                value={snQuote}
                onChange={(e) => setSnQuote(e.target.value)}
                placeholder={"As " + snPlayerCeleb + ", I'd say..."}
                disabled={snLoading}
                rows={3}
                style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10, border: "2px solid rgba(216,177,90,0.4)", background: "rgba(20,8,26,0.8)", color: "#f3e9dd", fontSize: 15, margin: "4px 0 10px", outline: "none", resize: "vertical", fontFamily: "inherit" }}
              />
              {aiError && <p style={{ color: "#caa6d8", fontSize: 13 }}>{aiError}</p>}
              <button style={{ ...btn, width: "100%", opacity: snQuote.trim() && !snLoading ? 1 : 0.4, pointerEvents: snQuote.trim() && !snLoading ? "auto" : "none" }} onClick={submitSnatch}>
                {snLoading ? "The panel is performing..." : "Deliver Your Line"}
              </button>
            </div>
          ) : (
            <div style={{ ...card, textAlign: "left", maxWidth: 480 }}>
              <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2, marginBottom: 4 }}>THE PANEL'S ANSWERS</div>
              <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.8, marginBottom: 12 }}>{snPrompt}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {snEntries.map((e, i) => (
                  <div key={i} style={{
                    padding: "10px 12px", borderRadius: 10,
                    border: e.isPlayer ? "2px solid #ffd966" : "1px solid rgba(216,177,90,0.25)",
                    background: i === 0 ? "rgba(255,217,102,0.14)" : e.isPlayer ? "rgba(255,217,102,0.07)" : "rgba(30,12,36,0.75)",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 13.5, fontWeight: 700 }}>{(i + 1) + ". "}{e.queen}{e.isPlayer ? " (you)" : ""} <span style={{ opacity: 0.7, fontWeight: 400 }}>as {e.celeb}</span></span>
                      <span style={{ fontSize: 14, fontWeight: 900, color: e.score >= 80 ? "#ffd966" : e.score >= 50 ? "#d8b15a" : "#caa6d8" }}>{e.score}</span>
                    </div>
                    <div style={{ fontSize: 13, fontStyle: "italic", opacity: 0.88, marginTop: 4, lineHeight: 1.4 }}>"{e.quote}"</div>
                  </div>
                ))}
              </div>
              {snRu && (
                <div style={{ margin: "12px 0", padding: "10px 14px", borderRadius: 10, background: "rgba(255,217,102,0.1)", border: "1px solid rgba(255,217,102,0.35)" }}>
                  <div style={{ fontSize: 12, letterSpacing: 1, color: "#ffd966", marginBottom: 4 }}>RUPAUL SAYS</div>
                  <div style={{ fontSize: 14, fontStyle: "italic", lineHeight: 1.45 }}>"{snRu}"</div>
                </div>
              )}
              <button style={{ ...btn, width: "100%", marginTop: 6 }} onClick={finishSnatch}>See The Verdict</button>
            </div>
          )}
        </div>
      );
    }

    // ----- UNTUCK THE DRAMA & RUNWAY REALNESS -----
    if (challengeType === "untuck" || challengeType === "runway") {
      const round = mcRounds[mcIndex];
      if (!round) return null;
      const answered = round.picked !== null;
      const isRunway = challengeType === "runway";
      return (
        <div style={wrap}>
          <Header />
          {ChallengeHeader}
          {isRunway && runwayLoading && (
            <div style={{ fontSize: 12.5, color: "#ffd966", opacity: 0.85, marginBottom: 8 }}>
              The design team is dreaming up tonight's theme...
            </div>
          )}
          {!isRunway && untuckLoading && (
            <div style={{ fontSize: 12.5, color: "#ffd966", opacity: 0.85, marginBottom: 8 }}>
              The cameras are rolling on tonight's drama...
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%", maxWidth: 460, marginBottom: 8, fontSize: 14 }}>
            <span>Round <b style={{ color: "#d8b15a" }}>{mcIndex + 1}</b> / {mcRounds.length}</span>
            <span>Nailed it: <b style={{ color: "#ffd966" }}>{mcCorrect}</b></span>
          </div>
          <div style={{ ...card, textAlign: "left" }}>
            {isRunway ? (
              <>
                <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 1, marginBottom: 4 }}>TONIGHT'S CATEGORY IS</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#ffd966", marginBottom: 10 }}>{round.theme}</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Pick the most on-theme <b>{round.setup}</b>:</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 1, marginBottom: 6 }}>BACKSTAGE AT UNTUCKED</div>
                <div style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.5, marginBottom: 14 }}>{round.setup}</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>How do you handle it? Keep it classy, the fans are watching:</div>
              </>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {round.opts.map((opt, i) => {
                let bg = "rgba(216,177,90,0.10)", border = "1px solid rgba(216,177,90,0.35)";
                if (answered) {
                  if (opt.best) { bg = "rgba(80,220,120,0.25)"; border = "2px solid #4fdc7a"; }
                  else if (i === round.picked) { bg = "rgba(255,80,80,0.25)"; border = "2px solid #ff5050"; }
                }
                return (
                  <button key={i} onClick={() => answerMC(i)} disabled={answered} style={{
                    textAlign: "left", padding: "12px 14px", borderRadius: 10, border, background: bg,
                    color: "#f3e9dd", fontSize: 14.5, fontWeight: 600, lineHeight: 1.4, cursor: answered ? "default" : "pointer",
                  }}>
                    {opt.text}
                    {answered && opt.best && <span style={{ float: "right" }}>{"\u2713"}</span>}
                    {answered && !opt.best && i === round.picked && <span style={{ float: "right" }}>{"\u2717"}</span>}
                  </button>
                );
              })}
            </div>
            {answered && (
              <div style={{ marginTop: 12, fontSize: 14, fontWeight: 700, color: round.opts[round.picked].best ? "#4fdc7a" : "#caa6d8" }}>
                {round.opts[round.picked].best
                  ? (isRunway ? "Serving the theme! The judges gag." : "Diplomatic and classy. The fans adore you.")
                  : (isRunway ? "Off-theme, sis. That read as a different category." : "Messy. That'll make the highlight reel for the wrong reasons.")}
              </div>
            )}
            {answered && (
              <button style={{ ...btn, marginTop: 14, width: "100%" }} onClick={nextMC}>
                {mcIndex + 1 < mcRounds.length ? "Next Round" : "See The Verdict"}
              </button>
            )}
          </div>
        </div>
      );
    }

    return null;
  }

  if (phase === "memResult") {
    const youInBottom = memRouteBottom;
    return (
      <div style={wrap}>
        <Header />
        <div style={{ ...card, maxWidth: 460 }}>
          <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>CONJOINED TWIN RESULTS</div>
          <div style={{ fontSize: 14, marginTop: 4 }}>You cleared the board in <b style={{ color: "#ffd966" }}>{memTime}s</b> ({memMoves} flips).</div>
          {memRank && <div style={{ fontSize: 28, fontWeight: 900, color: memRank <= 6 ? "#ffd966" : "#caa6d8", margin: "6px 0" }}>Rank {memRank} / {memField.length}</div>}

          <div style={{ margin: "12px 0", padding: "12px 14px", borderRadius: 12, background: "rgba(255,217,102,0.10)", border: "1px solid rgba(255,217,102,0.4)" }}>
            <div style={{ fontSize: 12, letterSpacing: 1, color: "#ffd966", marginBottom: 4 }}>RUPAUL SAYS</div>
            {memPun
              ? <div style={{ fontSize: 15, fontStyle: "italic", lineHeight: 1.5 }}>"{memPun}"</div>
              : <div style={{ fontSize: 13, opacity: 0.7 }}>RuPaul is thinking of the perfect pun...</div>}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 5, margin: "12px 0", textAlign: "left" }}>
            {memField.map((f, i) => {
              const isBottom = memBottomTwo.includes(f.name);
              return (
                <div key={f.name} style={{
                  display: "flex", justifyContent: "space-between", padding: "6px 10px", borderRadius: 8, fontSize: 13,
                  border: f.isYou ? "2px solid #ffd966" : "1px solid rgba(216,177,90,0.2)",
                  background: f.isYou ? "rgba(255,217,102,0.12)" : isBottom ? "rgba(255,80,80,0.1)" : "rgba(30,12,36,0.7)",
                }}>
                  <span>{(i + 1) + ". "}{f.name}{f.isYou ? " (you)" : ""}</span>
                  <span style={{ color: isBottom ? "#caa6d8" : "#f3e9dd" }}>{f.time}s</span>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 10 }}>
            {youInBottom
              ? <span style={{ color: "#caa6d8" }}>You landed in the bottom two. Time to lip sync for your life against <b>{memBottomTwo.find((n) => n !== dragName)}</b>.</span>
              : <span style={{ color: "#4fdc7a" }}>Safe! The bottom two ({memBottomTwo.join(" & ")}) head to the lip sync. You live to slay another day.</span>}
          </div>
          <button style={btn} onClick={continueFromMemory}>
            {youInBottom ? "Step Up To Lip Sync" : "Continue The Season"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "reading") {
    if (libStage === "intro") {
      return (
        <div style={wrap}>
          <Header />
          <div style={{ ...card, borderColor: "rgba(216,177,90,0.45)" }}>
            <div style={{ fontSize: 10.5, letterSpacing: 4, color: "#d8b15a", marginBottom: 6 }}>THE READING CHALLENGE</div>
            <div style={{ ...title, fontSize: 27 }}>THE LIBRARY IS OPEN</div>
            <p style={{ fontSize: 14.5, lineHeight: 1.6, marginTop: 12, fontStyle: "italic", color: "#e9dcc8" }}>
              Reading is fundamental, my dear. Pick a sister, find her flaw, and serve it back with love and a little venom.
            </p>
            <div style={{ textAlign: "left", fontSize: 13, lineHeight: 1.7, margin: "16px 0", opacity: 0.9 }}>
              Choose a queen from the lineup and type your sharpest read.<br />
              The judge scores it, then you may read again or bow out.<br />
              Only your last read counts, so quit while you're ahead.<br />
              Land an 80 or higher and you bump up a placement tier.
            </div>
            {aiError && <p style={{ color: "#caa6d8", fontSize: 13 }}>{aiError}</p>}
            <button style={{ ...btn, opacity: libLoading ? 0.5 : 1, pointerEvents: libLoading ? "none" : "auto" }} onClick={openLibrary}>
              {libLoading ? "The queens take their seats..." : "Enter The Library"}
            </button>
          </div>
        </div>
      );
    }

    if (libStage === "reading") {
      return (
        <div style={wrap}>
          <Header />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginBottom: 10 }}>
            <span style={pill}>Week {week}</span>
            <span style={pill}>Library Is Open</span>
            {bankedScore !== null && <span style={{ ...pill, background: "rgba(255,217,102,0.18)", borderColor: "#ffd966", color: "#ffe9b0" }}>Banked: {bankedScore} ({bankedTarget})</span>}
          </div>
          <div style={card}>
            <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>PICK A QUEEN TO READ</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
              {lineup.map((q) => {
                const sel = readTarget && readTarget.name === q.name;
                return (
                  <button key={q.name} onClick={() => setReadTarget(q)} style={{
                    textAlign: "left", padding: "10px 12px", borderRadius: 10, cursor: "pointer",
                    border: "2px solid " + (sel ? "#d8b15a" : q.star ? "rgba(255,217,102,0.6)" : "rgba(216,177,90,0.3)"),
                    background: sel ? "rgba(216,177,90,0.18)" : q.star ? "rgba(255,217,102,0.08)" : "rgba(30,12,36,0.8)", color: "#f3e9dd",
                  }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: q.star ? "#ffd966" : "#f3e9dd" }}>{q.name}{q.star ? " (fan favorite)" : ""}</div>
                    <div style={{ fontSize: 12.5, opacity: 0.82, fontStyle: "italic", lineHeight: 1.4 }}>{q.desc}</div>
                  </button>
                );
              })}
            </div>
            {readTarget && (
              <div>
                <textarea
                  value={readInput}
                  onChange={(e) => setReadInput(e.target.value)}
                  placeholder={"Read " + readTarget.name + "... play off her dossier."}
                  disabled={judging}
                  rows={3}
                  style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10, border: "2px solid rgba(216,177,90,0.4)", background: "rgba(20,8,26,0.8)", color: "#f3e9dd", fontSize: 15, margin: "4px 0 10px", outline: "none", resize: "vertical", fontFamily: "inherit" }}
                />
                <div style={{ fontSize: 11.5, color: "#caa6d8", opacity: 0.85, marginBottom: 8, fontStyle: "italic", lineHeight: 1.4 }}>
                  The judge loves a clever pun or zinger that plays off her dossier. Wordplay scores higher than a plain insult, and keep it witty, never cruel.
                </div>
                {aiError && <p style={{ color: "#caa6d8", fontSize: 13 }}>{aiError}</p>}
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <button style={{ ...btn, opacity: readInput.trim() && !judging ? 1 : 0.4, pointerEvents: readInput.trim() && !judging ? "auto" : "none" }} onClick={submitLibraryRead}>
                    {judging ? "The library gasps..." : "Throw The Shade"}
                  </button>
                  {bankedScore !== null && (
                    <button style={{ ...btn, background: "rgba(255,217,102,0.25)", color: "#3a1240" }} onClick={() => applyReadBonus(bankedScore)}>
                      Stop, I'm Done
                    </button>
                  )}
                </div>
              </div>
            )}
            {!readTarget && (
              <p style={{ fontSize: 12, opacity: 0.6 }}>Tap a queen above to start your read.</p>
            )}
          </div>
        </div>
      );
    }

    if (libStage === "scored") {
      return (
        <div style={wrap}>
          <Header />
          <div style={card}>
            <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 3, color: "#d8b15a" }}>YOU READ {bankedTarget ? bankedTarget.toUpperCase() : ""}</div>
            <div style={{ fontSize: 52, fontWeight: 900, color: readScore >= 80 ? "#ffd966" : readScore >= 50 ? "#d8b15a" : "#caa6d8", margin: "6px 0", fontFamily: "Georgia,serif" }}>
              {readScore}<span style={{ fontSize: 22, opacity: 0.6 }}>/100</span>
            </div>
            <p style={{ fontSize: 15, fontStyle: "italic", lineHeight: 1.6, color: "#efe4d4" }}>"{readCritique}"</p>
            <div style={{ fontSize: 13, color: "#ffd966", margin: "10px 0" }}>
              Banked. This is the score that counts{readScore >= 80 ? ", and it bumps your placement." : " (an 80 bumps your placement)."}
            </div>
            <p style={{ fontSize: 12.5, opacity: 0.75 }}>
              Read again to chase a higher score, but a new read replaces this one, for better or worse.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginTop: 10 }}>
              <button style={{ ...btn, background: "transparent", color: "#d8b15a", border: "1px solid rgba(216,177,90,0.5)", boxShadow: "none" }} onClick={readAgain}>Read Again</button>
              <button style={btn} onClick={finishLibrary} disabled={libLoading}>
                {libLoading ? "Tallying the shade..." : "I'm Done"}
              </button>
            </div>
            {aiError && <p style={{ color: "#caa6d8", fontSize: 13, marginTop: 8 }}>{aiError}</p>}
          </div>
        </div>
      );
    }

    if (libStage === "leaderboard") {
      const board = [
        { name: dragName, score: bankedScore == null ? 0 : bankedScore, isYou: true,
          read: bankedScore == null ? "(declined to read)" : bankedRead, target: bankedTarget },
        ...rivalReads.map((r) => ({ name: r.reader, score: r.score, read: r.read, target: r.target, isYou: false })),
      ].sort((a, b) => b.score - a.score);
      return (
        <div style={wrap}>
          <Header />
          <div style={{ ...card, maxWidth: 500 }}>
            <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>THE READING LEADERBOARD</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
              {board.map((r, i) => (
                <div key={i} style={{
                  textAlign: "left", padding: "10px 12px", borderRadius: 10,
                  border: r.isYou ? "2px solid #ffd966" : "1px solid rgba(216,177,90,0.3)",
                  background: r.isYou ? "rgba(255,217,102,0.12)" : "rgba(30,12,36,0.8)",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>
                      {(i + 1) + ". "}{r.name}{r.isYou ? " (you)" : ""}
                    </span>
                    <span style={{ fontSize: 16, fontWeight: 900, color: r.score >= 80 ? "#ffd966" : r.score >= 50 ? "#d8b15a" : "#caa6d8" }}>{r.score}</span>
                  </div>
                  {r.read && r.target && (
                    <div style={{ fontSize: 12.5, opacity: 0.82, fontStyle: "italic", marginTop: 4 }}>
                      on {r.target}: "{r.read}"
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button style={btn} onClick={() => { setPhase("libClosed"); }}>
              Close The Library
            </button>
          </div>
        </div>
      );
    }

    return null;
  }

  if (phase === "libClosed") {
    return (
      <div style={wrap}>
        <Header />
        <div style={{ ...card, textAlign: "center", borderColor: "rgba(255,217,102,0.4)" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}></div>
          <div style={{ ...title, fontSize: 30 }}>LA BIBLIOTECA IS CLOSED</div>
          <p style={{ fontSize: 14, opacity: 0.85, marginTop: 10 }}>
            The shade has settled, the dust has cleared. Your banked read: <b style={{ color: "#ffd966" }}>{bankedScore == null ? "none" : bankedScore + "/100"}</b>.
          </p>
          <button style={{ ...btn, marginTop: 8 }} onClick={() => applyReadBonus(bankedScore == null ? 0 : bankedScore)}>
            Take It To The Runway
          </button>
        </div>
      </div>
    );
  }

  if (phase === "results") {
    const colorMap = { WIN: "#ffd966", HIGH: "#d8b15a", SAFE: "#9d8fff", BOTTOM: "#ff4d4d" };
    return (
      <div style={wrap}>
        <Header />
        <div style={card}>
          <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>RUNWAY VERDICT, WEEK {week}</div>
          <div style={{ fontSize: 46, fontWeight: 900, color: colorMap[resultPlacement], margin: "10px 0", textShadow: "0 0 24px " + colorMap[resultPlacement] + "66" }}>{resultPlacement}</div>
          <p style={{ fontSize: 15, lineHeight: 1.6, fontStyle: "italic" }}>{resultBlurb}</p>
          <button style={btn} onClick={proceedFromResults}>{resultPlacement === "BOTTOM" ? "Step Up To Lip Sync" : "Continue The Season"}</button>
        </div>
      </div>
    );
  }

  if (phase === "lipsync") {
    const vibe = vibeForRound(lsRound);
    const rr = lsRoundResult;
    const lead = lsYouScore - lsRivalScore;
    return (
      <div style={wrap}>
        <Header />
        <div style={{ ...card, maxWidth: 480 }}>
          <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>LIP SYNC FOR YOUR LIFE</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#ffd966", margin: "4px 0 2px" }}>"{lsSong}"</div>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 10 }}>You vs <b style={{ color: "#d8b15a" }}>{lsOpponent}</b> {"\u00B7"} Round {Math.min(lsRound + 1, LS_TOTAL_ROUNDS)}/{LS_TOTAL_ROUNDS}</div>

          <div style={{ display: "flex", justifyContent: "center", gap: 18, alignItems: "center", marginBottom: 12 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, opacity: 0.7 }}>{dragName || "YOU"}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#d8b15a" }}>{lsYouScore}</div>
            </div>
            <div style={{ fontSize: 13, opacity: 0.6 }}>{lead > 0 ? "ahead" : lead < 0 ? "behind" : "tied"}</div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, opacity: 0.7 }}>{lsOpponent}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#9d8fff" }}>{lsRivalScore}</div>
            </div>
          </div>

          {lsCombo >= 2 && !rr && (
            <div style={{ fontSize: 13, color: "#ffd966", fontWeight: 700, marginBottom: 8 }}>
              SHOWSTOPPER ARMED! Win on-vibe this round to DOUBLE it.
            </div>
          )}
          {lsRivalCombo >= 2 && !rr && (
            <div style={{ fontSize: 13, color: "#caa6d8", fontWeight: 700, marginBottom: 8 }}>
              {lsOpponent} is on a streak and can showstopper you. Don't fumble the vibe.
            </div>
          )}

          {!rr ? (
            <div>
              <div style={{ padding: "10px 14px", borderRadius: 12, background: vibe.color + "22", border: "2px solid " + vibe.color, marginBottom: 4 }}>
                <div style={{ fontSize: 12, letterSpacing: 2, opacity: 0.8 }}>CROWD VIBE</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: vibe.color }}>{vibe.emoji} {vibe.label}</div>
                <div style={{ fontSize: 13, opacity: 0.9, fontStyle: "italic" }}>{vibe.note}</div>
              </div>
              <p style={{ fontSize: 12, opacity: 0.65, margin: "10px 0 8px" }}>
                Pick your move. She picks at the same time. Match the vibe to win the round.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8 }}>
                {LS_MOVES.map((m) => {
                  const onVibe = m.fav === vibe.key;
                  return (
                    <button key={m.name} onClick={() => playMove(m)} style={{
                      textAlign: "left", cursor: "pointer", borderRadius: 10,
                      border: "2px solid " + (onVibe ? vibe.color : "rgba(216,177,90,0.3)"),
                      background: "rgba(30,12,36,0.85)", color: "#f3e9dd", padding: "10px 12px",
                      boxShadow: onVibe ? "0 0 10px " + vibe.color + "55" : "none",
                    }}>
                      <div style={{ fontSize: 18 }}>{m.emoji}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2 }}>{m.name}</div>
                      <div style={{ fontSize: 11, opacity: 0.7 }}>
                        best in {VIBES.find((v) => v.key === m.fav).label.toLowerCase()}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", margin: "6px 0 10px" }}>
                <div style={{ flex: 1, padding: 10, borderRadius: 10, background: "rgba(255,111,194,0.12)", border: "1px solid rgba(255,111,194,0.4)" }}>
                  <div style={{ fontSize: 22 }}>{rr.youMove.emoji}</div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{rr.youMove.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.75, fontStyle: "italic" }}>You {rr.youMove.flav}</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: "#d8b15a", marginTop: 4 }}>+{rr.youPts}{rr.showstopper ? " (showstopper)" : ""}</div>
                </div>
                <div style={{ flex: 1, padding: 10, borderRadius: 10, background: "rgba(157,143,255,0.12)", border: "1px solid rgba(157,143,255,0.4)" }}>
                  <div style={{ fontSize: 22 }}>{rr.rivalMove.emoji}</div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{rr.rivalMove.name}</div>
                  <div style={{ fontSize: 11, opacity: 0.75, fontStyle: "italic" }}>{lsOpponent} {rr.rivalMove.flav}</div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: "#9d8fff", marginTop: 4 }}>+{rr.rivalPts}{rr.rivalShowstopper ? " (showstopper)" : ""}</div>
                </div>
              </div>
              <div style={{ fontSize: 16, fontWeight: 800, color: rr.outcome === "you" ? "#ffd966" : rr.outcome === "tie" ? "#ccc" : "#caa6d8", marginBottom: 4 }}>
                {rr.showstopper ? "SHOWSTOPPER! You brought the house DOWN." :
                 rr.rivalShowstopper ? lsOpponent + " hit a SHOWSTOPPER on you!" :
                 rr.outcome === "you" ? "You took the round!" :
                 rr.outcome === "tie" ? "Dead even, the crowd is split." :
                 !rr.youOnVibe ? "Off the vibe. " + lsOpponent + " read the room and took it." :
                 lsOpponent + " edged that one."}
              </div>
              <button style={{ ...btn, marginTop: 8 }} onClick={nextRound}>
                {rr.final ? "Final Verdict" : "Next Round"}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === "lipsyncResult") {
    const won = lsResult && lsResult.won;
    return (
      <div style={wrap}>
        <Header />
        <div style={card}>
          <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>THE VERDICT</div>
          <div style={{ fontSize: 38, fontWeight: 900, color: won ? "#ffd966" : "#ff4d4d", margin: "12px 0", textShadow: won ? "0 0 24px #ffd96666" : "0 0 24px #ff4d4d66" }}>{won ? "SHANTAY, YOU STAY" : "SASHAY AWAY"}</div>
          <div style={{ display: "flex", justifyContent: "center", gap: 24, margin: "14px 0", fontSize: 15 }}>
            <span>You: <b style={{ color: "#d8b15a" }}>{lsResult ? lsResult.you : 0}</b></span>
            <span>{lsOpponent}: <b style={{ color: "#9d8fff" }}>{lsResult ? lsResult.rival : 0}</b></span>
          </div>
          <p style={{ fontSize: 15, lineHeight: 1.6, fontStyle: "italic" }}>{won ? "You left it all on that stage. The judges are gagged. You live to slay another week." : "The energy faded down the stretch. Now sashay away, but hold your head high, queen."}</p>
          <button style={btn} onClick={afterLipSync}>{won ? "Onward To Next Week" : "See The Damage"}</button>
        </div>
      </div>
    );
  }

  if (phase === "elimination") {
    if (!elim) return null;
    const stillIn = elim.remaining;
    return (
      <div style={wrap}>
        <Header />
        <div style={{ ...card, maxWidth: 480, borderColor: "rgba(216,177,90,0.45)" }}>
          <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 3, color: "#d8b15a" }}>THE TIME HAS COME</div>
          <div style={{ ...title, fontSize: 24, margin: "6px 0 2px" }}>SASHAY AWAY</div>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 14 }}>
            RuPaul has made the call. <b style={{ color: "#caa6d8" }}>{elim.name}</b>, your time in the werk room is over.
          </div>

          <div style={{ margin: "8px 0 14px", padding: "14px 16px", borderRadius: 12, background: "rgba(202,166,216,0.10)", border: "1px solid rgba(202,166,216,0.35)" }}>
            <div style={{ fontSize: 11, letterSpacing: 1, color: "#caa6d8", marginBottom: 6 }}>{elim.name.toUpperCase()}'S LAST WORDS</div>
            {elimLoading ? (
              <div style={{ fontSize: 13, opacity: 0.6, fontStyle: "italic" }}>She grabs the mic for one final read...</div>
            ) : (
              <div style={{ fontSize: 15.5, fontStyle: "italic", lineHeight: 1.55, color: "#f0e2f2" }}>"{elim.farewell}"</div>
            )}
          </div>

          <div style={{ margin: "0 0 16px", padding: "12px 14px", borderRadius: 12, background: "rgba(255,217,102,0.10)", border: "1px solid rgba(255,217,102,0.4)" }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "#ffe9b0", lineHeight: 1.5 }}>{elim.announce}</div>
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
              {stillIn} {stillIn === 1 ? "queen" : "queens"} still in the running for the crown.
            </div>
          </div>

          <button style={btn} onClick={continueFromElim}>
            {elimNext === "finale" ? "On To The Finale" : "Continue The Season"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "legacy") {
    const rr = legRoundResult;
    const lead = legYou - legRival;
    if (legStage === "intro") {
      return (
        <div style={wrap}>
          <Header />
          <div style={{ ...card, borderColor: "#ffd966" }}>
            <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>THE GRAND FINALE</div>
            <div style={{ ...title, fontSize: 30, marginTop: 4 }}>LIP SYNC FOR THE CROWN</div>
            <p style={{ fontSize: 15, lineHeight: 1.6, marginTop: 10 }}>
              It's down to you and <b style={{ color: "#d8b15a" }}>{finalist}</b>. One final lip sync decides the crown. This isn't survival, it's <b>the crown</b>.
            </p>
            <div style={{ margin: "12px auto", padding: "10px 16px", borderRadius: 999, display: "inline-block", background: "rgba(255,217,102,0.12)", border: "1px solid rgba(255,217,102,0.4)" }}>
              <span style={{ fontSize: 12, opacity: 0.7 }}>TONIGHT YOU LIP SYNC TO</span><br />
              <span style={{ fontSize: 17, fontWeight: 800, color: "#ffd966" }}>"{legSong}"</span>
            </div>
            <div style={{ textAlign: "left", fontSize: 13.5, lineHeight: 1.7, margin: "14px 0", opacity: 0.92 }}>
              You have a <b>stamina meter</b>. Five passages of the song.<br />
              <b>Hold Back</b>: small points, but you recover stamina<br />
              <b>Go All Out</b>: big points, burns stamina (weak if you're low)<br />
              <b>Crowning Moment</b>: one-time showstopper, save it for the finish<br />
              Outscore her by the final note to be crowned.
            </div>
            <button style={btn} onClick={() => setLegStage("play")}>Take The Stage</button>
          </div>
        </div>
      );
    }
    if (legStage === "done") {
      const won = legResult && legResult.won;
      return (
        <div style={wrap}>
          <Header />
          <div style={{ ...card, borderColor: won ? "#ffd966" : "rgba(216,177,90,0.4)" }}>
            <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>THE FINAL VERDICT</div>
            <div style={{ ...title, fontSize: 28 }}>{won ? "YOU TOOK THE CROWN" : "SO CLOSE"}</div>
            <div style={{ display: "flex", justifyContent: "center", gap: 24, margin: "14px 0", fontSize: 16 }}>
              <span>{dragName}: <b style={{ color: "#ffd966" }}>{legResult ? legResult.you : legYou}</b></span>
              <span>{finalist}: <b style={{ color: "#9d8fff" }}>{legResult ? legResult.rival : legRival}</b></span>
            </div>
            <p style={{ fontSize: 15, lineHeight: 1.6, fontStyle: "italic" }}>
              {won
                ? "You left it ALL on that stage and out-performed " + finalist + ". The crown is yours, superstar."
                : finalist + " edged you out by a whisker. A legendary run, but not the crown this time."}
            </p>
            <button style={{ ...btn, marginTop: 8 }} onClick={afterLegacy}>
              {won ? "Be Crowned" : "Take Your Bow"}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div style={wrap}>
        <Header />
        <div style={{ ...card, maxWidth: 480, borderColor: "#ffd966" }}>
          <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 2 }}>LIP SYNC FOR THE CROWN</div>
          <div style={{ fontSize: 13, opacity: 0.85, margin: "2px 0 2px" }}>vs <b style={{ color: "#d8b15a" }}>{finalist}</b> {"\u00B7"} Passage {Math.min(legRound + 1, LEG_ROUNDS)}/{LEG_ROUNDS}</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10, fontStyle: "italic" }}>"{legSong}"</div>

          <div style={{ display: "flex", justifyContent: "center", gap: 18, alignItems: "center", marginBottom: 10 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, opacity: 0.7 }}>{dragName}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#ffd966" }}>{legYou}</div>
            </div>
            <div style={{ fontSize: 13, opacity: 0.6 }}>{lead > 0 ? "ahead" : lead < 0 ? "behind" : "tied"}</div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 11, opacity: 0.7 }}>{finalist}</div>
              <div style={{ fontSize: 28, fontWeight: 900, color: "#9d8fff" }}>{legRival}</div>
            </div>
          </div>

          <div style={{ fontSize: 12, opacity: 0.8, textAlign: "left", marginBottom: 4 }}>Stamina: {legStamina}</div>
          <div style={{ width: "100%", height: 12, background: "rgba(255,255,255,0.1)", borderRadius: 999, overflow: "hidden", marginBottom: 14 }}>
            <div style={{ width: legStamina + "%", height: "100%", background: legStamina > 30 ? "linear-gradient(90deg,#4fdc7a,#ffd966)" : "linear-gradient(90deg,#ff5050,#caa6d8)", transition: "width 0.3s" }} />
          </div>

          {!rr ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button style={{ ...btn, background: "rgba(120,200,140,0.25)" }} onClick={() => legPlay("hold")}>Hold Back <span style={{ opacity: 0.7, fontSize: 13 }}>(+stamina, small points)</span></button>
              <button style={{ ...btn }} onClick={() => legPlay("allout")}>Go All Out <span style={{ opacity: 0.8, fontSize: 13 }}>(big points, -30 stamina)</span></button>
              <button style={{ ...btn, background: legMomentUsed ? "rgba(120,120,140,0.3)" : "linear-gradient(90deg,#ffd966,#ff9d3d)", color: legMomentUsed ? "#888" : "#3a1240", pointerEvents: legMomentUsed ? "none" : "auto" }} onClick={() => legPlay("moment")}>
                Crowning Moment {legMomentUsed ? "(used)" : "(one time only)"}
              </button>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", margin: "4px 0 10px" }}>
                <div style={{ flex: 1, padding: 10, borderRadius: 10, background: "rgba(255,217,102,0.12)", border: "1px solid rgba(255,217,102,0.4)" }}>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>You</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#ffd966" }}>+{rr.youGain}</div>
                </div>
                <div style={{ flex: 1, padding: 10, borderRadius: 10, background: "rgba(157,143,255,0.12)", border: "1px solid rgba(157,143,255,0.4)" }}>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>{finalist}</div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#9d8fff" }}>+{rr.rivalGain}</div>
                </div>
              </div>
              <p style={{ fontSize: 14, fontStyle: "italic", lineHeight: 1.5 }}>{rr.note}</p>
              <button style={{ ...btn, marginTop: 8 }} onClick={legNext}>{rr.final ? "The Final Verdict" : "Next Passage"}</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === "runnerup") {
    return (
      <div style={wrap}>
        <Header />
        <div style={card}>
          <div style={{ fontSize: 60 }}></div>
          <div style={{ ...title, fontSize: 30 }}>RUNNER-UP</div>
          <p style={{ fontSize: 15, lineHeight: 1.6 }}>
            You made it all the way to the final two and lip synced for the crown, but <b style={{ color: "#d8b15a" }}>{finalist}</b> took it this time. A legend in your own right, <b style={{ color: "#ffd966" }}>{dragName}</b>. So close to the throne you could taste it.
          </p>
          <EndRecap tone="runnerup" runStats={runStats} week={week} signoff={endSignoff} />
          <button style={{ ...btn, marginTop: 14 }} onClick={generateSeasonCast}>Run It Back</button>
        </div>
      </div>
    );
  }

  if (phase === "eliminated") {
    return (
      <div style={wrap}>
        <Header />
        <div style={card}>
          <div style={{ fontSize: 60 }}></div>
          <div style={{ ...title, fontSize: 30 }}>SASHAY AWAY</div>
          <p style={{ fontSize: 15, lineHeight: 1.6 }}>You made it to <b>Week {week}</b> before the lip sync did you in. Not every queen takes the crown, but every queen leaves a legacy, and the fans adored you, <b style={{ color: "#ffd966" }}>{dragName}</b>.</p>
          <EndRecap tone="eliminated" runStats={runStats} week={week} signoff={endSignoff} />
          <button style={{ ...btn, marginTop: 14 }} onClick={generateSeasonCast}>Run It Back</button>
        </div>
      </div>
    );
  }

  if (phase === "winner") {
    return (
      <div style={wrap}>
        <Header />
        <div style={{ ...card, borderColor: "#ffd966" }}>
          <div style={{ fontSize: 64 }}></div>
          <div style={{ ...title, fontSize: 34 }}>WINNER OF THE SEASON</div>
          <p style={{ fontSize: 16, lineHeight: 1.6 }}>You out-performed <b style={{ color: "#d8b15a" }}>{finalist}</b> in the Lip Sync For The Crown and snatched the crown. <b style={{ color: "#ffd966" }}>{dragName}</b>, you are the next drag superstar.</p>
          <EndRecap tone="winner" runStats={runStats} week={week} signoff={endSignoff} />
          <button style={{ ...btn, marginTop: 14 }} onClick={generateSeasonCast}>Defend The Crown</button>
        </div>
      </div>
    );
  }

  return null;
}
