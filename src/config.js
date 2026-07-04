// Central tuning knobs. Keep gameplay numbers here so the sim modules stay generic.

const TICK_HZ = 33;                     // fixed simulation rate (derivation base)
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_S = 1 / TICK_HZ;      // per-tick delta in seconds

export const MAX_UNITS = 20000;         // typed-array capacity (hard ceiling)

// The battlefield is a fixed world space, independent of the browser window.
// The canvas is just a viewport onto it (see render/camera.js).
export const WORLD_W = 3200;
export const WORLD_H = 2000;
export const MAX_ZOOM = 5;              // min zoom is derived so the view can't leave the world

// Vertical-slice army sizes. Bump these to stress-test the renderer/grid.
export const ARMY_SIZE = 2500;

// Steering / movement (world units per second). Per-type march speed is TYPE_SPEED.
export const SEEK_ACCEL = 90;
export const SEP_RADIUS = 6;            // also the spatial-grid cell size
export const SEP_ACCEL = 220;
export const DAMPING = 0.86;            // per-tick velocity retention

// Terrain. Stored on a coarse grid (one cell per TERRAIN_CELL world units) and
// sampled by both the sim and the renderer.
export const TERRAIN_CELL = 16;
export const WATER_LEVEL = 0.30;        // elevation below this is impassable water
export const SLOPE_SPEED = 26;          // uphill slows / downhill speeds movement
export const COVER_SLOW = 0.45;         // max fractional slowdown in dense brush
export const HEIGHT_DMG = 2.0;          // downhill melee damage bonus scale
export const WATER_LOOK = 22;           // look-ahead distance for shoreline avoidance
export const WATER_AVOID = 160;         // steering force away from water ahead

// Flow-field pathfinding. One field per team routes around impassable water
// toward the team objective; recomputed every few ticks and shared by all units.
export const FLOW_CELL = 24;            // world units per pathfinding cell
export const FLOW_UPDATE_TICKS = 8;     // recompute cadence (~4x/sec at 33Hz)

// Combat.
export const ATTACK_RANGE = 5;          // melee reach (world units). Per-type dps is TYPE_MELEE_DPS.
export const FLEE_SPEED_MULT = 1.6;     // routing units run faster than they march

// --- Unit types -------------------------------------------------------------
// Three pre-gunpowder roles. Stats are small const arrays indexed by UnitType so
// the hot loop reads stay cheap and balancing is a one-table edit.
export const UnitType = { KNIGHT: 0, ARCHER: 1, PIKE: 2 };
export const UNIT_TYPE_COUNT = 3;

//                          KNIGHT ARCHER  PIKE
export const TYPE_HP        = [150,   65,   100];  // starting hit points
export const TYPE_SPEED     = [ 72,   40,    40];  // max march speed (world u/s)
export const TYPE_MELEE_DPS = [ 18,    4,    14];  // hp/sec in melee reach
export const TYPE_ARMOR     = [0.45, 0.10,  0.30]; // fractional incoming-dmg reduction

// Rock-paper-scissors: multiplier applied to damage from attacker → target
// (melee and ranged). Roughly pike > cavalry > archers > pike.
//                              target: KNIGHT ARCHER  PIKE
export const DMG_MULT = [
  /* KNIGHT attacks */         [   1.0,   1.6,  0.55 ],
  /* ARCHER attacks */         [   0.6,   1.0,  1.35 ],
  /* PIKE   attacks */         [   1.7,  0.85,  1.0  ],
];

// Longbows: hitscan. A ready archer picks the nearest enemy in range each reload
// and applies one arrow's damage, reduced by the target's armor, RPS multiplier,
// and brush cover (the cover-vs-archers mechanic).
export const ARCHER_RANGE = 110;        // bow reach (world units)
export const ARCHER_RELOAD = 1.4;       // seconds between shots
export const ARCHER_SHOT_DMG = 30;      // base damage per arrow
export const ARROW_COVER = 0.7;         // max fractional arrow reduction in dense brush

// Cavalry charge: a transient impact bonus when a fast-moving horse contacts an
// enemy head-on after a straight run, then a recovery cooldown. Braced pikes
// (target === PIKE) negate the charge — that is what makes pike > cavalry.
export const CHARGE_MIN_SPEED = 50;     // must be moving this fast to charge
export const CHARGE_DMG = 4.5;          // melee-damage multiplier on the impact tick
export const CHARGE_MORALE = 24;        // morale shock dealt to the struck enemy
export const CHARGE_COOLDOWN = 3.0;     // seconds before a horse can charge again

// Army composition — fraction of each spawned army by type (must sum to ~1).
//                          KNIGHT ARCHER PIKE
export const ARMY_MIX = [0.20, 0.30, 0.50];

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
