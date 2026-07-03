// Tiny seeded PRNG so a single seed reproduces a whole battle: terrain, spawn
// positions, and unit-type rolls. mulberry32 is fast, allocation-free, and good
// enough for game noise; hashSeed folds an arbitrary text seed into a 32-bit int.

// Returns a stateful generator function closing over its counter.
export const mulberry32 = (a) => {
  a >>>= 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// FNV-1a over the string → 32-bit seed, so "waterloo" and "42" both work.
export const hashSeed = (str) => {
  const s = String(str);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
