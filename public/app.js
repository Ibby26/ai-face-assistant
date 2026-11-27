import { Face } from './face.js';
import { shapeAt, shapeFor, mix, SHAPES } from './visemes.js';
import { Holo } from './holo.js';
import { Presence } from './presence.js';

const $ = (s) => document.querySelector(s);
const face = new Face($('#face'));
let config = { claude: false, voice: false, aiImages: false, face: null };
const history = [];
let current = null; // the answer in progress

// ================================================================= audio out
// Each sentence is turned into speech as soon as Claude writes it, and played
// in order through an analyser that drives the mouth.
let actx, analyser, levelBuf;
function audioCtx() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = actx.createAnalyser();
    analyser.fftSize = 1024;
    levelBuf = new Float32Array(analyser.fftSize);
    analyser.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

let fakeTalk = false; // browser voice: we can't hear it, so animate a natural rhythm
face.getLevel = () => {
  if (fakeTalk) {
    const t = performance.now() / 1000;
    const v = 0.5 + 0.5 * Math.sin(t * 13) * Math.sin(t * 3.1 + 1) + 0.2 * Math.sin(t * 27);
    return clamp(v * 0.75);
  }
  if (!analyser || !speaker.playing) return 0;
  analyser.getFloatTimeDomainData(levelBuf);
  let sum = 0;
  for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
  const rms = Math.sqrt(sum / levelBuf.length);
  return clamp((rms - 0.012) * 7.5);
};
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

// Mouth shape for the sound being spoken right now.
// ElevenLabs tells us when every letter is spoken; loudness adds natural energy.
face.getShape = () => {
  const cur = speaker.cur;
  if (cur && speaker.playing && actx) {
    // where we are in this sentence's audio, as you hear it. Lips move a
    // fraction of a second before the sound (as real speakers' do), plus your
    // own adjustment from Settings for slow speakers or Bluetooth headphones.
    const heard = actx.currentTime - cur.startAt - (actx.outputLatency || actx.baseLatency || 0);
    const t = heard + 0.06 + lipOffset() / 1000;
    // how loud the voice is right then, read straight from the audio itself,
    // so the mouth is open exactly when there is sound and closed in pauses
    const env = envAt(cur.env, t);
    if (!cur.align) return { open: clamp(env * 0.9), width: 1 + env * 0.05, teeth: 0.5 };
    const s = shapeAt(cur.align, t + 0.02);
    const open = s.closed ? env * 0.04 : clamp(Math.pow(env, 0.8) * (0.3 + 0.85 * s.open));
    return { open, width: s.width, teeth: s.teeth };
  }
  if (fakeTalk && browserWord.text) {
    // browser voice: we only know which word is being said, so step through
    // its letters at a natural speaking pace
    const t = (performance.now() - browserWord.at) / 1000;
    const i = Math.floor(t * 13);
    if (i >= browserWord.text.length) return SHAPES.rest;
    const a = shapeFor(browserWord.text[i], i) || SHAPES.rest;
    const b = shapeFor(browserWord.text[i + 1], i + 1) || SHAPES.rest;
    return mix(a, b, clamp((t * 13 - i - 0.5) * 0.8));
  }
  return null; // fall back to loudness only
};
const browserWord = { text: '', at: 0 };
const lipOffset = () => Number(document.querySelector('#lipOffset')?.value || 0);

// loudness of an AudioBuffer every 10 ms, scaled so normal speech is ~0.8
function envelope(buf) {
  const data = buf.getChannelData(0), step = Math.round(buf.sampleRate / 100);
  const env = new Float32Array(Math.ceil(data.length / step));
  for (let i = 0; i < env.length; i++) {
    let s = 0; const a = i * step, b = Math.min(data.length, a + step);
    for (let j = a; j < b; j++) s += data[j] * data[j];
    env[i] = Math.sqrt(s / Math.max(1, b - a));
  }
  const sorted = Array.from(env).sort((x, y) => x - y);
  const ref = sorted[Math.floor(sorted.length * 0.92)] || 1;
  const floor = ref * 0.12;
  for (let i = 0; i < env.length; i++) env[i] = clamp((env[i] - floor) / (ref - floor) * 0.85);
  return env;
}
function envAt(env, t) {
  if (!env || t < 0) return 0;
  const x = t * 100, i = Math.floor(x);
  if (i >= env.length - 1) return i === env.length - 1 ? env[i] : 0;
  return env[i] + (env[i + 1] - env[i]) * (x - i);
}

