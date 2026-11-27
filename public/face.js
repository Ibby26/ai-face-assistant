// The talking face: AI-fragment intro, then a realistic talking photo.
// The photo is wrapped on a face mesh (see mesh.js) that moves like a real
// jaw, lips and eyelids. Works with any front-facing portrait: the face's
// landmarks are found automatically by MediaPipe, served from this app.

import { buildRig, MeshRenderer, landmarksFromMediaPipe, syntheticLandmarks } from './mesh.js';
import { Morph } from './morph.js';
import { Expressions, MOODS } from './expressions.js';

const DEFAULT_MARKS = {
  mouth: { x: 0.5, y: 0.715, w: 0.17 },
  chinY: 0.86,
  eyes: [
    { x: 0.385, y: 0.47, w: 0.09, h: 0.03 },
    { x: 0.615, y: 0.47, w: 0.09, h: 0.03 },
  ],
};

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let landmarkerPromise = null;
function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import('/mp/vision_bundle.mjs');
      const fileset = await vision.FilesetResolver.forVisionTasks('/mp/wasm');
      const opts = (path) => ({ baseOptions: { modelAssetPath: path }, runningMode: 'IMAGE', numFaces: 1 });
      try {
        return await vision.FaceLandmarker.createFromOptions(fileset, opts('/models/face_landmarker.task'));
      } catch {
        return await vision.FaceLandmarker.createFromOptions(fileset,
          opts('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'));
      }
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

