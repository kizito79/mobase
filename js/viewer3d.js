import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { rampTexture, CLASS_RGB, RETURN_RGB, RAMP_LUT } from './ramps.js';

export const MODES = { rgb: 0, elevation: 1, intensity: 2, classification: 3, returns: 4 };
const PICK = 15; // pick window in device px

const VERT = /* glsl */`
uniform float uSize;
uniform float uScale;
uniform int uSizeMode;
uniform int uMode;
uniform vec2 uZRange;
uniform vec2 uIRange;
uniform vec2 uClip;
uniform float uClassMask[32];
uniform vec3 uClassColors[32];
uniform vec3 uReturnColors[3];
uniform sampler2D uRamp;
uniform float uPicking;
uniform float uAoiOnly;
attribute vec3 rgb;
attribute float intensity;
attribute float cls;
attribute float ret;
attribute float aoi;
varying vec3 vColor;
void main() {
  int c = int(cls + 0.5);
  float z = position.z;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  if (uClassMask[c] < 0.5 || z < uClip.x || z > uClip.y || (uAoiOnly > 0.5 && aoi < 0.5)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }
  float s = uSizeMode == 1 ? uSize * uScale / -mv.z : uSize;
  gl_PointSize = clamp(s, 1.0, 48.0);
  if (uPicking > 0.5) {
    int id = gl_VertexID + 1;
    vColor = vec3(float(id & 255), float((id >> 8) & 255), float((id >> 16) & 255)) / 255.0;
    return;
  }
  if (uMode == 0) vColor = rgb;
  else if (uMode == 1) {
    float t = clamp((z - uZRange.x) / max(uZRange.y - uZRange.x, 1e-6), 0.0, 1.0);
    vColor = texture2D(uRamp, vec2(t * 0.996 + 0.002, 0.5)).rgb;
  } else if (uMode == 2) {
    float t = clamp((intensity - uIRange.x) / max(uIRange.y - uIRange.x, 1e-6), 0.0, 1.0);
    vColor = vec3(pow(t, 0.8));
  } else if (uMode == 3) vColor = uClassColors[c];
  else {
    int r = int(clamp(ret, 1.0, 3.0)) - 1;
    vColor = uReturnColors[r];
  }
}`;

const FRAG = /* glsl */`
uniform float uRound;
varying vec3 vColor;
void main() {
  if (uRound > 0.5) {
    vec2 p = gl_PointCoord - 0.5;
    if (dot(p, p) > 0.25) discard;
  }
  gl_FragColor = vec4(vColor, 1.0);
}`;

const COLORS = { distance: 0xffd23f, height: 0x4cc9f0, area: 0x80ed99, profile: 0xff7b9c, point: 0xffffff };

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(16, 16, 11, 0, Math.PI * 2);
  g.fillStyle = '#fff'; g.fill();
  g.lineWidth = 4; g.strokeStyle = '#000'; g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const fmt = (v, d = 2) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