class Speaker {
  constructor() { this.reset(); }
  reset() {
    this.gen = (this.gen || 0) + 1;
    this.queue = [];
    this.playing = false;
    this.node?.stop?.();
    this.node = null;
    this.cur = null;
    if (window.speechSynthesis) speechSynthesis.cancel();
    fakeTalk = false;
    this.pending = '';
    this.spoken = '';
    this.finished = false;
    this.lang = '';
  }
  // feed streaming text; split into sentences
  push(text) {
    this.pending += text;
    for (;;) {
      const firstChunk = !this.spoken && !this.queue.length;
      const m = this.pending.match(/^[\s\S]*?[.!?。！？…;:](?:["'”’)\]]*)(?=\s|$)/);
      let chunk = null;
      if (m && m[0].trim().length >= (firstChunk ? 12 : 30)) chunk = m[0];
      else if (m && this.pending.length > m[0].length + 1 && m[0].trim().length > 0) {
        // short sentence: merge with the next one unless it's the first (speed!)
        const m2 = this.pending.slice(m[0].length).match(/^[\s\S]*?[.!?。！？…](?=\s|$)/);
        if (m2) chunk = m[0] + m2[0];
        else if (firstChunk) chunk = m[0];
      } else if (firstChunk && this.pending.length > 90) {
        const cut = Math.max(this.pending.lastIndexOf(', ', 90), this.pending.lastIndexOf(' ', 90));
        if (cut > 30) chunk = this.pending.slice(0, cut + 1);
      }
      if (!chunk) break;
      this.pending = this.pending.slice(chunk.length);
      this._say(chunk.trim());
    }
  }
  end() {
    if (this.pending.trim()) this._say(this.pending.trim());
    this.pending = '';
    this.finished = true;
    this._maybeDone();
  }
  _say(text) {
    if (!text.replace(/[\s.,!?…]/g, '')) return;
    const gen = this.gen;
    const item = { text, audio: null };
    if (config.voice) {
      item.audio = fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, previous: this.spoken.slice(-300), voice: $('#voice').value || undefined, speed: voiceSpeed() }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('tts ' + r.status))))
        .then(async (j) => {
          const bin = Uint8Array.from(atob(j.audio), (c) => c.charCodeAt(0));
          const buffer = await audioCtx().decodeAudioData(bin.buffer);
          const align = j.chars?.length ? { chars: j.chars, starts: j.starts, ends: j.ends } : null;
          return { buffer, align, env: envelope(buffer) };
        })
        .catch((e) => { console.warn(e); return null; });
    }
    this.spoken += ' ' + text;
    this.queue.push(item);
    if (!this.playing) this._next(gen);
  }
  async _next(gen) {
    if (gen !== this.gen) return;
    const item = this.queue.shift();
    if (!item) { this.playing = false; this._maybeDone(); return; }
    this.playing = true;
    setMode('speaking');
    const got = item.audio ? await item.audio : null;
    if (gen !== this.gen) return;
    if (got) {
      const node = audioCtx().createBufferSource();
      node.buffer = got.buffer;
      node.connect(analyser);
      this.node = node;
      node.onended = () => { this.cur = null; this._next(gen); };
      const startAt = actx.currentTime + 0.02;
      this.cur = { startAt, align: got.align, env: got.env };
      node.start(startAt);
    } else {
      await this._browserSay(item.text, gen);
      this._next(gen);
    }
  }
  _browserSay(text, gen) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return setTimeout(resolve, 60 * text.length);
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.lang || guessLang(text);
      const chosen = voices.find((x) => x.name === $('#voice').value && x.lang.toLowerCase().startsWith(u.lang.toLowerCase().split('-')[0]));
      const v = chosen || pickVoice(u.lang);
      if (v) u.voice = v;
      u.rate = 1.05 * voiceSpeed();
      u.onstart = () => { if (gen === this.gen) fakeTalk = true; };
      u.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        const rest = text.slice(e.charIndex);
        browserWord.text = rest.slice(0, e.charLength || (rest.match(/^\S+/)?.[0].length ?? 0));
        browserWord.at = performance.now();
      };
      u.onend = u.onerror = () => { fakeTalk = false; resolve(); };
      speechSynthesis.speak(u);
    });
  }
  _maybeDone() {
    if (this.finished && !this.playing && !this.queue.length) {
      this.onDone?.();
    }
  }
}
const speaker = new Speaker();

let voices = [];
function loadVoices() { voices = window.speechSynthesis?.getVoices() || []; }
loadVoices();
window.speechSynthesis?.addEventListener?.('voiceschanged', loadVoices);
function pickVoice(lang) {
  const l = (lang || '').toLowerCase();
  const base = l.split('-')[0];
  const cands = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  return cands.find((v) => /natural|neural|premium|enhanced|google/i.test(v.name)) || cands[0] || null;
}
function guessLang(text) {
  if (/[؀-ۿ]/.test(text)) return 'ar';
  if (/[֐-׿]/.test(text)) return 'he';
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[가-힯]/.test(text)) return 'ko';
  if (/[ऀ-ॿ]/.test(text)) return 'hi';
  if (/[฀-๿]/.test(text)) return 'th';
  if (/[Ͱ-Ͽ]/.test(text)) return 'el';
  return micLang() && micLang() !== 'auto' ? micLang() : navigator.language;
}

// ================================================================= pictures
// Real photos (Wikipedia + Wikimedia Commons, instant and free) mixed with
// AI-generated pictures that fade in when they're ready.
const pics = {
  pool: [], // {url, ai, caption}
  seen: new Set(),
  timer: null,
  gen: 0,
  bgIdx: 0,
  slots: [],
};

function resetPictures() {
  pics.gen++;
  pics.pool = [];
  pics.seen.clear();
}

function addPic(url, caption, ai = false, front = false, w = 0) {
  if (!url || pics.seen.has(url)) return;
  pics.seen.add(url);
  const gen = pics.gen;
  const im = new Image();
  im.referrerPolicy = 'no-referrer';
  im.decoding = 'async';
  im.onload = () => {
    if (gen !== pics.gen) return;
    // never show a picture that would be blown up and blurry
    if (!ai && (im.naturalWidth < 700 || im.naturalHeight < 400)) return;
    const item = { url, caption, ai, img: im, w: w || im.naturalWidth };
    if (front || ai) pics.pool.unshift(item); else pics.pool.push(item);
    if (!pics.timer) startPictures();
  };
  im.src = url;
}

// Only pictures that are really about the subject: the picture's title must
// share the important words of the search, and small originals are skipped.
const STOP = new Set('the and for with from that this what when where which who how why are was were its his her their about into over under after before during between of in on at to by an a or as is be de la le el du des und der die das del'.split(' '));
const keywords = (s) => [...new Set(s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u)
  .filter((w) => w && (w.length > 2 || /^\d+$/.test(w)) && !STOP.has(w)))];
