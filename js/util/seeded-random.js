/**
 * Small deterministic PRNG utilities, keyed off a string id — the same id
 * always produces the same sequence, so a star (or trash-shelf item)
 * derived from a project id lands in the same spot every time without
 * persisting anything. Shared by constellation-map.js and trash-library.js
 * so their scattered layouts use identical math.
 */

export function hashStringToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 — small, fast, deterministic PRNG keyed by a numeric seed. */
export function mulberry32(seed) {
  let a = seed;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience: a seeded PRNG for a given string, in one call. */
export function randomFor(id) {
  return mulberry32(hashStringToSeed(id));
}
