// The talking face: AI-fragment intro, lip-sync and blinking, all drawn on one canvas.
// Works with any portrait photo. Mouth and eye positions are found automatically
// (MediaPipe face landmarks); if that can't load, sensible defaults are used.

const MP_VER = '0.10.14';
const DEFAULT_MARKS = {
  mouth: { x: 0.5, y: 0.715, w: 0.17 },
  noseY: 0.6,
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

export class Face {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.work = document.createElement('canvas');
    this.wctx = this.work.getContext('2d');
    this.marks = structuredClone(DEFAULT_MARKS);
    this.level = 0; // smoothed mouth opening 0..1
    this.getLevel = () => 0; // set from outside (audio loudness)
    this.mode = 'idle'; // idle | listening | thinking | speaking
    this.blink = { next: performance.now() + 2500, start: 0 };
    this.live = false;
    this._loop = this._loop.bind(this);
  }

  async load(src) {
    const img = await loadImage(src);
    // keep it a sensible size for speed
    const max = 1100;
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.round(img.naturalWidth * s), H = Math.round(img.naturalHeight * s);
    const src2 = document.createElement('canvas');
    src2.width = W; src2.height = H;
    src2.getContext('2d').drawImage(img, 0, 0, W, H);
    this.img = src2;
    this.W = W; this.H = H;
    this.canvas.width = W; this.canvas.height = H;
    this.marks = structuredClone(DEFAULT_MARKS);
    this._buildMasks();
    this.detectPromise = this._detect(src2, src).catch((e) => console.warn('Face landmarks unavailable, using defaults.', e));
    if (!this._raf) this._raf = requestAnimationFrame(this._loop);
  }

  _buildMasks() {
    // horizontal feather used for the jaw and eyelid strips
    const m = document.createElement('canvas');
    m.width = 256; m.height = 4;
    const g = m.getContext('2d').createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.24, 'rgba(0,0,0,1)');
    g.addColorStop(0.76, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    const mc = m.getContext('2d');
    mc.fillStyle = g; mc.fillRect(0, 0, 256, 4);
    this.hMask = m;
  }

  // ------------------------------------------------------------ landmarks
  async _detect(canvas, key) {
    const cacheKey = 'marks:' + hashKey(key) + ':' + canvas.width + 'x' + canvas.height;
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) { this.marks = JSON.parse(cached); return; }
    } catch {}
    const vision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/wasm`);
    const lm = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      },
      runningMode: 'IMAGE',
      numFaces: 1,
    });
    const res = lm.detect(canvas);
    lm.close();
    const p = res.faceLandmarks?.[0];
    if (!p) throw new Error('no face found');
    const pt = (i) => p[i];
    const mid = (a, b) => ({ x: (pt(a).x + pt(b).x) / 2, y: (pt(a).y + pt(b).y) / 2 });
    const mouthC = mid(13, 14);
    const eye = (outer, inner, up, low) => ({
      x: (pt(outer).x + pt(inner).x) / 2,
      y: (pt(up).y + pt(low).y) / 2,
      w: Math.abs(pt(outer).x - pt(inner).x),
      h: Math.max(0.012, Math.abs(pt(up).y - pt(low).y)),
    });
    this.marks = {
      mouth: { x: mouthC.x, y: mouthC.y, w: Math.abs(pt(291).x - pt(61).x) },
      noseY: pt(2).y,
      chinY: pt(152).y,
      eyes: [eye(33, 133, 159, 145), eye(362, 263, 386, 374)],
    };
    try { localStorage.setItem(cacheKey, JSON.stringify(this.marks)); } catch {}
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
  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    if (!this.img) return;
    if (this.intro) { this._drawIntro(now); return; }
    if (!this.live) {
      this.ctx.fillStyle = '#04060a';
      this.ctx.fillRect(0, 0, this.W, this.H);
      return;
    }
    // smooth mouth: fast open, softer close
    const target = clamp(this.getLevel());
    this.level += (target - this.level) * (target > this.level ? 0.55 : 0.28);

    const { ctx, img, W, H } = this;
    ctx.drawImage(img, 0, 0);
    this._drawMouth(this.level);
    this._drawBlink(now);
    if (this.mode === 'thinking') this._drawScan(now);

    // gentle head motion + a little nod while talking
    const t = now / 1000;
    const tx = Math.sin(t * 0.37) * 4 + Math.sin(t * 1.3) * this.level * 2;
    const ty = Math.sin(t * 0.29) * 3 - this.level * 4;
    const rot = Math.sin(t * 0.23) * 0.6 + Math.sin(t * 1.7) * this.level * 0.5;
    const sc = 1 + Math.sin(t * 0.9) * 0.004 + (this.mode === 'listening' ? 0.012 : 0);
    this.canvas.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${sc})`;
  }

  _drawMouth(level) {
    if (level < 0.015) return;
    const { ctx, img, W, H, marks, work, wctx } = this;
    const mx = marks.mouth.x * W, my = marks.mouth.y * H, mw = marks.mouth.w * W;
    const chin = marks.chinY * H;
    const open = level * mw * 0.36;
    const up = open * 0.14;

    // 1) dark inside of the mouth, with a hint of teeth and tongue
    const rx = mw * (0.4 + level * 0.06);
    const top = my - up, bot = my + open;
    const cy = (top + bot) / 2, ry = Math.max(1, (bot - top) / 2);
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(mx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    const g = ctx.createRadialGradient(mx, cy, 0, mx, cy, rx);
    g.addColorStop(0, '#120405');
    g.addColorStop(0.7, '#2a0a0c');
    g.addColorStop(1, '#4a1a1c');
    ctx.fillStyle = g;
    ctx.fillRect(mx - rx, top, rx * 2, bot - top);
    const teethH = Math.min((bot - top) * 0.3, mw * 0.07);
    const tg = ctx.createLinearGradient(0, top, 0, top + teethH);
    tg.addColorStop(0, 'rgba(235,228,218,0.92)');
    tg.addColorStop(1, 'rgba(190,180,170,0.55)');
    ctx.fillStyle = tg;
    ctx.fillRect(mx - rx * 0.7, top, rx * 1.4, teethH);
    ctx.fillStyle = 'rgba(150,50,60,0.55)';
    ctx.beginPath();
    ctx.ellipse(mx, bot, rx * 0.6, (bot - top) * 0.35, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2) upper lip lifts a little
    const sw = mw * 2.4, sx = mx - sw / 2;
    const uTop = my - (my - marks.noseY * H) * 0.7;
    this._strip(sx, uTop, sw, my - uTop, uTop, my - up - uTop);

    // 3) lower lip + jaw stretch downward (neck stays put, so no seam)
    const bottom = Math.min(H, chin + (chin - my) * 0.45);
    this._strip(sx, my, sw, bottom - my, my + open, bottom - my - open);
  }

  // draw an image strip stretched vertically, feathered at the left/right edges
  _strip(sx, sy, sw, sh, dy, dh) {
    if (sh < 1 || dh < 1) return;
    const { work, wctx, ctx, img } = this;
    const w = Math.ceil(sw), h = Math.ceil(dh);
    if (work.width < w) work.width = w;
    if (work.height < h) work.height = h;
    wctx.globalCompositeOperation = 'copy';
    wctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    wctx.globalCompositeOperation = 'destination-in';
    wctx.drawImage(this.hMask, 0, 0, w, h);
    wctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(work, 0, 0, w, h, sx, dy, w, h);
  }

  _drawBlink(now) {
    const b = this.blink;
    if (!b.start && now > b.next) b.start = now;
    if (!b.start) return;
    const t = (now - b.start) / 170;
    if (t >= 1) {
      b.start = 0;
      b.next = now + 2200 + Math.random() * 4200;
      if (Math.random() < 0.15) b.next = now + 220; // double blink sometimes
      return;
    }
    const amt = Math.sin(t * Math.PI); // close then open
    const { W, H } = this;
    for (const e of this.marks.eyes) {
      const ex = e.x * W, ey = e.y * H, ew = e.w * W, eh = Math.max(e.h * H, ew * 0.18);
      const sw = ew * 1.7, sx = ex - sw / 2;
      const lidTop = ey - eh * 2.4;
      const lidBot = ey - eh * 0.55;
      const shut = eh * 1.25 * amt;
      this._strip(sx, lidTop, sw, lidBot - lidTop, lidTop, lidBot - lidTop + shut);
    }
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

function hashKey(s) {
  let h = 2166136261;
  const str = String(s);
  const step = Math.max(1, Math.floor(str.length / 4000));
  for (let i = 0; i < str.length; i += step) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + str.length;
}