function matchScore(term, caption) {
  const k = keywords(term);
  if (!k.length) return 0;
  const cap = keywords(caption);
  const hit = (w) => cap.some((c) => c === w || (w.length >= 5 && c.length >= 5 && c.slice(0, 5) === w.slice(0, 5)));
  return k.filter(hit).length / k.length;
}
const JUNK = /\b(logo|icon|signature|coat of arms|emblem|seal of|flag of|map of|locator|diagram|chart|graph|stamp|banknote|coin|button|symbol|svg)\b/i;
const tidy = (t) => t.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');

async function findPhotos(term, { limit = 6 } = {}) {
  if (!term) return;
  const gen = pics.gen;
  const q = encodeURIComponent(term);
  const junkOk = JUNK.test(term);
  const getJson = async (url) => { try { const j = await (await fetch(url)).json(); return gen === pics.gen ? j : null; } catch { return null; } };
  const pagesOf = (j) => Object.values(j?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const wikiPic = (p) => {
    const o = p.original, t = p.thumbnail;
    if (!t?.source || /\.svg/i.test(t.source) || !o || o.width < 800 || o.height < 450) return;
    if (!junkOk && JUNK.test(tidy(decodeURIComponent(o.source.split('/').pop() || '')))) return;
    addPic(t.source, p.title, false, false, Math.min(o.width, 1600));
  };
  const img = 'prop=pageimages&piprop=thumbnail|original&pithumbsize=1600';
  await Promise.all([
    // 1. the exact Wikipedia article (Claude names articles by their title)
    getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&titles=${q}&${img}`)
      .then((j) => pagesOf(j).forEach(wikiPic)),
    // 2. the top few articles found by search, if their title fits the subject
    getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${q}&gsrlimit=3&${img}`)
      .then((j) => pagesOf(j).forEach((p) => { if (matchScore(term, p.title) >= 0.6) wikiPic(p); })),
    // 3. large Commons photos whose title matches most of the search words
    getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrsearch=${q}%20filetype:bitmap&gsrlimit=${limit}&prop=imageinfo&iiprop=url|size&iiurlwidth=1600`)
      .then((j) => pagesOf(j).forEach((p) => {
        const ii = p.imageinfo?.[0];
        const cap = tidy(p.title);
        if (!ii?.thumburl || /\.(svg|tiff?|pdf|gif)$/i.test(p.title) || ii.width < 1000 || ii.height < 560) return;
        if (ii.width / ii.height > 2.6 || ii.height / ii.width > 1.6) return; // panoramas, tall scans
        if (!junkOk && JUNK.test(cap)) return;
        if (matchScore(term, cap) < 0.6) return;
        addPic(ii.thumburl, cap, false, false, Math.min(ii.width, 1600));
      })),
  ]);
}

let aiCount = 0;
async function makeAiImage(prompt) {
  if (!config.aiImages || !$('#aiImgs').checked || aiCount >= 5) return;
  aiCount++;
  const gen = pics.gen;
  try {
    const r = await fetch('/api/genimage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
    });
    if (!r.ok || gen !== pics.gen) return;
    const { url } = await r.json();
    addPic(url, prompt, true, true);
  } catch {}
}

let picsActiveUntil = 0;
function startPictures() {
  if (pics.timer) return;
  let tick = 0;
  pics.timer = setInterval(() => {
    if (performance.now() > picsActiveUntil && !current) { stopPictures(); return; }
    if (!pics.pool.length) return;
    tick++;
    // rotate the pool so pictures keep changing
    const item = pics.pool.shift();
    pics.pool.push(item);
    // the full-screen background only uses pictures big enough to stay sharp
    if (tick % 3 === 1 && (item.ai || item.w >= 1400)) setBackground(item.url);
    showCard(item);
  }, 520);
}
function stopPictures() {
  clearInterval(pics.timer);
  pics.timer = null;
  document.querySelectorAll('.bg-layer').forEach((l) => l.classList.remove('on'));
}

function setBackground(url) {
  const layers = document.querySelectorAll('.bg-layer');
  pics.bgIdx = 1 - pics.bgIdx;
  const on = layers[pics.bgIdx], off = layers[1 - pics.bgIdx];
  on.style.backgroundImage = `url("${url}")`;
  on.classList.remove('on'); void on.offsetWidth; on.classList.add('on');
  off.classList.remove('on');
}

// cards appear around the face, never on top of it
function showCard(item) {
  const vw = innerWidth, vh = innerHeight;
  const small = vw < 640;
  const w = small ? 140 + Math.random() * 40 : 240 + Math.random() * 130;
  const h = w * 0.75;
  const faceHalf = Math.min(vh, vw * 1.3) * 0.26;
  let x, y;
  if (small) {
    // phone: the info strip owns the top while it's showing; the background
    // pictures keep changing anyway, and the face stays clear
    if (document.body.classList.contains('has-info')) return;
    x = Math.random() * (vw - w);
    y = 60 + Math.random() * 70;
  } else {
    const left = document.body.classList.contains('has-info') || Math.random() < 0.5;
    const minX = left ? 12 : vw / 2 + faceHalf;
    const maxX = left ? vw / 2 - faceHalf - w : vw - w - 12;
    x = maxX > minX ? minX + Math.random() * (maxX - minX) : (left ? 12 : vw - w - 12);
    y = 70 + Math.random() * Math.max(10, vh - h - 200);
  }
  const el = document.createElement('div');
  el.className = 'card';
  el.style.cssText = `left:${x}px;top:${y}px;--w:${w}px;--r:${(Math.random() - 0.5) * 6}deg`;
  el.appendChild(item.img.cloneNode());
  const tag = document.createElement('span');
  tag.className = 'tag' + (item.ai ? ' ai' : '');
  tag.textContent = item.caption;
  el.appendChild(tag);
  $('#cards').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => el.classList.add('out'), 1900);
  setTimeout(() => el.remove(), 2500);
  // keep it tidy
  const all = $('#cards').children;
  if (all.length > 9) all[0].remove();
}

// ================================================================= hologram + eye contact
let moodTimer = 0;
let specBuf = null;
const holo = new Holo($('#holo'), {
  getMode: () => face.mode || 'idle',
  getLevel: () => face.level || 0,
  getSpectrum: () => {
    if (!analyser || !speaker.playing) return null;
    if (!specBuf) specBuf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(specBuf);
    return specBuf;
  },
  getLabel: () => `${assistantName().toUpperCase()}  ·  ${({ idle: 'ONLINE', listening: 'LISTENING', thinking: 'ANALYZING', speaking: 'TRANSMITTING' })[face.mode] || 'ONLINE'}`,
});
const presence = new Presence();
face.getUser = () => (presence.seen ? presence : null);
async function startEyes() {
  if (!$('#eyeContact').checked || !navigator.mediaDevices?.getUserMedia) return;
  const ok = await presence.start();
  if (!ok) status('Eye contact is off: the camera is unavailable or blocked.', 4000);
}

// ================================================================= info panel
// Key facts, a timeline and a map for the current answer, beside the face.
const info = {
  reset() {
    $('#info').classList.add('hidden');
    document.body.classList.remove('has-info');
    $('#facts').innerHTML = ''; $('#timeline').innerHTML = '';
    $('#factsBox').hidden = $('#timeBox').hidden = $('#mapBox').hidden = true;
    $('#map').removeAttribute('src');
  },
  show() {
    if (!$('#showInfo').checked) return;
    $('#info').classList.remove('hidden');
    document.body.classList.add('has-info');
  },
  facts(items) {
    if (!items?.length) return;
    const dl = $('#facts');
    items.forEach((f, i) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = f.label; dd.textContent = f.value;
      dt.style.animationDelay = dd.style.animationDelay = i * 0.12 + 's';
      dl.append(dt, dd);
    });
    $('#factsBox').hidden = false; this.show();
  },
  timeline(items) {
    if (!items?.length) return;
    const ol = $('#timeline');
    ol.innerHTML = '';
    items.forEach((e, i) => {
      const li = document.createElement('li'), b = document.createElement('b');
      b.textContent = e.when;
      li.append(b, document.createTextNode(e.what));
      li.style.animationDelay = i * 0.15 + 's';
      ol.appendChild(li);
    });
    $('#timeBox').hidden = false; this.show();
  },
  map({ name, lat, lon, zoom }) {
    // OpenStreetMap: free, no key needed
    const dLon = 360 / 2 ** zoom * 1.6, dLat = dLon * 0.6 * Math.cos(lat * Math.PI / 180);
    const box = [lon - dLon / 2, lat - dLat / 2, lon + dLon / 2, lat + dLat / 2].map((v) => v.toFixed(5)).join(',');
    $('#map').src = `https://www.openstreetmap.org/export/embed.html?bbox=${box}&layer=mapnik&marker=${lat},${lon}`;
    $('#mapName').textContent = name || 'Map';
    $('#mapBox').hidden = false; this.show();
  },
};

// ================================================================= asking
function setMode(m) {
  face.mode = m;
  document.body.classList.toggle('thinking', m === 'thinking');
  document.body.classList.toggle('listening', m === 'listening');
}

function status(text, ms = 0) {
  const s = $('#status');
  if (!text) { s.classList.add('hidden'); return; }
  s.textContent = text;
  s.classList.remove('hidden');
  clearTimeout(status.t);
  if (ms) status.t = setTimeout(() => s.classList.add('hidden'), ms);
}

function subtitle(you, text) {
  const el = $('#subtitle');
  el.innerHTML = '';
  if (you) { const d = document.createElement('div'); d.className = 'you'; d.textContent = you; el.appendChild(d); }
  const d = document.createElement('div');
  d.textContent = text;
  el.appendChild(d);
}

async function ask(question) {
  question = question.trim();
  if (!question) return;
  // interrupt whatever was happening
  current?.abort.abort();
  speaker.reset();
  resetPictures();
  aiCount = 0;
  $('#sources').innerHTML = '';
  info.reset();
  face.mood = 'neutral';
  clearTimeout(moodTimer);
  picsActiveUntil = performance.now() + 60000;
  audioCtx();

  const me = { abort: new AbortController(), text: '' };
  current = me;
  setMode('thinking');
  subtitle(question, '…');
  status('Thinking…');

  // pictures come only from Claude's exact subject searches and picture ideas
  // (sent in the first moment of every answer), never from loose guesses
  let gotGen = false;

  speaker.lang = micLangUsed || '';
  speaker.onDone = () => {
    if (current !== me) return;
    setMode('idle');
    status('');
    picsActiveUntil = performance.now() + 2500;
    moodTimer = setTimeout(() => { if (!current) face.mood = 'neutral'; }, 5000);
    current = null;
  };

  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history, remember: $('#remember').checked, name: assistantName(), persona: $('#persona').value }),
      signal: me.abort.signal,
    });
    if (r.status === 401) { location.href = '/login'; return; }
    await readSSE(r, (event, data) => {
      if (current !== me) return;
      if (event === 'text') {
        if (!me.text) status('');
        me.text += data.t;
        subtitle(question, me.text.trim());
        speaker.push(data.t);
      } else if (event === 'images') {
        data.terms.forEach((t) => findPhotos(t));
        // if no picture prompts come, illustrate the first search ideas instead
        setTimeout(() => { if (!gotGen && current === me) data.terms.slice(0, 2).forEach(makeAiImage); }, 1500);
      } else if (event === 'gen') {
        gotGen = true;
        data.prompts.forEach(makeAiImage);
      } else if (event === 'mood') {
        face.mood = data.mood;
      } else if (event === 'facts') {
        info.facts(data.items);
      } else if (event === 'timeline') {
        info.timeline(data.items);
      } else if (event === 'map') {
        info.map(data);
      } else if (event === 'search') {
        status('🔎 ' + data.query);
      } else if (event === 'source') {
        addSource(data);
      } else if (event === 'error') {
        me.text += data.message;
        subtitle(question, data.message);
        speaker.push(data.message);
      }
    });
    if (current !== me) return;
    history.push({ role: 'user', content: question }, { role: 'assistant', content: me.text.trim() || '…' });
    while (history.length > 16) history.shift();
    speaker.end();
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    subtitle(question, 'Connection problem. Is the server running?');
    setMode('idle');
    current = null;
  }
}

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = raw.match(/^event: (.*)$/m)?.[1];
      const data = raw.match(/^data: (.*)$/m)?.[1];
      if (ev && data) onEvent(ev, JSON.parse(data));
    }
  }
}

