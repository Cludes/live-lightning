'use strict';

const CONFIG = {
  CENTER: [20, 0], ZOOM: 3, MIN_ZOOM: 2, MAX_ZOOM: 10,
  LIFE_MS: 2200,                 // how long each strike flash lasts
  TILE: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  ATTR: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> | strikes: <a href="https://www.blitzortung.org">Blitzortung.org</a> contributors',
  WS: ['wss://ws1.blitzortung.org/', 'wss://ws7.blitzortung.org/', 'wss://ws8.blitzortung.org/'],
};

// Blitzortung sends LZW-compressed JSON frames.
function decode(b) {
  const d = ('' + b).split(''); let c = d[0], f = c, g = [c], o = 256; const e = {};
  for (let i = 1; i < d.length; i++) {
    let a = d[i].charCodeAt(0);
    a = 256 > a ? d[i] : (e[a] ? e[a] : f + c);
    g.push(a); c = a.charAt(0); e[o] = f + c; o++; f = a;
  }
  return g.join('');
}

// ── Solar terminator (subtle night shading) ───────────────────────────────────
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
function terminatorPolygon(date) {
  const jd = date.getTime() / 86400000 + 2440587.5, T = jd - 2451545.0;
  const g = (357.529 + 0.98560028 * T) * D2R, q = 280.459 + 0.98564736 * T;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const e = (23.439 - 0.00000036 * T) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) * R2D;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)) * R2D;
  const gmst = (18.697374558 + 24.06570982441908 * T) % 24;
  const pts = [];
  for (let lng = -180; lng <= 180; lng += 1) {
    const ha = (gmst * 15 + lng - ra) * D2R;
    pts.push([Math.atan(-Math.cos(ha) / Math.tan(dec * D2R)) * R2D, lng]);
  }
  pts.push([dec > 0 ? -90 : 90, 180], [dec > 0 ? -90 : 90, -180]);
  return pts;
}

class Lightning {
  constructor() {
    this.map = null; this.canvas = null; this.ctx = null; this.dpr = 1;
    this.strikes = [];        // {lat,lon,t}
    this.recent = [];         // timestamps for strikes/min
    this.total = 0;
    this.ws = null; this.wsIdx = 0; this.terminator = null;
  }

  init() {
    this.map = L.map('map', {
      center: CONFIG.CENTER, zoom: CONFIG.ZOOM, minZoom: CONFIG.MIN_ZOOM, maxZoom: CONFIG.MAX_ZOOM,
      zoomControl: true, maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1.0,
    });
    L.tileLayer(CONFIG.TILE, { attribution: CONFIG.ATTR, subdomains: 'abcd', maxZoom: 20, noWrap: true }).addTo(this.map);
    this.fitWidth();
    this.updateTerminator(); setInterval(() => this.updateTerminator(), 60000);

    const c = document.createElement('canvas'); c.className = 'strike-canvas';
    this.map.getContainer().appendChild(c); this.canvas = c; this.ctx = c.getContext('2d');
    this.sizeCanvas();
    this.map.on('resize', () => { this.sizeCanvas(); this.fitWidth(); });

    this.connect();
    this.loop();
    setInterval(() => this.updateStats(), 1000);
  }

  // Keep the no-wrap world filling the viewport width (no dead margins) at any screen size.
  fitWidth() {
    const w = this.map.getSize().x;
    const mz = Math.ceil(Math.log2(w / 256));
    this.map.setMinZoom(mz);
    if (this.map.getZoom() < mz) this.map.setView(this.map.getCenter(), mz, { animate: false });
  }

  sizeCanvas() {
    const s = this.map.getSize(); this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = s.x * this.dpr; this.canvas.height = s.y * this.dpr;
    this.canvas.style.width = s.x + 'px'; this.canvas.style.height = s.y + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  updateTerminator() {
    const pts = terminatorPolygon(new Date());
    if (this.terminator) this.terminator.setLatLngs(pts);
    else this.terminator = L.polygon(pts, { stroke: false, fillColor: '#000010', fillOpacity: 0.30, interactive: false }).addTo(this.map);
  }

  connect() {
    const url = CONFIG.WS[this.wsIdx % CONFIG.WS.length];
    this.setStatus('loading');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.reconnect(); return; }
    this.ws = ws;
    ws.onopen = () => { this.setStatus('ok'); ws.send(JSON.stringify({ a: 111 })); };
    ws.onmessage = (ev) => {
      try {
        const s = JSON.parse(decode(ev.data));
        if (s && typeof s.lat === 'number' && typeof s.lon === 'number') this.addStrike(s.lat, s.lon);
      } catch (e) { /* ignore non-strike frames */ }
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    ws.onclose = () => { this.setStatus('err'); this.reconnect(); };
  }
  reconnect() {
    this.wsIdx++;
    clearTimeout(this._rc);
    this._rc = setTimeout(() => this.connect(), 2000);
  }

  addStrike(lat, lon) {
    const t = performance.now();
    this.strikes.push({ lat, lon, t });
    this.recent.push(Date.now());
    this.total++;
  }

  loop() {
    const tick = () => {
      this.draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  draw() {
    const ctx = this.ctx, sz = this.map.getSize(), now = performance.now(), LIFE = CONFIG.LIFE_MS;
    ctx.clearRect(0, 0, sz.x, sz.y);
    // prune
    if (this.strikes.length > 4000) this.strikes.splice(0, this.strikes.length - 4000);
    let alive = 0;
    for (let i = 0; i < this.strikes.length; i++) {
      const s = this.strikes[i];
      const age = now - s.t; if (age > LIFE) continue;
      const pt = this.map.latLngToContainerPoint([s.lat, s.lon]);
      if (pt.x < -30 || pt.y < -30 || pt.x > sz.x + 30 || pt.y > sz.y + 30) continue;
      alive++;
      const p = age / LIFE;          // 0..1
      const fade = 1 - p;
      // expanding ring
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2 + p * 22, 0, 7);
      ctx.strokeStyle = `rgba(150,225,255,${fade * 0.5})`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      // hot core (bright early, fades)
      const cr = 3.2 * (1 - p * 0.5);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, cr, 0, 7);
      ctx.fillStyle = `rgba(255,250,224,${Math.min(1, fade * 1.6)})`;
      ctx.shadowColor = 'rgba(255,240,150,0.9)'; ctx.shadowBlur = 10 * fade;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    // drop fully-faded from the front occasionally
    if (this.strikes.length && now - this.strikes[0].t > LIFE) {
      this.strikes = this.strikes.filter(s => now - s.t <= LIFE);
    }
    this.setLive(alive);
  }

  updateStats() {
    const cut = Date.now() - 60000;
    this.recent = this.recent.filter(t => t >= cut);
    const el = document.getElementById('rate'); if (el) el.textContent = this.recent.length.toLocaleString();
    const tot = document.getElementById('total'); if (tot) tot.textContent = this.total.toLocaleString();
  }
  setLive(n) { const el = document.getElementById('live'); if (el) el.textContent = n.toLocaleString(); }
  setStatus(s) {
    const el = document.getElementById('status'); if (!el) return;
    el.className = 'dot ' + ({ ok: 'ok', err: 'err', loading: 'loading' }[s] || '');
    el.title = { ok: 'connected', err: 'reconnecting…', loading: 'connecting…' }[s] || '';
  }
}

const app = new Lightning();
app.init();
