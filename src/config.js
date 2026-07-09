// Central tuning knobs. Keep gameplay numbers here so the sim modules stay generic.

const TICK_HZ = 33;                     // fixed simulation rate (derivation base)
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_S = 1 / TICK_HZ;      // per-tick delta in seconds

export const MAX_UNITS = 20000;         // typed-array capacity (hard ceiling)

// The battlefield is a fixed world space, independent of the browser window.
// The canvas is just a viewport onto it (see render/camera.js).
export const WORLD_W = 3200;
export const WORLD_H = 2000;
export const MAX_ZOOM = 4;              // CSS px per world unit at full zoom-in (camera scales it by DPR); min zoom is derived so the view can't leave the world

// Armies are bought from a points budget (docs/unit-rework-plan.md §7): each
// archetype has a cost, ARMY_MIX below says what share of the budget goes to
// each, and the spawner fields as many units as the share affords. Bump the
// budget to stress-test the renderer/grid.
export const ARMY_BUDGET = 14000;

// Steering / movement. SEEK_ACCEL + DAMPING set the base march velocity a unit
// eases to; per-archetype pace is then a direct multiplier on travel (ARCH_SPEED).
export const SEEK_ACCEL = 90;
export const SEP_RADIUS = 6;            // also the spatial-grid cell size
export const SEP_ACCEL = 220;
export const DAMPING = 0.86;            // per-tick velocity retention
export const MAX_STEER_SPEED = 45;      // safety ceiling on raw steering velocity so a tight press can't fling units

// Terrain. Stored on a coarse grid (one cell per TERRAIN_CELL world units) and
// sampled by both the sim and the renderer.
export const TERRAIN_CELL = 16;
export const WATER_LEVEL = 0.30;        // elevation below this is impassable water
export const MUD_BAND = 0.05;           // elevation band above the waterline that bakes to mud
export const MUD_SLOW = 0.5;            // fractional slowdown in mud — like brush but wetter,
                                        // and no cover benefit: soft ground, nothing to hide in
export const SLOPE_SPEED = 26;          // uphill slows / downhill speeds movement
export const BRUSH_SPEED_CAP = 9;       // brush caps ground speed instead of scaling it: travel
                                        // ≤ this / cover density (world units/sec) — unbounded in
                                        // the open, and in a thicket every archetype converges on
                                        // the same crawl, so a mount's pace advantage dies with
                                        // the room to run (the todo's "reduce MAX speed")
export const HEIGHT_DMG = 2.0;          // downhill melee damage bonus scale
export const WATER_LOOK = 22;           // look-ahead distance for shoreline avoidance
export const WATER_AVOID = 160;         // steering force away from water ahead

// Combat.
export const FLEE_SPEED_MULT = 1.6;     // routing units run faster than they march

// Polearm profile (rework2 plan B §2–3): damage is a hard band — full rate
// between POLEARM_BAND and max reach, zero inside it — and the wielder holds
// at standoff instead of pressing to contact, so formation depth is
// mechanically real: rank 2 fights over rank 1's shoulder, while a blade that
// burrows past the points faces harmless pikes. On top of the band, the
// impalement rule: damage scales with the victim's own closing speed onto the
// point (the lance rule run in reverse — impact energy goes as v², and it's
// the target bringing the speed). A galloping horse impales itself; a walking
// one is merely fended; a *standing* knight is an ordinary target — no mount
// check anywhere, cavalry just happens to arrive fastest.
export const POLEARM_BAND = 0.55;       // fraction of reach where the damage band starts —
                                        // floor ~6 at reach 11: blade contact (~5) sits in the
                                        // dead zone, but a press that interpenetrates the block
                                        // stays in reach of the pikes one rank deeper (6–11)
export const STANDOFF_FRAC = 0.85;      // fraction of reach a polearm holds at while engaged:
                                        // mid-band, so formation jitter can't flicker the
                                        // target across the band floor into the dead zone
export const IMPALE_MULT = 3;           // impalement scale: dmg × (1 + this × closingFrac²),
                                        // closingFrac normalized to *unmounted* full march —
                                        // a charging knight reaches ~1.26, light horse ~1.8
export const POLEARM_BRUSH = 0.9;       // max fractional polearm dps cut in dense brush:
                                        // no room to work a 16-foot shaft between trees

// Lance profile (docs/unit-rework-plan.md §3): damage scales with the
// striker's actual per-tick travel — the real displacement after terrain and
// pace, not the capped steering velocity — so the run-up is the movement model
// itself: a knight arriving at gallop deals several times the standing rate
// for the few ticks before the press bleeds his speed, and one milling in a
// melee holds the worst weapon in the game. No meter, no stored state.
export const LANCE_SPEED_MULT = 8;      // damage multiplier at full gallop: rate × (1 + frac × this)