function addSource({ title, url }) {
  const box = $('#sources');
  if (box.children.length >= 5) return;
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener';
  try { a.textContent = title || new URL(url).hostname; } catch { a.textContent = title || url; }
  a.title = url;
  box.appendChild(a);
}

// ================================================================= mic in
const LANGS = [
  ['auto', 'Auto-detect any language'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['ar-SA', 'العربية'],
  ['es-ES', 'Español'], ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'], ['pt-BR', 'Português'],
  ['tr-TR', 'Türkçe'], ['ru-RU', 'Русский'], ['hi-IN', 'हिन्दी'], ['ur-PK', 'اردو'], ['fa-IR', 'فارسی'],
  ['zh-CN', '中文'], ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['nl-NL', 'Nederlands'], ['pl-PL', 'Polski'],
  ['sv-SE', 'Svenska'], ['he-IL', 'עברית'], ['id-ID', 'Bahasa Indonesia'], ['ms-MY', 'Bahasa Melayu'],
  ['th-TH', 'ไทย'], ['vi-VN', 'Tiếng Việt'], ['el-GR', 'Ελληνικά'], ['uk-UA', 'Українська'],
];
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micLang = () => $('#micLang').value;
let micLangUsed = '';
let rec = null, recorder = null;

function setupLangs() {
  const sel = $('#micLang');
  for (const [v, n] of LANGS) { const o = document.createElement('option'); o.value = v; o.textContent = n; sel.appendChild(o); }
  const saved = localStorage.getItem('micLang');
  const nav = navigator.language;
  const navMatch = LANGS.find(([v]) => v.toLowerCase() === nav.toLowerCase()) || LANGS.find(([v]) => v.split('-')[0] === nav.split('-')[0]);
  sel.value = saved || (config.voice ? 'auto' : navMatch?.[0] || 'en-US');
  if (!config.voice && sel.value === 'auto') sel.value = navMatch?.[0] || 'en-US';
  sel.onchange = () => localStorage.setItem('micLang', sel.value);
}

function micOn() { return !!(rec || recorder); }

function startMic() {
  if (micOn()) return stopMic();
  // barge in: stop talking when you start talking
  current?.abort.abort(); current = null;
  speaker.reset();
  audioCtx();
  wake.pause();
  $('#mic').classList.add('on');
  setMode('listening');
  const lang = micLang();
  if (lang === 'auto' && config.voice) return startRecorder();
  if (!SR) {
    if (config.voice) return startRecorder();
    status('Voice input needs Chrome or Edge. You can type instead.', 4000);
    return endMic();
  }
  rec = new SR();
  rec.lang = lang === 'auto' ? navigator.language : lang;
  micLangUsed = rec.lang;
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    $('#q').value = finalText + interim;
    subtitle('', (finalText + interim) || '…');
  };
  rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') status('Mic: ' + e.error, 3000); };
  rec.onend = () => {
    rec = null;
    endMic();
    const q = finalText || $('#q').value;
    $('#q').value = '';
    if (q.trim()) ask(q);
  };
  rec.start();
}

