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
export const ATTACK_RANGE = 5;          // melee reach (world units). Per-archetype dps is ARCH_MELEE_DPS.
export const FLEE_SPEED_MULT = 1.6;     // routing units run faster than they march

// --- Archetypes: armor × weapon axes ------------------------------------------
// A unit is an armor tier × a weapon class × a mount flag (see
// docs/unit-rework-plan.md). Units carry a single archetype id (units.js
// `arch`); config flattens the axes into per-archetype ARCH_* lookup arrays at
// load, so hot-loop stat reads stay one indexed load and never recombine axes.
export const Armor = { NONE: 0, ARMORED: 1, HEAVY: 2 };
export const Weapon = { BLADE: 0, BLUNT: 1, POLEARM: 2, BOW: 3, LONGBOW: 4, LANCE: 5 };

// Armor trades speed for protection; a mount buys the pace back. Phase-1
// parity: armor doesn't slow anyone yet — the rework's target speed tiers land
// with the weapon matrix + balance harness — so every derived stat below
// matches the old TYPE_* tables exactly and a seed replays identically.
//                            NONE ARMORED HEAVY
export const ARMOR_HP     = [  65,    100,  150 ];  // starting hit points
export const ARMOR_SPEED  = [ 1.0,    1.0,  1.0 ];  // march-pace multiplier
export const MOUNT_SPEED  = 1.8;                    // pace multiplier when mounted

// The roster: adding an archetype is one line. Knights carry a generic BLADE
// until the lance mechanic lands (plan phase 4); weapons only pick sprites for
// now, damage still runs on the interim per-archetype tables below.
export const ARCHETYPES = [
  { name: 'knights',    armor: Armor.HEAVY,   weapon: Weapon.BLADE,   mounted: 1 },
  { name: 'longbowmen', armor: Armor.NONE,    weapon: Weapon.LONGBOW, mounted: 0 },
  { name: 'pikemen',    armor: Armor.ARMORED, weapon: Weapon.POLEARM, mounted: 0 },
];
export const ARCH_COUNT = ARCHETYPES.length;
export const Arch = Object.fromEntries(ARCHETYPES.map((a, i) => [a.name.toUpperCase(), i]));

// Flattened per-archetype lookups (plain arrays keep the stats full-precision).
export const ARCH_ARMOR   = ARCHETYPES.map((a) => a.armor);
export const ARCH_WEAPON  = ARCHETYPES.map((a) => a.weapon);
export const ARCH_MOUNTED = ARCHETYPES.map((a) => a.mounted);
export const ARCH_HP      = ARCHETYPES.map((a) => ARMOR_HP[a.armor]);
export const ARCH_SPEED   = ARCHETYPES.map((a) => ARMOR_SPEED[a.armor] * (a.mounted ? MOUNT_SPEED : 1));

// Interim combat tables, keyed per archetype. They die in phase 2, replaced by
// WEAPON_DPS × WEAPON_VS_ARMOR — protection moves into the matrix and stops
// being a generic damage reduction.
//                               knights longbowmen pikemen
export const ARCH_MELEE_DPS  = [    18,       4,      14  ];  // hp/sec in melee reach
export const ARCH_DMG_REDUCE = [  0.45,    0.10,    0.30  ];  // fractional incoming-dmg reduction

// Rock-paper-scissors: multiplier applied to damage from attacker → target
// (melee and ranged), roughly pike > cavalry > archers > pike. Dies in phase 2.
//                            target: knights longbowmen pikemen
export const DMG_MULT = [
  /* knights    attack */         [    1.0,     1.6,    0.55 ],
  /* longbowmen attack */         [    0.6,     1.0,    1.35 ],
  /* pikemen    attack */         [    1.7,    0.85,    1.0  ],
];

// Longbows: massed area fire (see sim/archery.js). A ready archer volleys at
// the densest enemy cell of the aim grid within range — the beaten zone — and
// the arrows land ARROW_FLIGHT seconds later on whoever is standing there,
// friend or foe, damage split across the cell's occupants and reduced by armor,
// the RPS multiplier, and brush cover (the cover-vs-archers mechanic).
export const ARCHER_RANGE = 110;        // bow reach (world units)
export const ARCHER_RELOAD = 1.4;       // seconds between volleys (keep > ARROW_FLIGHT)
export const ARCHER_SHOT_DMG = 30;      // base damage per volley
export const ARROW_COVER = 0.7;         // max fractional arrow reduction in dense brush
export const AIM_CELL = 32;             // beaten-zone cell size (world units)
export const ARROW_FLIGHT = 0.8;        // arrow flight time (seconds) before impact
export const ARCHER_RESCAN = 0.25;      // retry delay when no enemy is in bow range

// Army composition — fraction of each spawned army by archetype (must sum to ~1).
//                     knights longbowmen pikemen
export const ARMY_MIX = [0.20,      0.30,   0.50];

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