// --- Archetypes: armor × weapon axes ------------------------------------------
// A unit is an armor tier × a weapon class × a mount flag (see
// docs/unit-rework-plan.md). Units carry a single archetype id (units.js
// `arch`); config flattens the axes into per-archetype ARCH_* lookup arrays at
// load, so hot-loop stat reads stay one indexed load and never recombine axes.
const Armor = { NONE: 0, ARMORED: 1, HEAVY: 2 };
export const Weapon = { BLADE: 0, BLUNT: 1, POLEARM: 2, BOW: 3, LONGBOW: 4, LANCE: 5 };

// Armor trades speed for protection; a mount buys the pace back. Protection
// lives entirely in WEAPON_VS_ARMOR below — armor applies no generic damage
// reduction (one mechanism, no double counting). Heavy + mounted → 1.8 × 0.70
// = 1.26: an expensive unit only a little faster than unarmored infantry.
// (Consumed below when flattening ARCHETYPES — the sim reads only ARCH_*.)
//                     NONE ARMORED HEAVY
const ARMOR_HP     = [  70,    105,  150 ];  // starting hit points
const ARMOR_SPEED  = [ 1.0,   0.85, 0.70 ];  // march-pace multiplier
const MOUNT_SPEED  = 1.8;                    // pace multiplier when mounted

// Weapons own damage, reach, and how each interacts with armor. Melee is a
// continuous rate (hp/sec against the closest enemy — plan §3); bows are
// volley events (VOLLEY_* below + sim/archery.js) with dps 0 here, and their
// WEAPON_RANGE entry is volley range.
// Weapon:                  BLADE BLUNT POLEARM BOW LONGBOW LANCE
export const WEAPON_RANGE = [   5,    5,     11,  70,   110,    6 ]; // reach (world units)
export const WEAPON_DPS   = [  16,   14,     22,   0,     0,   13 ]; // melee hp/sec; 0 = doesn't melee
// Polearm 22 is a braced foot pike in its damage band — the deadliest melee in
// the game (and zero inside the points, see the hard band). Lance means
// lance *and sword* (rework2 plan B §4): 13 standing is the sword arm of a
// lancer milling in the press — respectable, under a foot blade's 16 for the
// cramped seat — while the LANCE_SPEED_MULT scale is the lance point itself
// (~117 hp/sec for the moments a gallop contact lasts).

// Weapon-vs-armor damage multiplier — the whole protection story, applied to
// melee and to arrow impacts. Replaces the old RPS type matrix: matchups fall
// out of how weapons meet armor, reach, and ground, not an authored counter chart.
//                             vs NONE  vs ARMORED  vs HEAVY
export const WEAPON_VS_ARMOR = [
  /* BLADE   */             [    1.3,      0.85,      0.6  ], // cuts notch on mail
  /* BLUNT   */             [    1.0,      1.1,       1.3  ],
  /* POLEARM */             [    1.0,      1.0,       1.0  ], // power is in reach, not matchup
  /* BOW     */             [    1.0,      0.35,      0.0  ], // shortbow: mail mostly stops it, plate ignores it
  /* LONGBOW */             [    1.3,      1.0,       0.5  ], // defeats mail, not plate
  /* LANCE   */             [    1.2,      0.85,      0.75 ], // × the speed scale (LANCE_SPEED_MULT)
];

// Bow classes — both fire beaten-zone volleys (sim/archery.js); the class sets
// the volley numbers and the movement rules. Shortbows volley on the move (a
// mounted BOW archetype is a horse archer for free); a longbow may only loose
// after standing LONGBOW_SET seconds — its stillness clock (units.js `still`)
// zeroes on any real movement — so repositioning a longbow line is a real
// commitment, plant it early. Neither class shoots with an enemy at arm's
// length (the pressed rule, world.js → archery.js) or drops a beaten zone
// nearer than its minimum range: a bow is nothing in a melee, which is how
// massed ranged loses to anything that reaches it (rework2 plan B §3).
export const BowClass = { BOW: 0, LONGBOW: 1 };
//                             BOW LONGBOW
export const VOLLEY_DMG    = [  14,     30 ];  // damage per volley
export const VOLLEY_RELOAD = [ 0.9,    1.6 ];  // seconds between volleys (keep > ARROW_FLIGHT:
                                               // at most one volley per archer in the air, so the
                                               // pending-impact ring buffer can never overflow)