async function startRecorder() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    status('Microphone permission was blocked.', 4000);
    return endMic();
  }
  micLangUsed = '';
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  // stop automatically after you stop talking
  const src = audioCtx().createMediaStreamSource(stream);
  const an = actx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let heard = false, quietSince = performance.now();
  const started = performance.now();
  const vad = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    const rms = Math.sqrt(s / buf.length);
    if (rms > 0.02) { heard = true; quietSince = performance.now(); }
    const quiet = performance.now() - quietSince;
    if ((heard && quiet > 900) || (!heard && quiet > 6000) || performance.now() - started > 30000) stopMic();
  }, 60);
  recorder.onstop = async () => {
    clearInterval(vad);
    stream.getTracks().forEach((t) => t.stop());
    src.disconnect();
    recorder = null;
    endMic();
    if (!heard || !chunks.length) return;
    setMode('thinking');
    status('Listening…');
    try {
      const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
      const r = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      const { text, language } = await r.json();
      micLangUsed = language || '';
      if (text?.trim()) ask(text); else { status(''); setMode('idle'); }
    } catch {
      status('Could not understand that, please try again.', 3000);
      setMode('idle');
    }
  };
  recorder.start(250);
}

function stopMic() {
  if (rec) rec.stop();
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}
function endMic() {
  $('#mic').classList.remove('on');
  if (face.mode === 'listening') setMode('idle');
  wake.resume();
}