export class Viewer3D extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    const r = this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setClearColor(0x000000, 0);
    container.prepend(r.domElement);
    this.canvas = r.domElement;

    this.scene = new THREE.Scene(); // transparent: the page's branded gradient shows through
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 50000);
    this.camera.up.set(0, 0, 1);
    this._makeControls();

    this.overlay = new THREE.Group();
    this.overlay.renderOrder = 10;
    this.scene.add(this.overlay);
    this.dot = dotTexture();

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'labels';
    container.appendChild(this.labelLayer);

    this.pickTarget = new THREE.WebGLRenderTarget(PICK, PICK);
    this.pickBuf = new Uint8Array(PICK * PICK * 4);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uSize: { value: 3 }, uScale: { value: 1 }, uSizeMode: { value: 1 }, uMode: { value: 0 },
        uZRange: { value: new THREE.Vector2(0, 1) }, uIRange: { value: new THREE.Vector2(0, 1) },
        uClip: { value: new THREE.Vector2(-1e9, 1e9) },
        uClassMask: { value: new Array(32).fill(1) },
        uClassColors: { value: CLASS_RGB.map((c) => new THREE.Vector3(...c)) },
        uReturnColors: { value: RETURN_RGB.map((c) => new THREE.Vector3(...c)) },
        uRamp: { value: rampTexture() },
        uPicking: { value: 0 }, uRound: { value: 1 }, uAoiOnly: { value: 0 },
      },
    });
    this.pointWorldSize = 0.04; // metres per size step in adaptive mode
    // shared by every clipped mesh material (textured model, DSM/DEM surface)
    this.clipU = { uClipTex: { value: null }, uClipBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uClipOn: { value: 0 } };

    this.measures = [];
    this.active = null;
    this.tool = 'none';
    this.profileWidth = 1;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this._bindPointer();
    window.addEventListener('keydown', (e) => this._key(e));
    r.setAnimationLoop(() => this._tick());
  }

  _makeControls() {
    const target = this.controls?.target.clone();
    this.controls?.dispose();
    const c = this.controls = new OrbitControls(this.camera, this.canvas);
    c.enableDamping = true;
    c.dampingFactor = 0.15;
    c.screenSpacePanning = true;
    c.zoomToCursor = true;
    c.addEventListener('change', () => (this.dirty = true));
    if (target && Number.isFinite(target.x)) c.target.copy(target);
  }

  // OrbitControls keeps damped deltas internally; a pointer event on a zero-size (hidden) canvas can make them NaN,
  // after which every update yields a NaN camera. Rebuild the controls and reframe if that happens.
  _healCamera() {
    const p = this.camera.position, q = this.camera.quaternion;
    if (Number.isFinite(p.x + p.y + p.z + q.x + q.w)) return;
    this._makeControls();
    this.camera.quaternion.identity();
    this.viewPreset('oblique', this.clipped ? 'aoi' : null);
  }

  // ------------------------------------------------------------------ data
  setData(meta, buf) {
    this.clearMeasures();
    this.setAoi(null);
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    this.meta = meta;
    this.buf = buf;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(buf.pos, 3));
    g.setAttribute('rgb', new THREE.BufferAttribute(buf.rgb, 3, true));
    g.setAttribute('intensity', new THREE.BufferAttribute(buf.int, 1, true));
    g.setAttribute('cls', new THREE.BufferAttribute(buf.cls, 1));
    g.setAttribute('ret', new THREE.BufferAttribute(buf.ret, 1));
    const b = meta.points.bounds_local;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    const u = this.material.uniforms;
    u.uZRange.value.set(...meta.points.z_default);
    u.uIRange.value.set(...meta.points.intensity_range);
    u.uClip.value.set(-1e9, 1e9);
    this.bbox = g.boundingBox;
    this.viewPreset('oblique');
  }

  setSurface(kind, grid, texture, opacity = 1) {
    if (this.surface) {
      this.scene.remove(this.surface);
      this.surface.geometry.dispose();
      this.surface.material.dispose();
      this.surface = null;
    }
    if (kind !== 'none' && grid) {
      this.surface = buildSurface(grid, this.meta, texture);
      this.clipMaterial(this.surface.material);
      this.surface.material.opacity = opacity;
      this.surface.material.transparent = opacity < 1;
      this.scene.add(this.surface);
    }
    this.dirty = true;
  }

  setSurfaceOpacity(o) {
    if (!this.surface) return;
    this.surface.material.opacity = o;
    this.surface.material.transparent = o < 1;
    this.surface.material.needsUpdate = true;
    this.dirty = true;
  }

  // Textured 3D model (glTF scene already positioned in the cloud's local frame), or null to remove it.
  setModel(obj) {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [o.material].flat()) { m?.map?.dispose(); m?.dispose?.(); }
      });
    }
    this.model = obj;
    if (obj) {
      obj.traverse((o) => { for (const m of [o.material].flat()) if (m) this.clipMaterial(m); });
      this.scene.add(obj);
    }
    this.dirty = true;
  }

  setModelVisible(v) { if (this.model) this.model.visible = v; this.dirty = true; }

  setModelOpacity(o) {
    this.model?.traverse((n) => {
      for (const m of [n.material].flat()) {
        if (!m) continue;
        m.opacity = o; m.transparent = o < 1; m.depthWrite = o >= 1; m.needsUpdate = true;
      }
    });
    this.dirty = true;
  }

  setPointsVisible(v) { if (this.points) this.points.visible = v; this.dirty = true; }

  // ------------------------------------------------------------------ area of interest
  // rings: [[[x, y], ...], ...] in local coordinates; zAt(x, y) gives a local surface height (or NaN).
  // clipRings: the region "clip" keeps (e.g. a buffer around the AOI); defaults to the AOI itself.
  setAoi(rings, zAt = null, label = '', clipRings = null) {
    if (this.aoi) {
      this.scene.remove(this.aoi.group);
      this.aoi.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      this.aoi.label?.remove();
    }
    this.aoi = null;
    this.material.uniforms.uAoiOnly.value = 0;
    this.clipU.uClipOn.value = 0;
    this.clipU.uClipTex.value?.dispose();
    this.clipU.uClipTex.value = null;
    if (this.points?.geometry.getAttribute('aoi')) this.points.geometry.deleteAttribute('aoi');
    this.aoiMask = null;
    this.dirty = true;
    if (!rings?.length) return;

    const group = new THREE.Group();
    const zFloor = this.bbox ? this.bbox.min.z : 0;
    let zTop = -Infinity;
    const cen = new THREE.Vector3();
    let nc = 0;
    const drape = (ring) => {
      const pts = [];
      let lastZ = NaN;
      for (let i = 0; i < ring.length - 1; i++) {
        const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
        for (let s = 0; s < steps; s++) {
          const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
          let z = zAt ? zAt(x, y) : NaN;
          if (!Number.isFinite(z)) z = Number.isFinite(lastZ) ? lastZ : zFloor;
          lastZ = z;
          pts.push(new THREE.Vector3(x, y, z + 0.4));
        }
      }
      pts.push(pts[0].clone());
      return pts;
    };
    if (clipRings) {
      for (const ring of clipRings) {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(drape(ring)),
          new THREE.LineDashedMaterial({ color: 0xffe08a, dashSize: 1.5, gapSize: 1, transparent: true, depthTest: false }));
        line.computeLineDistances();
        line.renderOrder = 998;
        group.add(line);
      }
    }
    for (const ring of rings) {
      // densify to ~1 m so the line drapes over the terrain
      const pts = [];
      let lastZ = NaN;
      for (let i = 0; i < ring.length - 1; i++) { // shapefile rings are closed (last vertex = first)
        const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
        for (let s = 0; s < steps; s++) {
          const x = ax + ((bx - ax) * s) / steps, y = ay + ((by - ay) * s) / steps;
          let z = zAt ? zAt(x, y) : NaN;
          if (!Number.isFinite(z)) z = Number.isFinite(lastZ) ? lastZ : zFloor;
          lastZ = z;
          pts.push(new THREE.Vector3(x, y, z + 0.4));
          zTop = Math.max(zTop, z);
        }
        cen.x += ax; cen.y += ay; nc++;
      }
      pts.push(pts[0].clone());
      const fill = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), fill(0xffb703, 1));
      line.renderOrder = 998;
      group.add(line);
      // translucent fence from the ground up to 3 m above the draped line, so the boundary reads in oblique views
      const pos = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        pos.push(a.x, a.y, a.z - 0.4, b.x, b.y, b.z - 0.4, b.x, b.y, b.z + 3, a.x, a.y, a.z - 0.4, b.x, b.y, b.z + 3, a.x, a.y, a.z + 3);
      }
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const fence = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: 0xffb703, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
      fence.renderOrder = 997;
      group.add(fence);
    }
    cen.divideScalar(nc);
    cen.z = zTop + 6;
    this.scene.add(group);
    const el = document.createElement('div');
    el.className = 'mlabel total aoilabel';
    el.innerHTML = label;
    this.labelLayer.appendChild(el);
    const clip = clipRings || rings;
    const box = new THREE.Box3();
    for (const r of clip) for (const [x, y] of r) box.expandByPoint(new THREE.Vector3(x, y, 0));
    box.min.z = zFloor; box.max.z = zTop;
    this.aoi = { group, rings, clip, label: el, labelPos: cen, box };
    this._clipTexture(clip, box);
    this.dirty = true;
  }

  // Rasterise the clip polygon (even-odd) into a mask texture the mesh shaders sample by world X/Y.
  _clipTexture(clip, box) {
    const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y;
    const k = 2048 / Math.max(sx, sy);
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.ceil(sx * k)); c.height = Math.max(2, Math.ceil(sy * k));
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
    g.beginPath();
    for (const r of clip) r.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo']((x - box.min.x) * k, (box.max.y - y) * k));
    g.fillStyle = '#fff'; g.fill('evenodd');
    this.clipU.uClipTex.value?.dispose();
    const t = new THREE.CanvasTexture(c);
    t.flipY = true; // canvas row 0 = north, texture v = 1 at north
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    this.clipU.uClipTex.value = t;
    this.clipU.uClipBox.value.set(box.min.x, box.min.y, sx, sy);
  }

  insideClip(x, y) {
    let inside = false;
    for (const r of this.aoi.clip) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  // Make a mesh material honour the AOI clip (discard fragments outside the clip polygon).
  clipMaterial(mat) {
    if (mat.userData.clipPatched) return;
    mat.userData.clipPatched = true;
    const U = this.clipU;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = 'varying vec2 vClipW;\n' + sh.vertexShader.replace('#include <fog_vertex>',
        '#include <fog_vertex>\n  vClipW = (modelMatrix * vec4(transformed, 1.0)).xy;');
      sh.fragmentShader = 'varying vec2 vClipW;\nuniform sampler2D uClipTex;\nuniform vec4 uClipBox;\nuniform float uClipOn;\n'
        + sh.fragmentShader.replace('void main() {', `void main() {
  if (uClipOn > 0.5) {
    vec2 cuv = (vClipW - uClipBox.xy) / uClipBox.zw;
    if (cuv.x < 0.0 || cuv.y < 0.0 || cuv.x > 1.0 || cuv.y > 1.0 || texture2D(uClipTex, cuv).r < 0.5) discard;
  }`);
    };
    mat.customProgramCacheKey = () => 'aoiclip';
    mat.needsUpdate = true;
  }

  setAoiVisible(v) {
    if (!this.aoi) return;
    this.aoi.group.visible = v;
    this.aoi.label.style.visibility = v ? '' : 'hidden';
    this.dirty = true;
  }

  // Flags every point inside the AOI (even-odd rule across rings, so holes work). Returns the count inside.
  computeAoiMask() {
    if (!this.aoi || !this.buf) return 0;
    if (this.aoiMask) return this.aoiMask.count;
    const { clip: rings, box } = this.aoi;
    const p = this.buf.pos, n = this.buf.count;
    const mask = new Uint8Array(n);
    const edges = [];
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) edges.push(r[i][0], r[i][1], r[j][0], r[j][1]);
    const E = edges.length / 4, x0 = box.min.x, x1 = box.max.x, y0 = box.min.y, y1 = box.max.y;
    let count = 0;
    for (let k = 0; k < n; k++) {
      const x = p[k * 3], y = p[k * 3 + 1];
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      let inside = false;
      for (let e = 0; e < E; e++) {
        const xi = edges[e * 4], yi = edges[e * 4 + 1], xj = edges[e * 4 + 2], yj = edges[e * 4 + 3];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) { mask[k] = 1; count++; }
    }
    this.aoiMask = { mask, count };
    this.points.geometry.setAttribute('aoi', new THREE.BufferAttribute(mask, 1));
    return count;
  }

  setAoiOnly(on) {
    if (on) this.computeAoiMask();
    this.material.uniforms.uAoiOnly.value = on && this.aoiMask ? 1 : 0;
    this.clipU.uClipOn.value = on && this.aoi ? 1 : 0;
    this.dirty = true;
  }

  get clipped() { return this.clipU.uClipOn.value > 0.5; }

  set(name, value) {
    const u = this.material.uniforms;
    if (name === 'mode') u.uMode.value = MODES[value];
    else if (name === 'size') u.uSize.value = value;
    else if (name === 'sizeMode') u.uSizeMode.value = value === 'adaptive' ? 1 : 0;
    else if (name === 'zRange') u.uZRange.value.set(value[0], value[1]);
    else if (name === 'clip') u.uClip.value.set(value[0], value[1]);
    else if (name === 'round') u.uRound.value = value ? 1 : 0;
    else if (name === 'classMask') { u.uClassMask.value = value.map((v) => (v ? 1 : 0)); }
    this._updateSizeUniform();
    this.dirty = true;
  }

  get settings() {
    const u = this.material.uniforms;
    return {
      mode: Object.keys(MODES).find((k) => MODES[k] === u.uMode.value),
      zRange: [u.uZRange.value.x, u.uZRange.value.y],
      iRange: [u.uIRange.value.x, u.uIRange.value.y],
      clip: [u.uClip.value.x, u.uClip.value.y],
      classMask: u.uClassMask.value,
    };
  }

  isVisible(i) {
    const u = this.material.uniforms;
    const z = this.buf.pos[i * 3 + 2];
    if (u.uAoiOnly.value > 0.5 && !this.aoiMask.mask[i]) return false;
    return u.uClassMask.value[this.buf.cls[i]] > 0.5 && z >= u.uClip.value.x && z <= u.uClip.value.y;
  }

  // CPU mirror of the shader colouring (for the profile chart). Returns 0..255 ints.
  colorOf(i, out) {
    const u = this.material.uniforms;
    const b = this.buf;
    switch (u.uMode.value) {
      case 0: out[0] = b.rgb[i * 3]; out[1] = b.rgb[i * 3 + 1]; out[2] = b.rgb[i * 3 + 2]; break;
      case 1: {
        const t = Math.min(1, Math.max(0, (b.pos[i * 3 + 2] - u.uZRange.value.x) / (u.uZRange.value.y - u.uZRange.value.x || 1e-6)));
        const k = Math.round(t * 255) * 3;
        out[0] = RAMP_LUT[k]; out[1] = RAMP_LUT[k + 1]; out[2] = RAMP_LUT[k + 2]; break;
      }
      case 2: {
        const t = Math.min(1, Math.max(0, (b.int[i] / 65535 - u.uIRange.value.x) / (u.uIRange.value.y - u.uIRange.value.x || 1e-6)));
        out[0] = out[1] = out[2] = Math.round(Math.pow(t, 0.8) * 255); break;
      }
      case 3: { const c = CLASS_RGB[b.cls[i]]; out[0] = c[0] * 255; out[1] = c[1] * 255; out[2] = c[2] * 255; break; }
      default: { const c = RETURN_RGB[Math.min(Math.max(b.ret[i], 1), 3) - 1]; out[0] = c[0] * 255; out[1] = c[1] * 255; out[2] = c[2] * 255; }
    }
    return out;
  }

  // ------------------------------------------------------------------ camera
  viewPreset(name, fit = null) {
    if (!this.bbox) return;
    const box = fit === 'aoi' && this.aoi ? this.aoi.box : this.bbox;
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const d = Math.max(s.x, s.y) * 0.95;
    this.controls.target.copy(c);
    if (name === 'top') this.camera.position.set(c.x, c.y - 0.001, c.z + d * 1.15);
    else if (name === 'south') this.camera.position.set(c.x, c.y - d, c.z + s.z * 0.5);
    else if (name === 'west') this.camera.position.set(c.x - d, c.y, c.z + s.z * 0.5);
    else this.camera.position.set(c.x - d * 0.35, c.y - d * 0.75, c.z + d * 0.55);
    this.camera.near = Math.max(0.05, d / 5000);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    if (!Number.isFinite(this.camera.position.x)) { // controls state was NaN: rebuild and place again
      this._makeControls();
      this.controls.target.copy(c);
      this.camera.position.set(c.x - d * 0.35, c.y - d * 0.75, c.z + d * 0.55);
      this.controls.update();
    }
    this.dirty = true;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._updateSizeUniform();
    this.dirty = true;
  }

  _updateSizeUniform() {
    const u = this.material.uniforms;
    const h = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    const k = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    // adaptive mode: size slider steps are world-space centimetres
    u.uScale.value = u.uSizeMode.value === 1 ? k * this.pointWorldSize : 1;
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  _tick() {
    if (!this.canvas.clientWidth) return; // hidden (2D tab): don't advance the controls
    const moved = this.controls.update();
    this._healCamera();
    if (moved || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
      this._placeLabels();
      if (this.onFrame) {
        const d = this.camera.getWorldDirection(new THREE.Vector3());
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        // heading of the screen's "up" direction in the ground plane (works for top-down too)
        const v = Math.hypot(d.x, d.y) > 0.2 ? d : up;
        this.onFrame(Math.atan2(v.x, v.y) * 180 / Math.PI);
      }
    }
  }

  // ------------------------------------------------------------------ picking
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const sx = size.x / rect.width;
    const px = (clientX - rect.left) * sx, py = (clientY - rect.top) * sx;

    // nearest hit on the textured model / surface mesh (if shown)
    const meshes = [this.model, this.surface].filter((o) => o?.visible);
    let meshHit = null;
    if (meshes.length) {
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, this.camera);
      const hit = rc.intersectObjects(meshes, true).find((h) => !this.clipped || this.insideClip(h.point.x, h.point.y));
      if (hit) {
        let o = hit.object;
        while (o && o !== this.model && o !== this.surface) o = o.parent;
        meshHit = { index: -1, point: hit.point.clone(), source: o === this.model ? 'model' : 'surface', distance: hit.distance };
      }
    }

    if (this.points && this.points.visible) {
      const u = this.material.uniforms;
      const overlayVis = this.overlay.visible, surfVis = this.surface?.visible, modelVis = this.model?.visible;
      this.overlay.visible = false;
      if (this.surface) this.surface.visible = false;
      if (this.model) this.model.visible = false;
      u.uPicking.value = 1;
      this.camera.setViewOffset(size.x, size.y, Math.round(px - PICK / 2), Math.round(py - PICK / 2), PICK, PICK);
      this.renderer.setRenderTarget(this.pickTarget);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      this.camera.clearViewOffset();
      u.uPicking.value = 0;
      this.overlay.visible = overlayVis;
      if (this.surface) this.surface.visible = surfVis;
      if (this.model) this.model.visible = modelVis;
      this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, PICK, PICK, this.pickBuf);
      let best = -1, bestD = Infinity;
      const half = (PICK - 1) / 2;
      for (let y = 0; y < PICK; y++) {
        for (let x = 0; x < PICK; x++) {
          const o = (y * PICK + x) * 4;
          const id = this.pickBuf[o] | (this.pickBuf[o + 1] << 8) | (this.pickBuf[o + 2] << 16);
          if (!id) continue;
          const d = (x - half) ** 2 + (y - half) ** 2;
          if (d < bestD) { bestD = d; best = id - 1; }
        }
      }
      this.dirty = true;
      if (best >= 0 && best < this.buf.count) {
        const p = this.buf.pos;
        const point = new THREE.Vector3(p[best * 3], p[best * 3 + 1], p[best * 3 + 2]);
        // a mesh surface clearly in front of the point wins (points behind the model are hidden from view)
        if (!meshHit || meshHit.distance > point.distanceTo(this.camera.position) - 0.5) return { index: best, point };
      }
    }
    return meshHit;
  }

  _bindPointer() {
    let down = null;
    let hoverPending = false;
    this.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (down && down.b === 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) this._click(e);
      down = null;
    });
    this.canvas.addEventListener('dblclick', () => this.finish());
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons || hoverPending || !this.points) return;
      hoverPending = true;
      setTimeout(() => {
        hoverPending = false;
        const hit = this.pick(e.clientX, e.clientY);
        this.dispatchEvent(new CustomEvent('hover', { detail: hit }));
        if (this.active && hit) this._preview(hit.point);
      }, 50);
    });
    this.canvas.addEventListener('pointerleave', () => this.dispatchEvent(new CustomEvent('hover', { detail: null })));
  }

  _key(e) {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'Escape') this.cancel();
    else if (e.key === 'Enter') this.finish();
    else if (e.key === 'Backspace' && this.active?.pts.length) {
      this.active.pts.pop();
      this._rebuild(this.active);
    }
  }

  // ------------------------------------------------------------------ measuring
  setTool(t) {
    this.finish();
    this.tool = t;
    this.canvas.style.cursor = t === 'none' ? '' : 'crosshair';
    this.dispatchEvent(new CustomEvent('tool', { detail: t }));
  }

  _click(e) {
    if (this.tool === 'none') return;
    const hit = this.pick(e.clientX, e.clientY);
    if (!hit) return;
    const p = hit.point;
    if (!this.active) {
      this.active = { type: this.tool, pts: [], group: new THREE.Group(), labels: [], id: Math.random().toString(36).slice(2) };
      this.overlay.add(this.active.group);
    }
    const m = this.active;
    const last = m.pts[m.pts.length - 1];
    if (last && last.distanceTo(p) < 1e-4) return; // double-click duplicate
    m.pts.push(p);
    if (m.type === 'point') m.info = hit;
    const need = { point: 1, height: 2, profile: 2 }[m.type];
    if (need && m.pts.length >= need) this.finish();
    else this._rebuild(m);
  }

  _preview(p) {
    const m = this.active;
    if (!m || !m.pts.length) return;
    this._rebuild(m, p);
  }

  finish() {
    const m = this.active;
    if (!m) return;
    this.active = null;
    const min = { point: 1, distance: 2, height: 2, area: 3, profile: 2 }[m.type];
    if (m.pts.length < min) { this._dispose(m); return; }
    m.done = true;
    this.measures.push(m);
    this._rebuild(m);
    if (m.type === 'profile') this.dispatchEvent(new CustomEvent('profile', { detail: m }));
    this._changed();
  }

  cancel() {
    if (this.active) { this._dispose(this.active); this.active = null; this.dirty = true; }
  }

  removeMeasure(id) {
    const i = this.measures.findIndex((m) => m.id === id);
    if (i < 0) return;
    const [m] = this.measures.splice(i, 1);
    this._dispose(m);
    if (m.type === 'profile') this.dispatchEvent(new CustomEvent('profile', { detail: null }));
    this._changed();
  }

  clearMeasures() {
    this.cancel();
    for (const m of this.measures) this._dispose(m);
    const hadProfile = this.measures.some((m) => m.type === 'profile');
    this.measures = [];
    if (hadProfile) this.dispatchEvent(new CustomEvent('profile', { detail: null }));
    this._changed();
  }

  setProfileWidth(w) {
    this.profileWidth = w;
    for (const m of this.measures) if (m.type === 'profile') { this._rebuild(m); this.dispatchEvent(new CustomEvent('profile', { detail: m })); }
  }

  _changed() {
    this.dirty = true;
    this.dispatchEvent(new CustomEvent('measures', { detail: this.measures }));
  }

  _dispose(m) {
    m.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.overlay.remove(m.group);
    m.labels.forEach((l) => l.el.remove());
    m.labels = [];
  }

  _line(pts, color, dashed = false) {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 0.4, gapSize: 0.3, depthTest: false, transparent: true })
      : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const l = new THREE.Line(g, mat);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 999;
    return l;
  }

  _markers(pts, color) {
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const m = new THREE.Points(g, new THREE.PointsMaterial({
      size: 12, sizeAttenuation: false, map: this.dot, color, transparent: true, depthTest: false, alphaTest: 0.3,
    }));
    m.renderOrder = 1000;
    return m;
  }

  _label(m, pos, html, cls = '') {
    const el = document.createElement('div');
    el.className = 'mlabel ' + cls;
    el.innerHTML = html;
    this.labelLayer.appendChild(el);
    m.labels.push({ el, pos: pos.clone() });
  }

  _rebuild(m, cursor = null) {
    m.group.traverse((o) => { if (o !== m.group) { o.geometry?.dispose(); o.material?.dispose?.(); } });
    m.group.clear();
    m.labels.forEach((l) => l.el.remove());
    m.labels = [];
    const color = COLORS[m.type];
    const pts = cursor ? [...m.pts, cursor] : m.pts;
    const Z0 = this.meta.points.origin[2];

    if (m.type === 'point') {
      const p = pts[0];
      m.summary = `Z ${fmt(p.z + Z0)} m`;
      this._label(m, p, `${m.summary}`, 'pt');
    } else if (m.type === 'distance') {
      let total = 0, horiz = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const d = a.distanceTo(b);
        total += d;
        horiz += Math.hypot(b.x - a.x, b.y - a.y);
        this._label(m, a.clone().lerp(b, 0.5), `${fmt(d)} m`);
      }
      m.summary = `${fmt(total)} m (horizontal ${fmt(horiz)} m)`;
      if (pts.length > 2) this._label(m, pts[pts.length - 1], `Total ${fmt(total)} m`, 'total');
    } else if (m.type === 'height') {
      if (pts.length >= 2) {
        const [a, b] = pts;
        const c = new THREE.Vector3(b.x, b.y, a.z);
        const dz = b.z - a.z, h = Math.hypot(b.x - a.x, b.y - a.y);
        m.group.add(this._line([a, c, b], color, true));
        this._label(m, c.clone().lerp(b, 0.5), `ΔZ ${dz >= 0 ? '+' : ''}${fmt(dz)} m`, 'total');
        this._label(m, a.clone().lerp(c, 0.5), `H ${fmt(h)} m`);
        m.summary = `ΔZ ${dz >= 0 ? '+' : ''}${fmt(dz)} m, horiz ${fmt(h)} m, slope ${fmt(Math.atan2(Math.abs(dz), h) * 180 / Math.PI, 1)}°`;
      }
    } else if (m.type === 'area') {
      if (pts.length >= 3) {
        let a2 = 0, per = 0;
        const cen = new THREE.Vector3();
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], q = pts[(i + 1) % pts.length];
          a2 += p.x * q.y - q.x * p.y;
          per += p.distanceTo(q);
          cen.add(p);
        }
        cen.divideScalar(pts.length);
        const area = Math.abs(a2) / 2;
        m.summary = `${fmt(area, 1)} m² (${fmt(area / 10000, 4)} ha), perimeter ${fmt(per, 1)} m`;
        this._label(m, cen, `${fmt(area, 1)} m²<br><small>${fmt(area / 10000, 4)} ha · P ${fmt(per, 1)} m</small>`, 'total');
      }
    } else if (m.type === 'profile') {
      if (pts.length >= 2) {
        const [a, b] = pts;
        const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, 0).normalize();
        const n = new THREE.Vector3(-dir.y, dir.x, 0).multiplyScalar(this.profileWidth / 2);
        m.group.add(this._line([a.clone().add(n), b.clone().add(n), b.clone().sub(n), a.clone().sub(n), a.clone().add(n)], color, true));
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        m.summary = `${fmt(len, 1)} m long, ${fmt(this.profileWidth, 1)} m wide`;
        this._label(m, a, 'A', 'tag');
        this._label(m, b, 'B', 'tag');
      }
    }

    if (pts.length > 1 && m.type !== 'height') {
      const linePts = m.type === 'area' && pts.length > 2 ? [...pts, pts[0]] : pts;
      m.group.add(this._line(linePts, color));
    } else if (m.type === 'height' && pts.length > 1) {
      m.group.add(this._line(pts.slice(0, 2), color));
    }
    m.group.add(this._markers(pts, color));
    if (!m.group.parent) this.overlay.add(m.group);
    this.dirty = true;
  }

  _placeLabels() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const v = new THREE.Vector3();
    if (this.aoi) {
      v.copy(this.aoi.labelPos).project(this.camera);
      const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      this.aoi.label.style.display = vis ? '' : 'none';
      if (vis) this.aoi.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
    const all = [...this.measures, ...(this.active ? [this.active] : [])];
    for (const m of all) {
      for (const l of m.labels) {
        v.copy(l.pos).project(this.camera);
        const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
        l.el.style.display = vis ? '' : 'none';
        if (vis) l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -130%)`;
      }
    }
  }

  // ------------------------------------------------------------------ profile
  computeProfile(m) {
    const [a, b] = m.pts;
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, half = this.profileWidth / 2;
    const p = this.buf.pos, n = this.buf.count;
    const t = [], z = [], idx = [];
    for (let i = 0; i < n; i++) {
      const rx = p[i * 3] - a.x, ry = p[i * 3 + 1] - a.y;
      const along = rx * ux + ry * uy;
      if (along < 0 || along > L) continue;
      if (Math.abs(-rx * uy + ry * ux) > half) continue;
      if (!this.isVisible(i)) continue;
      t.push(along); z.push(p[i * 3 + 2]); idx.push(i);
    }
    return { length: L, t: Float32Array.from(t), z: Float32Array.from(z), idx: Uint32Array.from(idx) };
  }
}

// Build a textured terrain mesh from an elevation grid (values relative to cloud origin Z).
function buildSurface(grid, meta, texture) {
  const { width: W, height: H, data, bounds_lonlat: [west, south, east, north] } = grid;
  const g2l = meta.points.affine.lonlat_to_local;
  const step = Math.max(1, Math.ceil(Math.max(W, H) / 700));
  const cols = Math.floor((W - 1) / step) + 1, rows = Math.floor((H - 1) / step) + 1;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  const ok = new Uint8Array(cols * rows);
  const tb = texture?.bounds;
  for (let r = 0; r < rows; r++) {
    const row = r * step;
    const lat = north - ((row + 0.5) / H) * (north - south);
    for (let c = 0; c < cols; c++) {
      const col = c * step;
      const lon = west + ((col + 0.5) / W) * (east - west);
      const k = r * cols + c;
      const z = data[row * W + col];
      ok[k] = Number.isFinite(z) ? 1 : 0;
      pos[k * 3] = g2l[0][0] * lon + g2l[0][1] * lat + g2l[0][2];
      pos[k * 3 + 1] = g2l[1][0] * lon + g2l[1][1] * lat + g2l[1][2];
      pos[k * 3 + 2] = ok[k] ? z : 0;
      if (tb) {
        uv[k * 2] = (lon - tb[0]) / (tb[2] - tb[0]);
        uv[k * 2 + 1] = (lat - tb[1]) / (tb[3] - tb[1]);
      }
    }
  }
  const index = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      if (ok[a] && ok[b] && ok[d] && ok[e]) index.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index.length > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  geo.computeVertexNormals();
  const mat = texture?.tex
    ? new THREE.MeshBasicMaterial({ map: texture.tex, side: THREE.DoubleSide })
    : new THREE.MeshLambertMaterial({ color: 0xb8b0a0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  return mesh;
}
