// Central tuning knobs. Keep gameplay numbers here so the sim modules stay generic.

export const TICK_HZ = 33;              // fixed simulation rate
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_S = 1 / TICK_HZ;

export const MAX_UNITS = 20000;         // typed-array capacity (hard ceiling)

// The battlefield is a fixed world space, independent of the browser window.
// The canvas is just a viewport onto it (see render/camera.js).
export const WORLD_W = 3200;
export const WORLD_H = 2000;
export const MAX_ZOOM = 5;              // min zoom is derived so the view can't leave the world

// Vertical-slice army sizes. Bump these to stress-test the renderer/grid.
export const ARMY_SIZE = 2500;

// Steering / movement (world units per second).
export const MAX_SPEED = 42;
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

// Combat.
export const ATTACK_RANGE = 5;          // melee reach (world units)
export const ATTACK_DPS = 16;           // hp/sec dealt to the engaged target
export const FLEE_SPEED_MULT = 1.6;     // routing units run faster than they march

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