// ================================================================= hands-free
// Listens all the time for its name ("Hey Nova, what's ...?"). Saying the
// name always stops it talking. With "Interrupt it by just talking" on, it
// also stops when it hears you say something that isn't its own voice.
const assistantName = () => ($('#wakeName').value.trim() || config.name || 'Nova');
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

function nameVariants(name) {
  const n = norm(name);
  const v = new Set([n, n.replace(/\s/g, '')]);
  // speech recognition often mishears short names; a few common ones
  if (n === 'nova') ['noah', 'novah', 'nover', 'no va', 'nava', 'norva', 'nola'].forEach((x) => v.add(x));
  return [...v].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

const wake = {
  rec: null,
  paused: false,
  want: false,
  hot: null, // what was heard after the name so far
  restarts: 0,
  regex: null,
  enabled() { return !!SR && $('#wakeOn').checked; },
  start() {
    this.want = true;
    this.regex = new RegExp(`(?:^|\\b(?:hey|hi|hello|ok|okay|ya|hej|hallo|hola|ciao|salut|oi)\\s+)(?:${nameVariants(assistantName()).join('|')})\\b\\s*(.*)$`, 'i');
    this._go();
  },
  stop() { this.want = false; this.rec?.abort(); this.rec = null; this._ear(); },
  pause() { this.paused = true; this.rec?.abort(); this.rec = null; this._ear(); },
  resume() { this.paused = false; setTimeout(() => this._go(), 350); },
  _ear() {
    $('#ear').hidden = !(this.want && this.enabled());
    $('#ear').classList.toggle('hot', !!this.hot);
  },
  _go() {
    if (!this.want || this.paused || this.rec || !this.enabled() || micOn()) return this._ear();
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    const l = micLang();
    r.lang = l === 'auto' ? navigator.language : l;
    r.onresult = (e) => this._heard(e);
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.want = false;
        status('Hands-free needs microphone permission.', 4000);
      }
    };
    r.onend = () => {
      if (this.rec === r) this.rec = null;
      // Chrome stops listening now and then; start again (slower if it keeps failing)
      this.restarts++;
      setTimeout(() => { this.restarts = Math.max(0, this.restarts - 1); this._go(); }, Math.min(5000, 250 * this.restarts));
    };
    this.rec = r;
    try { r.start(); } catch { this.rec = null; }
    this._ear();
  },
  _heard(e) {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = res[0].transcript.trim();
      const isFinal = res.isFinal;
      const m = norm(text).match(this.regex);
      if (m || this.hot !== null) {
        if (this.hot === null) this._interrupt('Listening…');
        // keep what came after the name, in the original wording
        const after = m ? afterName(text, m[1]) : text;
        this.hot = after;
        if (after) subtitle('', after);
        if (isFinal) {
          this.hot = null; this._ear();
          if (after.replace(/[\s.,!?]/g, '').length > 1) ask(after);
          else { // just the name: open the mic for the question
            this.pause();
            startMic();
          }
        }
        this._ear();
      } else if ($('#bargeIn').checked && (speaker.playing || current) && isYou(text, isFinal)) {
        this._interrupt('');
        if (isFinal) ask(text); else { this.hot = text; subtitle('', text); }
      }
    }
  },
  _interrupt(msg) {
    current?.abort.abort(); current = null;
    speaker.reset();
    setMode('listening');
    status(msg, 3000);
  },
};

// the words after the name, keeping the original spelling and accents
function afterName(text, normAfter) {
  if (!normAfter) return '';
  const words = text.split(/\s+/);
  const n = normAfter.split(' ').length;
  let count = 0, k = words.length;
  while (k > 0 && count < n) { k--; count += norm(words[k]).split(' ').filter(Boolean).length; }
  return words.slice(k).join(' ');
}

// is this speech the user, or the assistant's own voice echoing back?
function isYou(text, isFinal) {
  const heard = norm(text).split(' ').filter((w) => w.length > 1);
  if (heard.length < (isFinal ? 2 : 3)) return false;
  const said = new Set(norm(speaker.spoken.slice(-600) + ' ' + (current?.text || '').slice(-600)).split(' '));
  const echo = heard.filter((w) => said.has(w)).length / heard.length;
  return echo < 0.4;
}

// ================================================================= face swap
const FACE_KEY = 'customFace';
async function loadFace() {
  let src = null;
  try { src = localStorage.getItem(FACE_KEY); } catch {}
  src = src || config.face;
  if (!src) {
    status('No face image yet. Open Settings and choose “Change face…”, or add public/face.jpg.', 8000);
    src = placeholderFace();
  }
  await face.load(src);
}

function placeholderFace() {
  const c = document.createElement('canvas'); c.width = c.height = 800;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(400, 380, 40, 400, 400, 420);
  g.addColorStop(0, '#1b2a44'); g.addColorStop(1, '#04060a');
  x.fillStyle = g; x.fillRect(0, 0, 800, 800);
  x.fillStyle = '#c9a58c';
  x.beginPath(); x.ellipse(400, 410, 190, 250, 0, 0, Math.PI * 2); x.fill();
  return c.toDataURL();
}

async function pickFace(file) {
  const img = await createImageBitmap(file);
  const s = Math.min(1, 1100 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.9);
  try { localStorage.setItem(FACE_KEY, url); } catch { status('That image is too big to remember; it will be used until you reload.', 5000); }
  await face.load(url);
  face.playIntro(2600);
  warnIfNoFace();
}
async function warnIfNoFace() {
  await face.rigPromise;
  if (!face.found) status('I couldn’t find the face clearly in that picture. A front-facing photo works best.', 6000);
}

