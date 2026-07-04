// A viewport onto the fixed world space. A camera is plain data: a top-left world
// position (x, y) and a zoom factor; screen = (world - cam) * zoom. Clamping keeps
// the view inside the world and stops zooming out past "whole world visible".
//
// Input never moves the visible camera directly — it moves a *target* (tx, ty,
// tzoom). Each frame smooth() eases the visible camera toward that target, so
// pans and zooms feel weighty instead of snapping. Set CAM_SMOOTH lower for a
// slower, floatier feel; higher for snappier.

import { MAX_ZOOM, CAM_SMOOTH } from '../config.js';

export const create = (worldW, worldH, viewW, viewH) => {
  const cam = {
    worldW, worldH, viewW, viewH,
    zoom: 1,
    x: (worldW - viewW) / 2, // start centered on the world
    y: (worldH - viewH) / 2,
    // Target the visible camera eases toward; seeded to the initial view.
    tzoom: 1, tx: 0, ty: 0,
  };
  cam.tx = cam.x;
  cam.ty = cam.y;
  clampTarget(cam);
  syncToTarget(cam); // no ease on the first frame — start settled
  return cam;
};

export const setViewport = (cam, viewW, viewH) => {
  cam.viewW = viewW;
  cam.viewH = viewH;
  clampTarget(cam);
  clampActual(cam);
};

// Visible extent measured in world units.
export const viewWorldW = (cam) => cam.viewW / cam.zoom;
export const viewWorldH = (cam) => cam.viewH / cam.zoom;

export const screenToWorldX = (cam, sx) => cam.x + sx / cam.zoom;
export const screenToWorldY = (cam, sy) => cam.y + sy / cam.zoom;

// Pan by a screen-space delta (e.g. a mouse drag), in the natural direction.
export const panByScreen = (cam, dx, dy) => {
  cam.tx -= dx / cam.zoom;
  cam.ty -= dy / cam.zoom;
  clampTarget(cam);
};

// Pan by a world-space delta (e.g. keyboard, already scaled by dt).
export const panByWorld = (cam, dx, dy) => {
  cam.tx += dx;
  cam.ty += dy;
  clampTarget(cam);
};

// Zoom by a multiplicative factor while keeping the world point under the cursor
// pinned to the same screen pixel (at the target zoom the ease settles into).
export const zoomAt = (cam, factor, sx, sy) => {
  const wx = cam.tx + sx / cam.tzoom;
  const wy = cam.ty + sy / cam.tzoom;
  cam.tzoom = clampZoom(cam, cam.tzoom * factor);
  cam.tx = wx - sx / cam.tzoom;
  cam.ty = wy - sy / cam.tzoom;
  clampTarget(cam);
};

// Ease the visible camera toward its target. Frame-rate independent: k is the
// fraction of the remaining gap closed this frame for the given dt (seconds).
export const smooth = (cam, dt) => {
  const k = 1 - Math.exp(-CAM_SMOOTH * dt);
  cam.zoom += (cam.tzoom - cam.zoom) * k;
  cam.x += (cam.tx - cam.x) * k;
  cam.y += (cam.ty - cam.y) * k;
  clampActual(cam);
};

const clampZoom = (cam, z) => {
  // Min zoom = enough that the view never exceeds the world in either axis.
  // Zoom is in device px per world unit (the canvas backing store is
  // DPR-scaled), so the CSS-tuned MAX_ZOOM cap scales with display density.
  const minZoom = Math.max(cam.viewW / cam.worldW, cam.viewH / cam.worldH);
  const maxZoom = MAX_ZOOM * (window.devicePixelRatio || 1);
  return Math.min(Math.max(z, minZoom), maxZoom);
};

const clampX = (cam, x, z) => {
  const maxX = cam.worldW - cam.viewW / z;
  return maxX <= 0 ? 0 : Math.min(Math.max(x, 0), maxX);
};

const clampY = (cam, y, z) => {
  const maxY = cam.worldH - cam.viewH / z;
  return maxY <= 0 ? 0 : Math.min(Math.max(y, 0), maxY);
};

const clampTarget = (cam) => {
  cam.tzoom = clampZoom(cam, cam.tzoom);
  cam.tx = clampX(cam, cam.tx, cam.tzoom);
  cam.ty = clampY(cam, cam.ty, cam.tzoom);
};

const clampActual = (cam) => {
  cam.zoom = clampZoom(cam, cam.zoom);
  cam.x = clampX(cam, cam.x, cam.zoom);
  cam.y = clampY(cam, cam.y, cam.zoom);
};

const syncToTarget = (cam) => {
  cam.zoom = cam.tzoom;
  cam.x = cam.tx;
  cam.y = cam.ty;
};
