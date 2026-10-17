// ============================================================================
//  VOTERS' BOARD. Pure functions, no Firebase. Filled in from step 2 of the
//  voting upgrade (buildBoard, buildHistory); for now only the comparison
//  helper the board will use.
// ============================================================================

// Canonical form of a value for comparing two boards: keys sorted, undefined
// dropped, and every time field left out (any key ending in "At"), because
// times change nothing voters act on.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    Object.keys(v).sort().forEach((k) => {
      if (/At$/.test(k) || v[k] === undefined) return;
      out[k] = canonical(v[k]);
    });
    return out;
  }
  return v;
}
export function sameBoard(a, b) { return JSON.stringify(canonical(a || null)) === JSON.stringify(canonical(b || null)); }