// ================================================================= wiring
async function init() {
  try { config = await (await fetch('/api/config')).json(); } catch {}
  setupLangs();
  const dot = (ok, text) => `<span style="color:${ok ? 'var(--ok)' : 'var(--danger)'}">●</span> ${text}`;
  $('#keys').innerHTML = [
    dot(config.claude, config.claude ? 'Claude answers + live web search' : 'Claude: add ANTHROPIC_API_KEY'),
    dot(config.voice, config.voice ? 'ElevenLabs voice' : 'Browser voice (add ELEVENLABS_API_KEY for a realistic one)'),
    dot(config.aiImages, config.aiImages ? 'HD AI images (fal.ai)' : 'No AI images (add FAL_KEY)'),
  ].join('<br>');
  await loadFace();
}
const ready = init();

$('#wake').onclick = async () => {
  audioCtx();
  // unlock browser speech on iOS/Safari
  if (window.speechSynthesis) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  $('#start').classList.add('gone');
  await ready;
  if (!face.hidden) await face.playIntro();
  if (!config.claude) status('Add your ANTHROPIC_API_KEY to the .env file, then restart the server.', 10000);
  if (wake.enabled()) wake.start();
  if (!face.hidden) startEyes();
  if (!('ontouchstart' in window)) $('#q').focus();
};

$('#bar').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#q').value;
  $('#q').value = '';
  ask(q);
};
$('#mic').onclick = startMic;

// hold Space to talk (when not typing)
let spaceHeld = false;
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement !== $('#q') && !e.repeat && $('#start').classList.contains('gone')) {
    e.preventDefault(); spaceHeld = true; if (!micOn()) startMic();
  }
  if (e.key === 'Escape' && !$('#settings').classList.contains('hidden')) { settingsOpen(false); return; }
  if (e.key === 'Escape') { current?.abort.abort(); current = null; speaker.reset(); setMode('idle'); status(''); }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHeld) { spaceHeld = false; if (micOn()) stopMic(); }
});

const settingsOpen = (open) => {
  $('#settings').classList.toggle('hidden', !open);
  $('#scrim').classList.toggle('hidden', !open);
};
$('#gear').onclick = () => settingsOpen($('#settings').classList.contains('hidden'));
$('#closeSettings').onclick = () => settingsOpen(false);
$('#scrim').onclick = () => settingsOpen(false);
$('#morph').onchange = (e) => { face.morphOn = e.target.checked; try { localStorage.setItem('morph', e.target.checked ? '1' : '0'); } catch {} };
try { if (localStorage.getItem('morph') === '0') { $('#morph').checked = false; face.morphOn = false; } } catch {}
try { const o = localStorage.getItem('lipOffset'); if (o) $('#lipOffset').value = o; } catch {}
$('#lipOffsetVal').textContent = $('#lipOffset').value + ' ms';
$('#lipOffset').oninput = (e) => { $('#lipOffsetVal').textContent = e.target.value + ' ms'; try { localStorage.setItem('lipOffset', e.target.value); } catch {} };
$('#showMesh').onchange = (e) => { face.debug = e.target.checked; };
$('#showText').onchange = (e) => $('#subtitle').classList.toggle('off', !e.target.checked);
$('#faceBtn').onclick = () => $('#faceFile').click();
$('#faceFile').onchange = (e) => e.target.files[0] && pickFace(e.target.files[0]);
$('#faceReset').onclick = async () => {
  try { localStorage.removeItem(FACE_KEY); } catch {}
  await loadFace();
  face.playIntro(2600);
};

// hands-free + memory settings (remembered in this browser)
const saved = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
for (const id of ['wakeOn', 'bargeIn', 'showInfo', 'remember', 'holoOn', 'eyeContact', 'showFace']) {
  $('#' + id).checked = saved(id, '1') === '1';
  $('#' + id).addEventListener('change', (e) => store(id, e.target.checked ? '1' : '0'));
}
if (!SR) { $('#wakeOn').checked = false; $('#wakeOn').disabled = true; $('#wakeHint').textContent = 'Hands-free needs Chrome or Edge.'; }
$('#wakeName').value = saved('wakeName', '') || config.name || 'Nova';
const nameHint = () => {
  $('#wakeHint').textContent = SR ? `Say “Hey ${assistantName()}, …” any time. Works in Chrome and Edge.` : 'Hands-free needs Chrome or Edge.';
  $('#q').placeholder = wake.enabled() && innerWidth > 640 ? `Ask anything, or say “Hey ${assistantName()}”` : 'Ask me anything…';
  $('#earName').textContent = `Hey ${assistantName()}`;
  $('#wake .label').textContent = `Wake ${assistantName()}`;
  $('#start .hint').innerHTML = SR ? `Then talk or type. Say “Hey ${assistantName()}” or hold <kbd>Space</kbd> to speak.` : 'Then talk or type. Hold <kbd>Space</kbd> to speak.';
};
$('#wakeName').onchange = () => { store('wakeName', $('#wakeName').value.trim()); nameHint(); if (wake.want) { wake.stop(); wake.start(); } };
$('#wakeOn').addEventListener('change', (e) => { nameHint(); if (e.target.checked) wake.start(); else wake.stop(); });
$('#showInfo').addEventListener('change', (e) => { if (!e.target.checked) { $('#info').classList.add('hidden'); document.body.classList.remove('has-info'); } });
const holoMode = () => { holo.on = $('#holoOn').checked; document.body.classList.toggle('holo', holo.on); };
$('#holoOn').addEventListener('change', holoMode);
holoMode();
$('#eyeContact').addEventListener('change', (e) => { if (e.target.checked && !face.hidden) startEyes(); else presence.stop(); });

