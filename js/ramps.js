import * as THREE from 'three';

// Keep in sync with RAMP_STOPS in prepare.py
export const RAMP_STOPS = ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e',
  '#c8ef34', '#faba39', '#f66b19', '#ca2a04', '#7a0403'];

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// 256-entry RGB lookup table (0..255 ints)
export const RAMP_LUT = (() => {
  const stops = RAMP_STOPS.map(hex);
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(Math.floor(t), stops.length - 2);
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(stops[k][c] * (1 - f) + stops[k + 1][c] * f);
  }
  return lut;
})();

export function rampTexture() {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data.set([RAMP_LUT[i * 3], RAMP_LUT[i * 3 + 1], RAMP_LUT[i * 3 + 2], 255], i * 4);
  }
  const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export const RAMP_CSS = `linear-gradient(90deg, ${RAMP_STOPS.join(', ')})`;

// ASPRS LAS classification codes
export const CLASS_NAMES = {
  0: 'Never classified', 1: 'Unclassified', 2: 'Ground', 3: 'Low vegetation',
  4: 'Medium vegetation', 5: 'High vegetation', 6: 'Building', 7: 'Low point (noise)',
  8: 'Model key point', 9: 'Water', 10: 'Rail', 11: 'Road surface', 12: 'Overlap',
  13: 'Wire guard', 14: 'Wire conductor', 15: 'Transmission tower', 16: 'Wire connector',
  17: 'Bridge deck', 18: 'High noise',
};

const CLASS_HEX = {
  0: '#bdbdbd', 1: '#9aa3ad', 2: '#b07d48', 3: '#a7d676', 4: '#4fb36b', 5: '#1d7a3a',
  6: '#e5533d', 7: '#ff3df2', 8: '#ffd166', 9: '#3a86ff', 10: '#8d6e63', 11: '#6c757d',
  12: '#f4a261', 13: '#ffbe0b', 14: '#fb5607', 15: '#8338ec', 16: '#ff006e', 17: '#c9a227', 18: '#ff4fd8',
};

// 32 entries of [r,g,b] in 0..1
export const CLASS_RGB = Array.from({ length: 32 }, (_, i) => {
  const h = CLASS_HEX[i] || `#${((i * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}`;
  return hex(h).map((v) => v / 255);
});
export const classHex = (i) => '#' + CLASS_RGB[i].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

// Return number colors: 1st, 2nd, 3rd+
export const RETURN_RGB = [[0.30, 0.79, 0.94], [0.97, 0.59, 0.12], [0.98, 0.25, 0.27]];
export const RETURN_NAMES = ['1st return', '2nd return', '3rd+ return'];
