// Player command + camera control layer.
//   left click        → order your (team 0) army to a world point
//   right-drag / MMB   → pan the camera
//   wheel              → zoom toward the cursor
//   W/A/S/D or arrows  → pan the camera
//
// createInput() wires the DOM listeners and returns { update } to call per frame.

import * as Camera from '../render/camera.js';

const PAN_KEYS_SPEED = 900; // world units/sec at zoom 1

export const create = (canvas, cam, world) => {
  const keys = new Set();
  let dragging = false;
  let lastX = 0, lastY = 0;

  // Positions in canvas backing-store px, not CSS px — the camera's screen
  // space is the DPR-scaled canvas resolution.
  const localPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const s = canvas.width / rect.width;
    return { x: (e.clientX - rect.left) * s, y: (e.clientY - rect.top) * s };
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    const p = localPos(e);
    // Left click: command in world coords. Middle/right: start a pan drag.
    e.button === 0
      ? world.setManualTarget(Camera.screenToWorldX(cam, p.x), Camera.screenToWorldY(cam, p.y))
      : (e.button === 1 || e.button === 2) && (dragging = true, lastX = p.x, lastY = p.y);
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const p = localPos(e);
    Camera.panByScreen(cam, p.x - lastX, p.y - lastY);
    lastX = p.x;
    lastY = p.y;
  });

  window.addEventListener('mouseup', () => { dragging = false; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPos(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    Camera.zoomAt(cam, factor, p.x, p.y);
  }, { passive: false });

  // Ignore keys while typing in a form field (e.g. the seed box) so WASD text
  // doesn't pan the camera.
  const typing = (e) => {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  window.addEventListener('keydown', (e) => { !typing(e) && keys.add(e.key.toLowerCase()); });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // Apply held-key panning and ease the camera toward its target; call once per
  // rendered frame. dt is in seconds.
  const update = (dt) => {
    let dx = 0, dy = 0;
    (keys.has('a') || keys.has('arrowleft')) && (dx -= 1);
    (keys.has('d') || keys.has('arrowright')) && (dx += 1);
    (keys.has('w') || keys.has('arrowup')) && (dy -= 1);
    (keys.has('s') || keys.has('arrowdown')) && (dy += 1);
    const speed = PAN_KEYS_SPEED * dt;
    (dx || dy) && Camera.panByWorld(cam, dx * speed, dy * speed);
    Camera.smooth(cam, dt);
  };

  return { update };
};