export const BOW_MIN_RANGE = [  12,     40 ];  // no beaten zone nearer than this. Cell-granular —
                                               // the aim search rejects cell centers inside it —
                                               // so true adjacency is the pressed rule's job
export const LONGBOW_SET   = 1.6;       // seconds standing before a longbow may loose
export const LONGBOW_STILL = 8;         // speed (world units/sec) that still counts as standing:
                                        // above the ~7 u/s a formed-up unit jitters around its
                                        // formation slot, well below the ~16 u/s open-ground march
const MOUNT_ARROW_MULT = 1.4;           // arrow damage vs mounted below HEAVY armor: unbarded
                                        // horses die to massed arrows; barding shrugs them off
                                        // (consumed by ARCH_ARROW_MULT below; the sim reads that)

// The roster: adding an archetype is one line. Cost is the price in army
// points (see ARMY_BUDGET) — what a soldier of that line costs to raise and
// keep: gear on his back plus the training and horseflesh behind it. A knight
// is a destrier, barding, plate, and a lifetime in the saddle; a levy is a
// blade and a shove into the line. First drafts, tuned against
// `npm run balance:matrix` (equal budget per side).
export const ARCHETYPES = [
  { name: 'knights',       armor: Armor.HEAVY,   weapon: Weapon.LANCE,   mounted: 1, cost: 14 },
  { name: 'longbowmen',    armor: Armor.NONE,    weapon: Weapon.LONGBOW, mounted: 0, cost: 4 },
  { name: 'pikemen',       armor: Armor.ARMORED, weapon: Weapon.POLEARM, mounted: 0, cost: 4 },
  { name: 'skirmishers',   armor: Armor.NONE,    weapon: Weapon.BOW,     mounted: 0, cost: 3 },
  { name: 'levy',          armor: Armor.NONE,    weapon: Weapon.BLADE,   mounted: 0, cost: 3 },
  { name: 'sergeants',     armor: Armor.ARMORED, weapon: Weapon.BLUNT,   mounted: 0, cost: 4 },
  { name: 'light horse',   armor: Armor.NONE,    weapon: Weapon.BLADE,   mounted: 1, cost: 4 },
  // The rest of the stable (rework2 plan B §6) — every cavalry armament from
  // the original scratch note is fielded: bow, blunt, and spear on horseback.
  { name: 'horse archers', armor: Armor.NONE,    weapon: Weapon.BOW,     mounted: 1, cost: 6 },
  { name: 'mtd sergeants', armor: Armor.ARMORED, weapon: Weapon.BLUNT,   mounted: 1, cost: 7 },
  { name: 'hobilars',      armor: Armor.ARMORED, weapon: Weapon.POLEARM, mounted: 1, cost: 5 },
];
export const ARCH_COUNT = ARCHETYPES.length;

// How a mount changes a melee weapon. A rider's blade or mace strikes *down*
// from the saddle with gravity behind it — but the saddle bonus is open-ground
// work: it needs room to ride past and swing, so the melee loop fades it with
// the rider's brush cover (ARCH_MOUNT_MELEE below carries the bonus fraction;
// in a thicket a horseman hacks among branches like anyone else). A rider's
// spear keeps its full reach and thrust rate (the old 0.6 rate penalty is
// retired — the band + thin ranks already lose mounted spears every foot
// melee), but can't-brace lives on as the real rule: only *foot* polearms
// earn the impalement charge spike (world.js) — setting a point against a
// charge takes planted feet, so a spear hedge on horseback fends but never
// skewers, and knights ride through hobilars while dying on pikemen.
const POLEARM_MOUNT_MULT = 1.0;
const MOUNT_MELEE_MULT = 1.5;

// Flattened per-archetype lookups (plain arrays keep the stats full-precision).
export const ARCH_ARMOR   = ARCHETYPES.map((a) => a.armor);
export const ARCH_COST    = ARCHETYPES.map((a) => a.cost);
export const ARCH_WEAPON  = ARCHETYPES.map((a) => a.weapon);
export const ARCH_MOUNTED = ARCHETYPES.map((a) => a.mounted);
export const ARCH_HP      = ARCHETYPES.map((a) => ARMOR_HP[a.armor]);
export const ARCH_SPEED   = ARCHETYPES.map((a) => ARMOR_SPEED[a.armor] * (a.mounted ? MOUNT_SPEED : 1));
export const ARCH_MELEE_DPS = ARCHETYPES.map((a) =>
  WEAPON_DPS[a.weapon] * (a.mounted && a.weapon === Weapon.POLEARM ? POLEARM_MOUNT_MULT : 1));
