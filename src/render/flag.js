// Rally-flag geometry, shared by the renderer (drawing the pennant) and the
// input layer (hit-testing clicks on it) so the clickable box always matches
// what's on screen. All sizes are device px derived from the camera zoom;
// `px` is the flag's pixel unit — it scales with zoom but stays legible far out.

// Reused record (allocation-free per frame): consume immediately, don't hold.
const m = { px: 0, poleW: 0, poleH: 0, flagW: 0, flagH: 0, ol: 0 };

export const flagMetrics = (zoom) => {
  const px = Math.max(2, Math.round(zoom * 0.5));
  m.px = px;
  m.poleW = Math.max(1, Math.round(px * 0.7));
  m.poleH = px * 7;
  m.flagW = px * 5;
  m.flagH = px * 3;
  m.ol = Math.max(1, px >> 1); // pennant/label outline thickness
  return m;
};
