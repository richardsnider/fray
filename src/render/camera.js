// A viewport onto the fixed world space. A camera is plain data: a top-left world
// position (x, y) and a zoom factor; screen = (world - cam) * zoom. Clamping keeps
// the view inside the world and stops zooming out past "whole world visible".
//
// Input drives the camera directly: pans and zooms apply the instant they happen
// and stop the instant input ends — no easing, no inertia, no post-input glide.

import { MAX_ZOOM } from '../config.js';

export const create = (worldW, worldH, viewW, viewH) => {
  const cam = {
    worldW, worldH, viewW, viewH,
    zoom: 1,
    x: (worldW - viewW) / 2, // start centered on the world
    y: (worldH - viewH) / 2,
  };
  clampCam(cam);
  return cam;
};

export const setViewport = (cam, viewW, viewH) => {
  cam.viewW = viewW;
  cam.viewH = viewH;
  clampCam(cam);
};

// Visible extent measured in world units.
export const viewWorldW = (cam) => cam.viewW / cam.zoom;
export const viewWorldH = (cam) => cam.viewH / cam.zoom;

export const screenToWorldX = (cam, sx) => cam.x + sx / cam.zoom;
export const screenToWorldY = (cam, sy) => cam.y + sy / cam.zoom;

// Pan by a screen-space delta (e.g. a mouse drag), in the natural direction.
export const panByScreen = (cam, dx, dy) => {
  cam.x -= dx / cam.zoom;
  cam.y -= dy / cam.zoom;
  clampCam(cam);
};

// Pan by a world-space delta (e.g. keyboard, already scaled by dt).
export const panByWorld = (cam, dx, dy) => {
  cam.x += dx;
  cam.y += dy;
  clampCam(cam);
};

// Zoom by a multiplicative factor while keeping the world point under the cursor
// pinned to the same screen pixel.
export const zoomAt = (cam, factor, sx, sy) => {
  const wx = cam.x + sx / cam.zoom;
  const wy = cam.y + sy / cam.zoom;
  cam.zoom = clampZoom(cam, cam.zoom * factor);
  cam.x = wx - sx / cam.zoom;
  cam.y = wy - sy / cam.zoom;
  clampCam(cam);
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

const clampCam = (cam) => {
  cam.zoom = clampZoom(cam, cam.zoom);
  cam.x = clampX(cam, cam.x, cam.zoom);
  cam.y = clampY(cam, cam.y, cam.zoom);
};