export const ARCH_MOUNT_MELEE = ARCHETYPES.map((a) => // saddle bonus as a fraction over 1 —
  a.mounted && (a.weapon === Weapon.BLADE || a.weapon === Weapon.BLUNT)
    ? MOUNT_MELEE_MULT - 1 : 0);                      // the melee loop fades it with brush cover
export const ARCH_BOW_CLASS = ARCHETYPES.map((a) =>       // -1 = not a bow archetype
  a.weapon === Weapon.BOW ? BowClass.BOW : a.weapon === Weapon.LONGBOW ? BowClass.LONGBOW : -1);
export const ARCH_ARROW_MULT = ARCHETYPES.map((a) =>      // per-victim arrow impact multiplier
  a.mounted && a.armor < Armor.HEAVY ? MOUNT_ARROW_MULT : 1);

// Bows: massed area fire (see sim/archery.js). A ready archer volleys at the
// densest enemy cell of the aim grid within range — the beaten zone — and the
// arrows land ARROW_FLIGHT seconds later on whoever is standing there, friend
// or foe, damage split across the cell's occupants. The weapon-vs-armor matrix
// and brush cover apply on impact; the shooter's own cover reduces the volley
// at launch (arrows into or out of brush both suffer).
export const ARROW_COVER = 0.7;         // max fractional arrow reduction in dense brush
export const AIM_CELL = 32;             // beaten-zone cell size (world units)
export const ARROW_FLIGHT = 0.8;        // arrow flight time (seconds) before impact
export const ARCHER_RESCAN = 0.25;      // retry delay when no enemy is in bow range

// Army composition — share of the army budget spent on each archetype (must
// sum to ~1). Shares divide by cost to become head counts, so an equal share
// buys far fewer knights than levies — the mix reads as a muster roll's purse,
// not a head count.
//                     knights longbowmen pikemen skirmishers levy sergeants light horse h.archers mtd serg hobilars
export const ARMY_MIX = [0.12,      0.15,   0.18,       0.05, 0.16,    0.10,       0.05,     0.07,    0.05,    0.07];

// Deployment: each army spawns as clustered squads of a single archetype (a block of
// pike, a body of archers, a squadron of horse) rather than one intermixed soup,
// so formations read as coherent groups. A squad is ~SQUAD_SIZE units scattered
// in a SQUAD_RADIUS disk around a random deploy point in the army's zone.
export const SQUAD_SIZE = 500;          // units per single-type cluster
export const SQUAD_RADIUS = 70;         // world-unit radius a squad scatters over

// --- Formations ---------------------------------------------------------------
// Each rally flag carries a formation type; its followers hold slots in a
// rank-and-file grid oriented to the flag's facing (sim/formation.js), so a
// squad settles into ranks instead of a ball. Width is cols ≈ sqrt(n · aspect)
// — aspect is the block's width:depth ratio. Spacing is the slot pitch in world
// units: keep it ≥ SEP_RADIUS so separation goes quiet in a formed-up squad.
// Spacing 0 means unslotted — every follower seeks the bare flag point (the old
// clump, kept as FLUID for a march that prioritizes flow over order). Nothing
// switches formations yet; the type exists so the player UI and the AI director
// can (wedge etc. add a slot-layout branch in sim/formation.js).
export const Formation = { BLOCK: 0, LINE: 1, LOOSE: 2, FLUID: 3 };
//                             BLOCK LINE LOOSE FLUID
export const FORM_ASPECT   = [  2.0, 8.0,  2.0,    0 ];
export const FORM_SPACING  = [    8,   8,   14,    0 ];
export const REFORM_TICKS = 66;         // ~2 s between slot re-deals: closes ranks over casualty gaps
export const FACING_EPS = 4;            // min flag displacement (world units) before facing re-derives

// Morale / routing. Morale is 0..MORALE_MAX; below ROUT it breaks, and a broken
// unit must recover past RALLY to re-form.
export const MORALE_MAX = 100;
export const ROUT_THRESHOLD = 25;
export const RALLY_THRESHOLD = 55;
export const MORALE_REGEN = 7;          // /sec when no enemy is near
export const FEAR_OUTNUMBERED = 9;      // /sec per net enemy in the local melee
export const FEAR_PANIC = 16;           // /sec per routing friend nearby (contagion)
export const HIT_FEAR = 0.7;            // morale lost per point of damage taken

// Team colors [r, g, b].
export const TEAM_COLORS = [
  [225, 228, 240],  // 0: silver
  [206, 66, 52],    // 1: red
];
