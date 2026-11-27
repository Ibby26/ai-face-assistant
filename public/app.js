import { Face } from './face.js';
import { shapeAt, shapeFor, mix, SHAPES } from './visemes.js';

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
        body: JSON.stringify({ text, previous: this.spoken.slice(-300) }),
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
      const v = pickVoice(u.lang);
      if (v) u.voice = v;
      u.rate = 1.05;
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

function addPic(url, caption, ai = false, front = false) {
  if (!url || pics.seen.has(url)) return;
  pics.seen.add(url);
  const gen = pics.gen;
  const im = new Image();
  im.referrerPolicy = 'no-referrer';
  im.onload = () => {
    if (gen !== pics.gen) return;
    const item = { url, caption, ai, img: im };
    if (front || ai) pics.pool.unshift(item); else pics.pool.push(item);
    if (!pics.timer) startPictures();
  };
  im.src = url;
}

async function findPhotos(term, { limit = 8, commons = true } = {}) {
  if (!term) return;
  const gen = pics.gen;
  const q = encodeURIComponent(term);
  const wiki = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${q}&gsrlimit=${limit}&prop=pageimages&piprop=thumbnail&pithumbsize=900`;
  const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrsearch=${q}%20filetype:bitmap&gsrlimit=${limit}&prop=imageinfo&iiprop=url&iiurlwidth=900`;
  const take = async (url, fn) => {
    try {
      const j = await (await fetch(url)).json();
      if (gen !== pics.gen) return;
      const pages = Object.values(j.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
      for (const p of pages) fn(p);
    } catch (e) { /* offline or blocked: ignore */ }
  };
  await Promise.all([
    take(wiki, (p) => p.thumbnail?.source && !/\.svg/i.test(p.thumbnail.source) && addPic(p.thumbnail.source, p.title)),
    commons && take(commonsUrl, (p) => {
      const u = p.imageinfo?.[0]?.thumburl;
      if (u && !/\.(svg|tif|pdf)/i.test(p.title)) addPic(u, p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/_/g, ' '));
    }),
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
    if (tick % 3 === 1) setBackground(item.url);
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
  const w = small ? 130 + Math.random() * 40 : 190 + Math.random() * 110;
  const h = w * 0.75;
  const faceHalf = Math.min(vh, vw * 1.3) * 0.26;
  let x, y;
  if (small) {
    x = Math.random() * (vw - w);
    y = Math.random() < 0.5 ? 60 + Math.random() * 60 : vh * 0.62 + Math.random() * (vh * 0.12);
  } else {
    const left = Math.random() < 0.5;
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
  tag.textContent = item.ai ? 'AI · ' + item.caption : item.caption;
  el.appendChild(tag);
  $('#cards').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => el.classList.add('out'), 1900);
  setTimeout(() => el.remove(), 2500);
  // keep it tidy
  const all = $('#cards').children;
  if (all.length > 9) all[0].remove();
}

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
  picsActiveUntil = performance.now() + 60000;
  audioCtx();

  const me = { abort: new AbortController(), text: '' };
  current = me;
  setMode('thinking');
  subtitle(question, '…');
  status('Thinking…');

  // a few instant pictures for the whole question while Claude starts
  // (Claude then sends exact search terms and picture ideas for the subject)
  findPhotos(question, { limit: 3, commons: false });
  let gotGen = false;

  speaker.lang = micLangUsed || '';
  speaker.onDone = () => {
    if (current !== me) return;
    setMode('idle');
    status('');
    picsActiveUntil = performance.now() + 2500;
    current = null;
  };

  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history }),
      signal: me.abort.signal,
    });
    await readSSE(r, (event, data) => {
      if (current !== me) return;
      if (event === 'text') {
        if (!me.text) status('');
        me.text += data.t;
        subtitle(question, me.text.trim());
        speaker.push(data.t);
      } else if (event === 'images') {
        data.terms.forEach((t) => findPhotos(t, { limit: 5 }));
        // if no picture prompts come, illustrate the first search ideas instead
        setTimeout(() => { if (!gotGen && current === me) data.terms.slice(0, 2).forEach(makeAiImage); }, 1500);
      } else if (event === 'gen') {
        gotGen = true;
        data.prompts.forEach(makeAiImage);
      } else if (event === 'search') {
        status('🔎 ' + data.query);
        findPhotos(data.query);
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
  $('#keys').innerHTML = [
    config.claude ? '✅ Claude answers + web search' : '❌ Claude: add ANTHROPIC_API_KEY',
    config.voice ? '✅ ElevenLabs voice' : '⚠️ Browser voice (add ELEVENLABS_API_KEY for a realistic one)',
    config.aiImages ? '✅ AI images (fal.ai)' : '⚠️ No AI images (add FAL_KEY)',
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
  await face.playIntro();
  if (!config.claude) status('Add your ANTHROPIC_API_KEY to the .env file, then restart the server.', 10000);
  $('#q').focus();
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
  if (e.key === 'Escape') { current?.abort.abort(); current = null; speaker.reset(); setMode('idle'); status(''); }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHeld) { spaceHeld = false; if (micOn()) stopMic(); }
});

$('#gear').onclick = () => $('#settings').classList.toggle('hidden');
$('#closeSettings').onclick = () => $('#settings').classList.add('hidden');
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

// handy for testing: window.ai.ask('...')
window.ai = { ask, face, speaker, actx: () => actx };