// ---- face on/off
function applyFace(first) {
  const show = $('#showFace').checked;
  face.hidden = !show;
  holo.faceless = !show;
  document.body.classList.toggle('faceless', !show);
  if (!show) presence.stop();
  else if (!first && $('#start').classList.contains('gone')) {
    if (!face.live && !face.intro) face.playIntro(2200);
    startEyes();
  }
}
$('#showFace').addEventListener('change', () => applyFace(false));
applyFace(true);

// ---- voice, speed and personality
function voiceSpeed() { return Number($('#voiceSpeed').value) || 1; }
let voiceList = [];
async function fillVoicePicker() {
  const sel = $('#voice');
  sel.innerHTML = '';
  const savedVoice = saved('voice', '');
  if (config.voice) {
    try {
      const j = await (await fetch('/api/voices')).json();
      voiceList = j.voices || [];
      for (const v of voiceList) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = [v.name, [v.gender, v.accent].filter(Boolean).join(', ')].filter(Boolean).join(' – ');
        sel.appendChild(o);
      }
      sel.value = voiceList.some((v) => v.id === savedVoice) ? savedVoice : j.default;
      if (!sel.value && voiceList[0]) sel.value = voiceList[0].id;
    } catch {}
  }
  if (!sel.options.length) {
    // browser voices (no ElevenLabs key)
    const o = document.createElement('option'); o.value = ''; o.textContent = 'Automatic (best for the language)';
    sel.appendChild(o);
    for (const v of (window.speechSynthesis?.getVoices() || [])) {
      const x = document.createElement('option'); x.value = v.name; x.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(x);
    }
    sel.value = [...sel.options].some((o) => o.value === savedVoice) ? savedVoice : '';
  }
  showVoiceAbout();
}
function showVoiceAbout() {
  const v = voiceList.find((x) => x.id === $('#voice').value);
  $('#voiceAbout').textContent = v ? [v.about, v.gender, v.accent].filter(Boolean).join(' · ') : config.voice ? '' : 'Add an ElevenLabs key for realistic voices.';
}
$('#voice').addEventListener('change', () => { store('voice', $('#voice').value); showVoiceAbout(); });
window.speechSynthesis?.addEventListener?.('voiceschanged', () => { if (!config.voice) fillVoicePicker(); });
$('#voiceSpeed').value = saved('voiceSpeed', '1');
const speedLabel = () => { $('#voiceSpeedVal').textContent = voiceSpeed().toFixed(2).replace(/0$/, '') + '×'; };
speedLabel();
$('#voiceSpeed').addEventListener('input', () => { store('voiceSpeed', $('#voiceSpeed').value); speedLabel(); });
$('#persona').value = saved('persona', 'friendly');
$('#persona').addEventListener('change', () => store('persona', $('#persona').value));
$('#voicePreview').onclick = (e) => {
  e.preventDefault();
  current?.abort.abort(); current = null;
  speaker.reset();
  audioCtx();
  const lines = {
    friendly: `Hi, I'm ${assistantName()}. Ask me anything, and I'll find it for you.`,
    professional: `${assistantName()} here. Ready when you are.`,
    witty: `Hello, I'm ${assistantName()}. I've read most of the internet so you don't have to.`,
    calm: `Hello. I'm ${assistantName()}. Take your time, I'm here.`,
    enthusiastic: `Hey! I'm ${assistantName()}, and I can't wait to explore something with you!`,
    storyteller: `Every question has a story. I'm ${assistantName()}. Shall we begin?`,
    futuristic: `Link established. I am ${assistantName()}. The archive of humanity is open.`,
  };
  speaker.onDone = () => setMode('idle');
  speaker.push(lines[$('#persona').value] || lines.friendly);
  speaker.end();
};
ready.then(fillVoicePicker);

// ---- installable app
let installEvt = null;
const standalone = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone;
function installUi() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('#installBtn').hidden = !installEvt;
  $('#installHint').textContent = standalone() ? 'Installed: Nova opens full screen from your home screen.'
    : installEvt ? 'Adds Nova to your home screen or desktop, opening full screen like an app.'
    : ios ? 'On iPhone or iPad: open this page in Safari, tap Share, then “Add to Home Screen”.'
    : 'In Chrome or Edge: open the browser menu and choose “Install app” or “Add to Home screen”.';
}
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; installUi(); });
addEventListener('appinstalled', () => { installEvt = null; installUi(); status('Nova is installed. Open it from your home screen.', 5000); });
$('#installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; installUi(); };
installUi();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
$('#infoClose').onclick = () => { $('#info').classList.add('hidden'); document.body.classList.remove('has-info'); };
nameHint();
ready.then(nameHint);

async function loadMemory() {
  try {
    const r = await fetch('/api/memory');
    if (r.status === 401) return (location.href = '/login');
    const m = await r.json();
    $('#memText').textContent = m.profile || (m.count ? `Nothing noted yet (${m.count} questions saved).` : 'Nothing yet.');
  } catch {}
}
$('#gear').addEventListener('click', () => { if (!$('#settings').classList.contains('hidden')) loadMemory(); });
$('#forget').onclick = async () => {
  if ($('#forget').dataset.sure !== '1') {
    $('#forget').dataset.sure = '1'; $('#forget').textContent = 'Tap again to forget everything';
    setTimeout(() => { $('#forget').dataset.sure = ''; $('#forget').textContent = 'Forget everything'; }, 4000);
    return;
  }
  await fetch('/api/memory', { method: 'DELETE' });
  history.length = 0;
  $('#forget').dataset.sure = ''; $('#forget').textContent = 'Forgotten ✓';
  loadMemory();
};
if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') $('#logout').hidden = false;

// handy for testing: window.ai.ask('...')
window.ai = { ask, face, speaker, wake, info, holo, presence, actx: () => actx };
