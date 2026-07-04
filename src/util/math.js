// Small pure math helpers shared across the sim and renderer. Dependency-free and
// hot-path-friendly — V8 inlines these across module boundaries, so pulling them
// out of the individual modules costs nothing at runtime and kills the copies of
// `lerp` / `clamp01` / index-clamping that had accreted in a half-dozen files.

export const lerp = (a, b, t) => a + (b - a) * t;

// Clamp v into [lo, hi].
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Clamp into the unit range [0, 1] — common for noise and interpolation params.
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Clamp a grid index into [0, len): the canonical "world coord → cell index"
// guard used by every spatial grid, flow field, and terrain lookup.
export const clampIndex = (i, len) => (i < 0 ? 0 : i >= len ? len - 1 : i);
