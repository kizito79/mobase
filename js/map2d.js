/* global L */
import { RAMP_CSS } from './ramps.js';

const LAYERS = [
  { key: 'photo', name: 'Orthophoto', file: (m) => m.rasters.photo.file, label: (m) => m.rasters.photo.name },
  { key: 'dom', name: 'Orthomosaic', file: (m) => m.rasters.dom.file },
  { key: 'dsm', name: 'DSM (surface, shaded)', file: () => 'dsm_shaded.png' },
  { key: 'dem', name: 'DEM (ground, shaded)', file: () => 'dem_shaded.png' },
  { key: 'ndsm', name: 'Object heights (DSM − DEM)', file: () => 'ndsm_shaded.png' },
  { key: 'hillshade', src: 'dsm', name: 'Hillshade', file: () => 'dsm_hillshade.png' },
];

export class Map2D {
  constructor(el, readoutEl, legendEl) {
    this.readout = readoutEl;
    this.legend = legendEl;
    this.map = L.map(el, { zoomControl: true, maxZoom: 24, preferCanvas: true });
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 24, attribution: '© OpenStreetMap contributors',
    });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 19, maxZoom: 24, attribution: 'Imagery © Esri',
    });
    const none = L.layerGroup();
    if (window.LIDAR_SHARED) {
      // hosted share pages block outside tile servers
      none.addTo(this.map);
      this.bases = {};
    } else {
      sat.addTo(this.map);
      this.bases = { 'Satellite (Esri)': sat, OpenStreetMap: osm, 'No basemap': none };
    }
    // AOI mask and outlines stay above the raster overlays, whatever order those are toggled in
    this.map.createPane('clipPane').style.zIndex = 450;
    this.map.createPane('aoiPane').style.zIndex = 460;
    this.clipRenderer = L.svg({ pane: 'clipPane' });
    this.aoiRenderer = L.svg({ pane: 'aoiPane' });
    this.control = null;
    this.overlays = {};
    this.opacity = 1;
    L.control.scale({ imperial: false }).addTo(this.map);
    this.map.on('mousemove', (e) => this._readout(e.latlng));
    this.map.on('overlayadd overlayremove', () => this._legend());
  }

  setProject(meta, base, grids, toLocal) {
    this.meta = meta;
    this.grids = grids;
    this.toLocal = toLocal;
    Object.values(this.overlays).forEach((l) => this.map.removeLayer(l));
    if (this.control) this.control.remove();
    this.overlays = {};
    const named = {};
    for (const def of LAYERS) {
      const r = meta.rasters[def.src || def.key];
      if (!r || !meta.rasters[def.key === 'hillshade' ? 'dsm' : def.key]) continue;
      const [w, s, e, n] = r.bounds_lonlat;
      const layer = L.imageOverlay(`${base}/${def.file(meta)}`, [[s, w], [n, e]], { opacity: this.opacity, interactive: false });
      layer._key = def.key;
      this.overlays[def.key] = layer;
      named[def.label?.(meta) || (def.key === 'dom' && meta.rasters.photo ? 'Orthomosaic (LiDAR camera)' : def.name)] = layer;
    }
    (this.overlays.photo || this.overlays.dom || this.overlays.dsm)?.addTo(this.map);
    if (this.aoiLayer) { this.aoiLayer.remove(); this.aoiLayer = null; }
    if (meta.aoi) {
      const a = meta.aoi;
      this.aoiLayer = L.polygon(a.rings_lonlat.map((r) => r.map(([lon, lat]) => [lat, lon])), {
        color: '#ffb703', weight: 3, fillColor: '#ffb703', fillOpacity: 0.08, interactive: false, renderer: this.aoiRenderer,
      }).bindTooltip(`${a.name} · ${(a.area_m2 / 10000).toFixed(2)} ha`, { permanent: true, direction: 'center', className: 'aoitip' });
      if (this.aoiVisible !== false) this.aoiLayer.addTo(this.map);
      named['Area of interest'] = this.aoiLayer;
    }
    this.control = L.control.layers(this.bases, named, { collapsed: false }).addTo(this.map);
    const r = meta.rasters.dsm || meta.rasters.dom;
    if (r) {
      const [w, s, e, n] = r.bounds_lonlat;
      this.map.fitBounds([[s, w], [n, e]], { padding: [20, 20] });
    }
    this.setClip(this.clipOn);
    if (this.profileLine) { this.profileLine.remove(); this.profileLine = null; }
    this._legend();
  }

  // Mask everything outside the AOI buffer (or the AOI itself) and zoom to it.
  setClip(on) {
    this.clipOn = !!on;
    if (this.clipLayer) { this.clipLayer.remove(); this.clipLayer = null; }
    const a = this.meta?.aoi;
    if (!a) return;
    const ring = (rs) => rs.map((r) => r.map(([lon, lat]) => [lat, lon]));
    const clip = ring(a.buffer ? a.buffer.rings_lonlat : a.rings_lonlat);
    this.clipLayer = L.layerGroup();
    if (on) {
      // a world polygon with the clip area as its hole hides the outside
      L.polygon([[[-85, -180], [-85, 180], [85, 180], [85, -180]], ...clip], {
        stroke: false, fillColor: '#04121c', fillOpacity: 0.92, interactive: false, renderer: this.clipRenderer,
      }).addTo(this.clipLayer);
      this.map.fitBounds(L.latLngBounds(clip.flat()), { padding: [30, 30] });
    }
    if (a.buffer) {
      L.polygon(clip, { color: '#ffe08a', weight: 2, dashArray: '6 5', fill: false, interactive: false, renderer: this.aoiRenderer }).addTo(this.clipLayer);
    }
    this.clipLayer.addTo(this.map);
  }

  setAoiVisible(v) {
    this.aoiVisible = v;
    if (!this.aoiLayer) return;
    if (v) this.aoiLayer.addTo(this.map); else this.aoiLayer.remove();
  }

  setOpacity(o) {
    this.opacity = o;
    Object.values(this.overlays).forEach((l) => l.setOpacity(o));
  }

  showProfile(a, b) {
    if (this.profileLine) this.profileLine.remove();
    this.profileLine = null;
    if (!a) return;
    this.profileLine = L.polyline([[a[1], a[0]], [b[1], b[0]]], { color: '#ff7b9c', weight: 3, dashArray: '6 4' }).addTo(this.map);
  }

  invalidate() {
    this.map.invalidateSize();
  }

  _legend() {
    const order = ['ndsm', 'dem', 'dsm'];
    const key = order.find((k) => this.overlays[k] && this.map.hasLayer(this.overlays[k]));
    if (!key) { this.legend.hidden = true; return; }
    const r = this.meta.rasters[key];
    const title = { dsm: 'DSM elevation', dem: 'DEM elevation', ndsm: 'Height above ground' }[key];
    this.legend.hidden = false;
    this.legend.innerHTML = `<div class="lg-title">${title} (m)</div>
      <div class="lg-bar" style="background:${RAMP_CSS}"></div>
      <div class="lg-ticks"><span>${r.z_range[0].toFixed(1)}</span><span>${((r.z_range[0] + r.z_range[1]) / 2).toFixed(1)}</span><span>${r.z_range[1].toFixed(1)}</span></div>`;
  }

  _sample(key, lon, lat) {
    const g = this.grids[key];
    if (!g) return NaN;
    const [w, s, e, n] = g.bounds_lonlat;
    const c = Math.floor(((lon - w) / (e - w)) * g.width);
    const r = Math.floor(((n - lat) / (n - s)) * g.height);
    if (c < 0 || r < 0 || c >= g.width || r >= g.height) return NaN;
    return g.data[r * g.width + c];
  }

  _readout({ lat, lng }) {
    const z0 = this.meta.points.origin[2];
    const dsm = this._sample('dsm', lng, lat) + z0;
    const dem = this._sample('dem', lng, lat) + z0;
    const nd = this._sample('ndsm', lng, lat);
    const [x, y] = this.toLocal(lng, lat);
    const [E0, N0] = this.meta.points.origin;
    const f = (v) => (Number.isFinite(v) ? v.toFixed(2) + ' m' : '—');
    this.readout.innerHTML = `
      <div><b>Lat/Lon</b> ${lat.toFixed(7)}, ${lng.toFixed(7)}</div>
      <div><b>E/N</b> ${(x + E0).toFixed(2)}, ${(y + N0).toFixed(2)}</div>
      <div><b>DSM</b> ${f(dsm)} &nbsp; <b>DEM</b> ${f(dem)} &nbsp; <b>Height</b> ${f(nd)}</div>`;
  }
}
