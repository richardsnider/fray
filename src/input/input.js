// Player command + camera control layer.
//   left-drag          → selection box: pick your (team 0) units inside it
//   left-click a flag  → select every unit that follows that (friendly) rally
//   left-click ground  → order the current selection there (moves/mints its flag)
//   right-drag / MMB   → pan the camera
//   wheel              → zoom toward the cursor
//   W/A/S/D or arrows  → pan the camera
//
// createInput() wires the DOM listeners and returns { update, getSelectionBox }.

import * as Camera from '../render/camera.js';

const PAN_KEYS_SPEED = 900; // world units/sec at zoom 1
const CLICK_SLOP = 6;       // device px of travel below which a left-drag is a click, not a box

export const create = (canvas, cam, world) => {
  const keys = new Set();
  let dragging = false;             // right/middle pan drag
  let lastX = 0, lastY = 0;
  let selecting = false;            // left-button selection drag in progress
  let sx0 = 0, sy0 = 0, sx1 = 0, sy1 = 0; // selection box corners (device px)

  // Positions in canvas backing-store px, not CSS px — the camera's screen
  // space is the DPR-scaled canvas resolution.
  const localPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const s = canvas.width / rect.width;
    return { x: (e.clientX - rect.left) * s, y: (e.clientY - rect.top) * s };
  };

  // Hit-test the click (device px) against friendly rally flags, returning the
  // id of the topmost one struck or -1. The clickable box mirrors the renderer's
  // flag geometry (pole + pennant, sized off zoom), grown a little for slop.
  const pickRally = (mx, my) => {
    const rallies = world.getRallies();
    const zoom = cam.zoom;
    const u = Math.max(2, Math.round(zoom * 0.5)); // renderer's flag pixel unit
    const poleH = u * 7, flagW = u * 5, pad = u * 2;
    for (let k = rallies.length - 1; k >= 0; k--) {
      const r = rallies[k];
      if (r.team !== 0) continue;
      const bx = (r.x - cam.x) * zoom; // pole base == rally point
      const by = (r.y - cam.y) * zoom;
      if (mx >= bx - pad && mx <= bx + flagW + pad &&
          my >= by - poleH - pad && my <= by + pad) return r.id;
    }
    return -1;
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    const p = localPos(e);
    // Left: begin a selection box. Middle/right: begin a pan drag.
    if (e.button === 0) {
      selecting = true;
      sx0 = sx1 = p.x;
      sy0 = sy1 = p.y;
    } else if (e.button === 1 || e.button === 2) {
      dragging = true;
      lastX = p.x;
      lastY = p.y;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging && !selecting) return;
    const p = localPos(e);
    if (dragging) {
      Camera.panByScreen(cam, p.x - lastX, p.y - lastY);
      lastX = p.x;
      lastY = p.y;
    }
    if (selecting) {
      sx1 = p.x;
      sy1 = p.y;
    }
  });

  window.addEventListener('mouseup', (e) => {
    (e.button === 1 || e.button === 2) && (dragging = false);
    if (e.button !== 0 || !selecting) return;
    selecting = false;
    // A near-stationary press is a click; a real drag is a box.
    if (Math.abs(sx1 - sx0) + Math.abs(sy1 - sy0) < CLICK_SLOP) {
      // Clicking a friendly flag grabs its squad; clicking bare ground commands
      // the current selection there.
      const id = pickRally(sx1, sy1);
      id !== -1
        ? world.selectByRally(id)
        : world.commandSelected(Camera.screenToWorldX(cam, sx1), Camera.screenToWorldY(cam, sy1));
    } else {
      world.selectInRect(
        Camera.screenToWorldX(cam, sx0), Camera.screenToWorldY(cam, sy0),
        Camera.screenToWorldX(cam, sx1), Camera.screenToWorldY(cam, sy1),
      );
    }
  });

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

  // The in-progress selection rectangle (device px) for the renderer to draw,
  // or null when not dragging one.
  const getSelectionBox = () =>
    selecting ? { x0: sx0, y0: sy0, x1: sx1, y1: sy1 } : null;

  return { update, getSelectionBox };
};
