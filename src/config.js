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

// Vertical-slice army sizes. Bump these to stress-test the renderer/grid.
export const ARMY_SIZE = 2500;

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
export const SLOPE_SPEED = 26;          // uphill slows / downhill speeds movement
export const COVER_SLOW = 0.45;         // max fractional slowdown in dense brush
export const HEIGHT_DMG = 2.0;          // downhill melee damage bonus scale
export const WATER_LOOK = 22;           // look-ahead distance for shoreline avoidance
export const WATER_AVOID = 160;         // steering force away from water ahead

// Combat.
export const FLEE_SPEED_MULT = 1.6;     // routing units run faster than they march

// Polearm profile (docs/unit-rework-plan.md §3): damage scales with distance to
// the target — full rate near max reach, almost nothing adjacent — and the
// wielder holds at standoff instead of pressing to contact, so formation depth
// is mechanically real: rank 2 fights over rank 1's shoulder, while blades
// that burrow past the points face near-harmless pikes.
export const POLEARM_MIN = 0.05;        // damage fraction when adjacent
export const POLEARM_FULL_FRAC = 0.75;  // fraction of reach where the profile hits full rate
export const STANDOFF_FRAC = 0.7;       // fraction of reach a polearm holds at while engaged
export const POLEARM_VS_MOUNT = 1.5;    // polearm damage multiplier vs mounted: a set pike
                                        // stops the horse — a big target barding can't save
                                        // from a braced point (melee analog of MOUNT_ARROW_MULT)

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
// WEAPON_RANGE entry is volley range. Lance reads as generic melee until
// phase 4's speed scale.
// Weapon:                  BLADE BLUNT POLEARM BOW LONGBOW LANCE
export const WEAPON_RANGE = [   5,    5,     11,  70,   110,    6 ]; // reach (world units)
export const WEAPON_DPS   = [  16,   14,     18,   0,     0,    8 ]; // melee hp/sec; 0 = doesn't melee
// Polearm 18 is a braced foot pike at full reach — the deadliest melee in the
// game (and near zero adjacent, see the reach profile). Lance 8 is the rate
// *standing*: deliberately below even an unbraced mounted polearm, because a
// lance is nothing without speed — phase 4's speed scale is its whole value.

// Weapon-vs-armor damage multiplier — the whole protection story, applied to
// melee and to arrow impacts. Replaces the old RPS type matrix: matchups fall
// out of how weapons meet armor, reach, and ground, not an authored counter chart.
//                             vs NONE  vs ARMORED  vs HEAVY
export const WEAPON_VS_ARMOR = [
  /* BLADE   */             [    1.3,      0.85,      0.6  ], // cuts notch on mail
  /* BLUNT   */             [    1.0,      1.1,       1.3  ],
  /* POLEARM */             [    1.0,      1.0,       1.0  ], // power is in reach, not matchup
  /* BOW     */             [    1.0,      0.55,      0.15 ], // shortbow: armor shrugs it off
  /* LONGBOW */             [    1.3,      1.0,       0.5  ], // defeats mail, not plate
  /* LANCE   */             [    1.2,      1.0,       0.9  ], // × speed scale (phase 4)
];

// Bow classes — both fire beaten-zone volleys (sim/archery.js); the class sets
// the volley numbers and the movement rule. Shortbows volley on the move (a
// mounted BOW archetype is a horse archer for free); a longbow's reload counts
// down only while standing, and any movement restarts it in full (world.js) —
// repositioning a longbow line is a real commitment, plant it early.
export const BowClass = { BOW: 0, LONGBOW: 1 };
//                             BOW LONGBOW
export const VOLLEY_DMG    = [  14,     30 ];  // damage per volley
export const VOLLEY_RELOAD = [ 0.9,    1.6 ];  // seconds between volleys (keep > ARROW_FLIGHT:
                                               // at most one volley per archer in the air, so the
                                               // pending-impact ring buffer can never overflow)
export const LONGBOW_STILL = 8;         // speed (world units/sec) that still counts as standing:
                                        // above the ~7 u/s a formed-up unit jitters around its
                                        // formation slot, well below the ~16 u/s open-ground march
export const MOUNT_ARROW_MULT = 1.4;    // arrow damage vs mounted below HEAVY armor: unbarded
                                        // horses die to massed arrows; barding shrugs them off

// The roster: adding an archetype is one line. Knights carry a generic BLADE
// until the lance mechanic lands (plan phase 4).
export const ARCHETYPES = [
  { name: 'knights',     armor: Armor.HEAVY,   weapon: Weapon.BLADE,   mounted: 1 },
  { name: 'longbowmen',  armor: Armor.NONE,    weapon: Weapon.LONGBOW, mounted: 0 },
  { name: 'pikemen',     armor: Armor.ARMORED, weapon: Weapon.POLEARM, mounted: 0 },
  { name: 'skirmishers', armor: Armor.NONE,    weapon: Weapon.BOW,     mounted: 0 },
];
export const ARCH_COUNT = ARCHETYPES.length;
export const Arch = Object.fromEntries(ARCHETYPES.map((a, i) => [a.name.toUpperCase(), i]));

// A rider's spear keeps the reach but can't brace: mounted polearms thrust
// one-handed at a fraction of the foot pike's rate. Baked into the flattened
// per-archetype dps below so the hot loop still makes one indexed read.
const POLEARM_MOUNT_MULT = 0.6;

// Flattened per-archetype lookups (plain arrays keep the stats full-precision).
export const ARCH_ARMOR   = ARCHETYPES.map((a) => a.armor);
export const ARCH_WEAPON  = ARCHETYPES.map((a) => a.weapon);
export const ARCH_MOUNTED = ARCHETYPES.map((a) => a.mounted);
export const ARCH_HP      = ARCHETYPES.map((a) => ARMOR_HP[a.armor]);
export const ARCH_SPEED   = ARCHETYPES.map((a) => ARMOR_SPEED[a.armor] * (a.mounted ? MOUNT_SPEED : 1));
export const ARCH_MELEE_DPS = ARCHETYPES.map((a) =>
  WEAPON_DPS[a.weapon] * (a.mounted && a.weapon === Weapon.POLEARM ? POLEARM_MOUNT_MULT : 1));
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

// Army composition — fraction of each spawned army by archetype (must sum to ~1).
//                     knights longbowmen pikemen skirmishers
export const ARMY_MIX = [0.20,      0.25,   0.40,       0.15];

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