export class Face {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.level = 0; // smoothed jaw opening 0..1
    this.width = 1; // smoothed lip width (<1 rounded, >1 spread)
    this.teeth = 0.5; // smoothed teeth visibility
    this.getLevel = () => 0; // set from outside (audio loudness)
    this.getShape = () => null; // set from outside: {open, width, teeth} for the current sound
    this.mode = 'idle'; // idle | listening | thinking | speaking
    this.blink = { next: performance.now() + 2500, start: 0 };
    this.live = false;
    this.debug = false;
    this.found = false; // true when real landmarks were found
    this.morph = null;
    this.morphOn = true; // keep blending in features from other faces
    this.expr = null; // expressions + eye movement
    this.mood = 'neutral'; // set from the answer: happy, sad, surprised, ...
    this.getUser = () => null; // where you are ({x, y} -1..1) when the camera can see you
    this.gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 0 };
    this._loop = this._loop.bind(this);
  }

  async load(src) {
    const img = await loadImage(src);
    const max = 1100;
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.round(img.naturalWidth * s), H = Math.round(img.naturalHeight * s);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(img, 0, 0, W, H);
    this.img = c;
    this.W = W; this.H = H;
    this.canvas.width = W; this.canvas.height = H;
    this.renderer = null;
    this.morph = null;
    this.expr = null;
    this.found = false;
    const token = (this._token = {});
    // build the rig in the background while the intro plays
    this.rigPromise = this._buildRig(c, token).catch((e) => console.warn('Face rig failed:', e));
    if (!this._raf) this._raf = requestAnimationFrame(this._loop);
  }

  async _buildRig(canvas, token) {
    const { W, H } = this;
    let lm = null;
    try {
      const det = await getLandmarker();
      const res = det.detect(canvas);
      const p = res.faceLandmarks?.[0];
      if (p) { lm = landmarksFromMediaPipe(p, W, H); this.found = true; }
      else console.warn('No face found in the picture; using an approximate face layout.');
    } catch (e) {
      console.warn('Face landmarks unavailable, using an approximate face layout.', e);
    }
    if (!lm) lm = syntheticLandmarks(W, H, DEFAULT_MARKS);
    if (token !== this._token) return;
    const rig = buildRig(W, H, lm);
    this.renderer = new MeshRenderer(W, H, canvas, rig);
    this.expr = this.found ? new Expressions(rig, lm) : null;
    if (this.found) {
      this.morph = new Morph(rig, lm, canvas, this.renderer);
      this._loadDonors(token);
    }
  }

  // other people's faces for the morph. New AI-generated people are pulled
  // live from the internet (nothing is saved), and fresh ones keep replacing
  // older ones so the face never repeats. Your own photos in public/faces
  // (optional) are mixed in too.
  async _loadDonors(token) {
    const alive = () => token === this._token;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const seen = new Set();
    const prep = async (url) => {
      const img = await loadImage(url);
      const s = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, c.width, c.height);
      // skip exact repeats
      const d = x.getImageData(c.width >> 1, c.height >> 1, 4, 4).data.join(',');
      if (seen.has(d)) return null;
      seen.add(d);
      const det = await getLandmarker();
      const p = det.detect(c).faceLandmarks?.[0];
      return p ? { c, lm: landmarksFromMediaPipe(p, c.width, c.height) } : null;
    };
    try {
      const own = (await (await fetch('/api/faces')).json()).faces || [];
      for (const url of own) {
        if (!alive()) return;
        try { const f = await prep(url); if (f) this.morph.addDonor(f.c, f.lm); } catch {}
      }
    } catch {}
    let n = 0, fails = 0;
    while (alive()) {
      try {
        const f = await prep('/api/liveface?n=' + Date.now() + '-' + n++);
        if (f && alive()) {
          if (this.morph.faceCount < 9) this.morph.addDonor(f.c, f.lm);
          else this.morph.replaceDonor(f.c, f.lm);
        }
        fails = 0;
      } catch { fails++; }
      // fill up quickly at first, then bring in a new person every ~20 seconds;
      // if the internet hiccups, wait a bit longer each time and try again
      await sleep(fails ? Math.min(60000, 5000 * fails) : this.morph.faceCount < 9 ? 1300 : 20000);
    }
  }

  // ------------------------------------------------------------ intro
  // Hundreds of glowing shards fly in, each showing the wrong part of the face,
  // then slide into place until they form the real face.
  playIntro(duration = 3200) {
    const { W, H } = this;
    const cols = 15, rows = Math.round(15 * H / W);
    const pts = [];
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const edge = r === 0 || c === 0 || r === rows || c === cols;
        const jx = edge ? 0 : (Math.random() - 0.5) * 0.7;
        const jy = edge ? 0 : (Math.random() - 0.5) * 0.7;
        pts.push({ x: ((c + jx) / cols) * W, y: ((r + jy) / rows) * H });
      }
    }
    const P = (r, c) => pts[r * (cols + 1) + c];
    const tris = [];
    const cx0 = W / 2, cy0 = H * 0.5;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = P(r, c), b = P(r, c + 1), d = P(r + 1, c), e = P(r + 1, c + 1);
        const flip = Math.random() < 0.5;
        const pair = flip ? [[a, b, e], [a, e, d]] : [[a, b, d], [b, e, d]];
        for (const v of pair) {
          const cx = (v[0].x + v[1].x + v[2].x) / 3, cy = (v[0].y + v[1].y + v[2].y) / 3;
          const ang = Math.random() * Math.PI * 2;
          const dist = (0.5 + Math.random()) * Math.max(W, H) * 0.9;
          const fromCenter = Math.hypot(cx - cx0, cy - cy0) / Math.max(W, H);
          // expand slightly so neighbours overlap (no hairline seams)
          const vv = v.map((p) => {
            const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1;
            return { x: p.x + (dx / l) * 0.8, y: p.y + (dy / l) * 0.8 };
          });
          const minX = Math.min(...vv.map((p) => p.x)), maxX = Math.max(...vv.map((p) => p.x));
          const minY = Math.min(...vv.map((p) => p.y)), maxY = Math.max(...vv.map((p) => p.y));
          tris.push({
            v: vv, cx, cy, minX, minY, bw: maxX - minX, bh: maxY - minY,
            ox: Math.cos(ang) * dist, oy: Math.sin(ang) * dist,
            rot: (Math.random() - 0.5) * 5,
            sc: 0.3 + Math.random() * 1.4,
            tx: (Math.random() - 0.5) * W * 0.6, ty: (Math.random() - 0.5) * H * 0.6,
            delay: 0.05 + fromCenter * 0.55 + Math.random() * 0.25,
          });
        }
      }
    }
    this.intro = { tris, start: performance.now(), dur: duration / 1000 };
    return new Promise((resolve) => { this.intro.resolve = resolve; });
  }

  _drawIntro(now) {
    const { ctx, W, H, img, intro } = this;
    const t = (now - intro.start) / 1000;
    const k = t / intro.dur; // 0..1 over whole intro
    const pieceDur = intro.dur * 0.55;
    ctx.save();
    ctx.fillStyle = '#04060a';
    ctx.fillRect(0, 0, W, H);
    let allDone = true;
    for (const tr of intro.tris) {
      const raw = clamp((t - tr.delay * intro.dur * 0.6) / pieceDur);
      if (raw < 1) allDone = false;
      if (raw <= 0) continue;
      const p = easeOut(raw);
      const texP = easeInOut(clamp((raw - 0.25) / 0.75));
      ctx.save();
      ctx.globalAlpha = clamp(raw * 4);
      ctx.translate(tr.cx + tr.ox * (1 - p), tr.cy + tr.oy * (1 - p));
      ctx.rotate(tr.rot * (1 - p));
      const s = lerp(tr.sc, 1, p);
      ctx.scale(s, s);
      ctx.translate(-tr.cx, -tr.cy);
      ctx.beginPath();
      ctx.moveTo(tr.v[0].x, tr.v[0].y); ctx.lineTo(tr.v[1].x, tr.v[1].y); ctx.lineTo(tr.v[2].x, tr.v[2].y);
      ctx.closePath();
      ctx.save();
      ctx.clip();
      // texture comes from the wrong place first, then slides to the right place
      const sx = clamp(tr.minX + tr.tx * (1 - texP), 0, W - tr.bw);
      const sy = clamp(tr.minY + tr.ty * (1 - texP), 0, H - tr.bh);
      ctx.drawImage(img, sx, sy, tr.bw, tr.bh, tr.minX, tr.minY, tr.bw, tr.bh);
      // cool AI tint that fades out
      const tint = 1 - texP;
      if (tint > 0.01) {
        ctx.globalCompositeOperation = 'soft-light';
        ctx.fillStyle = `rgba(80,200,255,${0.7 * tint})`;
        ctx.fillRect(tr.minX, tr.minY, tr.bw, tr.bh);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
      const edge = (1 - p) * 0.9 + 0.12 * (1 - k);
      if (edge > 0.02) {
        ctx.strokeStyle = `rgba(120,220,255,${edge})`;
        ctx.lineWidth = 1.2 / s;
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    // final scan line that "locks in" the face
    if (allDone || k >= 1) {
      const scanT = clamp((t - Math.max(intro.doneAt ?? (intro.doneAt = t), 0)) / 0.6);
      ctx.drawImage(img, 0, 0);
      const y = scanT * H;
      const g = ctx.createLinearGradient(0, y - 60, 0, y + 4);
      g.addColorStop(0, 'rgba(79,209,255,0)');
      g.addColorStop(1, 'rgba(79,209,255,0.55)');
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = g;
      ctx.fillRect(0, y - 60, W, 64);
      ctx.globalCompositeOperation = 'source-over';
      if (scanT >= 1) {
        const r = intro.resolve;
        this.intro = null;
        this.live = true;
        r?.();
      }
    }
  }


  // ------------------------------------------------------------ live face
  // mouth: follow the shape of the current sound (or just loudness),
  // quick to open, a little softer to close, like real lips
  _mouth() {
    const shape = this.getShape();
    const tOpen = clamp(shape ? shape.open : this.getLevel());
    const tWidth = shape ? shape.width : 1 + this.level * 0.03;
    const tTeeth = shape ? shape.teeth : 0.5;
    // shapes come pre-timed from the audio, so follow them closely (little lag)
    this.level += (tOpen - this.level) * (tOpen > this.level ? 0.7 : 0.5);
    this.width += (tWidth - this.width) * 0.45;
    this.teeth += (tTeeth - this.teeth) * 0.4;
  }

  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    // face turned off: keep following the voice (the hologram orb uses it)
    // but don't draw anything
    if (this.hidden) { this._mouth(); return; }
    if (!this.img) return;
    if (this.intro) { this._drawIntro(now); return; }
    const { ctx, W, H } = this;
    if (!this.live) {
      ctx.fillStyle = '#04060a';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    this._mouth();
    const blink = this._blinkAmount(now);

    if (this.renderer) {
      const m = this.morphOn && this.morph ? this.morph.update(now) : null;
      let rest = m?.rest || null;
      if (this.expr) {
        const name = this.mode === 'listening' ? 'listening' : this.mode === 'thinking' ? 'thinking' : this.mood;
        const target = { ...(MOODS[name] || MOODS.neutral) };
        // a smile relaxes while the mouth is busy forming words
        if (target.smile) target.smile *= 1 - Math.min(0.55, this.level * 0.8);
        rest = this.expr.apply(target, this.gaze, rest);
      }
      ctx.drawImage(this.renderer.render({ open: this.level, width: this.width, teeth: this.teeth, blink, rest, layers: m?.layers }), 0, 0);
      if (this.debug) this.renderer.drawDebug(ctx);
    } else {
      ctx.drawImage(this.img, 0, 0);
    }
    if (this.mode === 'thinking') this._drawScan(now);

    this._updateGaze(now);
    // gentle head motion + a little nod while talking, turned toward you
    const t = now / 1000;
    const tx = Math.sin(t * 0.37) * 4 + Math.sin(t * 1.3) * this.level * 1.5;
    const ty = Math.sin(t * 0.29) * 3 - this.level * 2.5;
    const rot = Math.sin(t * 0.23) * 0.6 + Math.sin(t * 1.7) * this.level * 0.4;
    const sc = 1 + Math.sin(t * 0.9) * 0.004 + (this.mode === 'listening' ? 0.012 : 0);
    const gx = this.gaze.x, gy = this.gaze.y;
    this.canvas.style.transform = `perspective(1600px) translate(${tx + gx * 6}px, ${ty + gy * 4}px) rotateY(${gx * 7}deg) rotateX(${-gy * 4}deg) rotate(${rot}deg) scale(${sc})`;
  }

  // where the eyes look: at you when the camera sees you; otherwise small
  // natural glances, and up to the side while thinking
  _updateGaze(now) {
    const g = this.gaze;
    const you = this.getUser();
    if (you) { g.tx = you.x; g.ty = you.y; }
    else if (this.mode === 'thinking') { g.tx = 0.45; g.ty = -0.55; }
    else if (now > g.next) {
      const away = Math.random() < 0.3;
      g.tx = away ? (Math.random() - 0.5) * 0.7 : (Math.random() - 0.5) * 0.12;
      g.ty = away ? (Math.random() - 0.5) * 0.4 : (Math.random() - 0.5) * 0.08;
      g.next = now + (away ? 600 + Math.random() * 700 : 1800 + Math.random() * 2600);
    }
    // eyes jump quickly (saccades), like real ones
    const k = you ? 0.25 : 0.3;
    g.x += (g.tx - g.x) * k;
    g.y += (g.ty - g.y) * k;
  }

  _blinkAmount(now) {
    const b = this.blink;
    if (!b.start && now > b.next) b.start = now;
    if (!b.start) return 0;
    const t = (now - b.start) / 190;
    if (t >= 1) {
      b.start = 0;
      b.next = now + 2200 + Math.random() * 4200;
      if (Math.random() < 0.15) b.next = now + 240; // double blink sometimes
      return 0;
    }
    // close fast, open a little slower
    return t < 0.4 ? Math.sin((t / 0.4) * Math.PI / 2) : Math.cos(((t - 0.4) / 0.6) * Math.PI / 2);
  }

  _drawScan(now) {
    const { ctx, W, H } = this;
    const y = ((now / 1400) % 1) * H;
    const g = ctx.createLinearGradient(0, y - 90, 0, y);
    g.addColorStop(0, 'rgba(163,107,255,0)');
    g.addColorStop(1, 'rgba(120,200,255,0.22)');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 90, W, 90);
    ctx.restore();
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load face image ' + String(src).slice(0, 60)));
    img.src = src;
  });
}
