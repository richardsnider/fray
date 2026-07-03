// A viewport onto the fixed world space. A camera is plain data: a top-left world
// position (x, y) and a zoom factor; screen = (world - cam) * zoom. Clamping keeps
// the view inside the world and stops zooming out past "whole world visible".

import { MAX_ZOOM } from '../config.js';

export const create = (worldW, worldH, viewW, viewH) => {
  const cam = {
    worldW, worldH, viewW, viewH,
    zoom: 1,
    x: (worldW - viewW) / 2, // start centered on the world
    y: (worldH - viewH) / 2,
  };
  clamp(cam);
  return cam;
};

export const setViewport = (cam, viewW, viewH) => {
  cam.viewW = viewW;
  cam.viewH = viewH;
  clamp(cam);
};

// Visible extent measured in world units.
export const viewWorldW = (cam) => cam.viewW / cam.zoom;
export const viewWorldH = (cam) => cam.viewH / cam.zoom;

export const screenToWorldX = (cam, sx) => cam.x + sx / cam.zoom;
export const screenToWorldY = (cam, sy) => cam.y + sy / cam.zoom;
export const worldToScreenX = (cam, wx) => (wx - cam.x) * cam.zoom;
export const worldToScreenY = (cam, wy) => (wy - cam.y) * cam.zoom;

// Pan by a screen-space delta (e.g. a mouse drag), in the natural direction.
export const panByScreen = (cam, dx, dy) => {
  cam.x -= dx / cam.zoom;
  cam.y -= dy / cam.zoom;
  clamp(cam);
};

// Pan by a world-space delta (e.g. keyboard, already scaled by dt).
export const panByWorld = (cam, dx, dy) => {
  cam.x += dx;
  cam.y += dy;
  clamp(cam);
};

// Zoom by a multiplicative factor while keeping the world point under the cursor
// pinned to the same screen pixel.
export const zoomAt = (cam, factor, sx, sy) => {
  const wx = screenToWorldX(cam, sx);
  const wy = screenToWorldY(cam, sy);
  cam.zoom *= factor;
  clampZoom(cam);
  cam.x = wx - sx / cam.zoom;
  cam.y = wy - sy / cam.zoom;
  clamp(cam);
};

const clampZoom = (cam) => {
  // Min zoom = enough that the view never exceeds the world in either axis.
  const minZoom = Math.max(cam.viewW / cam.worldW, cam.viewH / cam.worldH);
  cam.zoom = Math.min(Math.max(cam.zoom, minZoom), MAX_ZOOM);
};

const clamp = (cam) => {
  clampZoom(cam);
  const maxX = cam.worldW - viewWorldW(cam);
  const maxY = cam.worldH - viewWorldH(cam);
  cam.x = maxX <= 0 ? 0 : Math.min(Math.max(cam.x, 0), maxX);
  cam.y = maxY <= 0 ? 0 : Math.min(Math.max(cam.y, 0), maxY);
};
