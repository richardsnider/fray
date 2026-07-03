// Tiny seeded PRNG so a single seed reproduces a whole battle: terrain, spawn
// positions, and unit-type rolls. mulberry32 is fast, allocation-free, and good
// enough for game noise; hashSeed folds an arbitrary text seed into a 32-bit int.

export function mulberry32(a) {
  a >>>= 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a over the string → 32-bit seed, so "waterloo" and "42" both work.
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
