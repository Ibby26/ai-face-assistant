// Talking-face AI super search assistant: small Node server.
// It keeps your API keys private and streams everything to the browser
// as fast as possible (answers, voice and images).
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { setupLock } from './lib/lock.js';
import { createMemory } from './lib/memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const SPEED = (process.env.CLAUDE_SPEED || 'fast').toLowerCase() === 'standard' ? 'standard' : 'fast';
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const FAL_KEY = process.env.FAL_KEY || '';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Nova';
const memory = createMemory({
  dir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  anthropic,
  model: MODEL,
});
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
// Password lock (set APP_PASSWORD in .env). Everything below it is protected.
setupLock(app, process.env.APP_PASSWORD || '');
app.use(express.static(PUBLIC, { extensions: ['html'] }));
// Face landmark detection runs in the browser from these local files, so it
// doesn't depend on a CDN being reachable.
app.use('/mp', express.static(path.join(__dirname, 'node_modules/@mediapipe/tasks-vision')));

// ---------------------------------------------------------------- config
app.get('/api/config', (_req, res) => {
  res.json({
    claude: !!anthropic,
    voice: !!ELEVEN_KEY,
    aiImages: !!FAL_KEY,
    face: findFace(),
    name: ASSISTANT_NAME,
  });
});

// ---------------------------------------------------------------- memory
app.get('/api/memory', (_req, res) => res.json(memory.summary()));
app.delete('/api/memory', (_req, res) => { memory.clear(); res.json({ ok: true }); });

function findFace() {
  for (const f of ['face.png', 'face.jpg', 'face.jpeg', 'face.webp']) {
    const p = path.join(PUBLIC, f);
    if (fs.existsSync(p)) return '/' + f + '?v=' + Math.round(fs.statSync(p).mtimeMs);
  }
  return null;
}

// ---------------------------------------------------------------- morph faces
// The face keeps morphing into features from other people. Those faces are
// pulled live from the internet on demand and never saved to disk:
// thispersondoesnotexist.com makes a new AI person (nobody real) every request.
app.get('/api/liveface', async (_req, res) => {
  try {
    const r = await fetch('https://thispersondoesnotexist.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.warn('Live face failed:', err.message);
    res.status(502).end();
  }
});

// Optional: your own extra faces in public/faces are mixed in too.
const FACES_DIR = path.join(PUBLIC, 'faces');
app.get('/api/faces', (_req, res) => {
  let files = [];
  try { files = fs.readdirSync(FACES_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)); } catch {}
  res.json({ faces: files.sort().map((f) => '/faces/' + encodeURIComponent(f)) });
});

// ---------------------------------------------------------------- ask (SSE)
const systemPrompt = (name, remember) => `You are ${name}, a friendly, brilliant AI search assistant with a human face. The user sees your face and hears you speak, so everything you write is read aloud.

Rules:
- Reply in the same language the user used.
- Be fast and spoken: usually 2 to 5 short sentences, unless the user asks for more detail.
- No markdown, no bullet lists, no URLs, no emojis. Write numbers and dates the way you'd say them.
- Use web search when the question needs current or specific facts. Don't announce that you are searching.
- The screen shows pictures about the user's question while you answer. To drive them, the VERY FIRST thing in every reply (before anything else, even before searching) is these two hidden lines:
[[img: search 1 | search 2 | search 3 | search 4 | search 5]]
[[gen: prompt 1 | prompt 2 | prompt 3]]
  img = 4 to 6 English searches for real photos on Wikipedia and Wikimedia Commons. Prefer exact English Wikipedia article titles of the specific people, places, objects and events in the answer (they return that article's main photo), plus short, precise Commons searches. Each must be about the user's exact subject. Never generic words, never loosely related topics. Example for "how did World War 2 end": Surrender of Japan | Japanese Instrument of Surrender | USS Missouri (BB-63) | Raising a Flag over the Reichstag | Victory in Europe Day | Atomic bombings of Hiroshima and Nagasaki
  gen = 2 or 3 English prompts for AI-generated pictures that illustrate this specific subject: say exactly what is in the scene (who, what, where, when, era-accurate details) and the mood. Example: "Japanese and Allied officials at the surrender ceremony on the deck of USS Missouri, Tokyo Bay, September 1945, black and white archival photo style"
  If the answer moves on to a clearly different subject, you may add one more [[img: ...]] and [[gen: ...]] line for it. These lines are never read aloud.
- The screen also has an info panel. Whenever it helps, add these hidden lines too (right after the two lines above, or after searching once you know the facts). Only add the ones that fit the question:
[[facts: Label: value | Label: value]]
  up to 5 key facts in the user's language: label 1 to 3 words, value under 8 words (dates, numbers, names, places). Must be correct.
[[timeline: 1939: Germany invades Poland | 1941: Pearl Harbor attack | 1945: Japan surrenders]]
  3 to 7 dated events in order, in the user's language, for history, biographies, wars, companies, anything with a sequence.
[[map: place name | latitude | longitude | zoom]]
  when the question is about a place, country, city, battle, event location or route. Decimal degrees; zoom 3 (continent) to 15 (street). Example: [[map: Tokyo Bay, Japan | 35.45 | 139.75 | 10]]
  These lines are never read aloud either.

Today's date is ${new Date().toDateString()}.${remember ? memory.promptText() : ''}`;

app.post('/api/ask', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let closed = false;
  res.on('close', () => { closed = true; });

  if (!anthropic) {
    send('error', { message: 'ANTHROPIC_API_KEY is missing. Add it to the .env file and restart.' });
    return res.end();
  }

  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [];
  const question = String(req.body?.question || '').slice(0, 4000);
  const remember = req.body?.remember !== false;
  const name = String(req.body?.name || ASSISTANT_NAME).slice(0, 40);
  let answer = '';
  const messages = [
    ...history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];
  // history must start with a user turn and alternate
  while (messages.length && messages[0].role !== 'user') messages.shift();

  const tagParser = makeTagParser(
    (t) => { answer += t; send('text', { t }); },
    (items, kind) => sendTag(send, items, kind),
  );
  let speed = SPEED;
  let gotOutput = false;
  const seenUrls = new Set();

  try {
    for (let round = 0; round < 4 && !closed; round++) {
      let final;
      try {
        final = await runStream(messages, speed, {
          onText: (t) => { gotOutput = true; tagParser.push(t); },
          onBlock: (block) => {
            if (block.type === 'server_tool_use' && block.input?.query) {
              gotOutput = true;
              send('search', { query: block.input.query });
            } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
              for (const r of block.content.slice(0, 6)) {
                if (r.url && !seenUrls.has(r.url)) {
                  seenUrls.add(r.url);
                  send('source', { title: r.title, url: r.url });
                }
              }
            }
          },
          isClosed: () => closed,
          system: systemPrompt(name, remember),
        });
      } catch (err) {
        // Fast mode not available on this account / rate limited: retry at standard speed.
        if (speed === 'fast' && !gotOutput && (err?.status === 400 || err?.status === 403 || err?.status === 429)) {
          console.warn('Fast mode failed, retrying at standard speed:', err?.message);
          speed = 'standard';
          round--;
          continue;
        }
        throw err;
      }
      if (!final) break;
      if (final.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: final.content });
        continue;
      }
      if (final.stop_reason === 'refusal') {
        send('text', { t: " Sorry, I can't help with that one." });
      }
      break;
    }
    tagParser.flush();
    send('done', {});
    if (remember && !closed && answer.trim()) memory.record(question, answer.trim());
  } catch (err) {
    console.error('ask error:', err?.status, err?.message);
    send('error', { message: friendlyError(err) });
  }
  res.end();
});

async function runStream(messages, speed, { onText, onBlock, isClosed, system }) {
  const params = {
    model: MODEL,
    max_tokens: 4000,
    system,
    messages,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  if (speed === 'fast') params.speed = 'fast';
  const stream = anthropic.beta.messages.stream(params);
  for await (const ev of stream) {
    if (isClosed()) { stream.abort(); return null; }
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') onText(ev.delta.text);
  }
  const final = await stream.finalMessage();
  for (const block of final.content) onBlock(block);
  return final;
}

// Pulls hidden [[img: a | b]] lines out of the streamed text.
function makeTagParser(onText, onTerms) {
  let buf = '';
  const drain = (final) => {
    while (buf) {
      const start = buf.indexOf('[[');
      if (start === -1) {
        // keep a trailing "[" in case it's the start of a tag
        const keep = !final && buf.endsWith('[') ? 1 : 0;
        const out = buf.slice(0, buf.length - keep);
        if (out) onText(out);
        buf = buf.slice(buf.length - keep);
        return;
      }
      if (start > 0) { onText(buf.slice(0, start)); buf = buf.slice(start); continue; }
      const end = buf.indexOf(']]');
      if (end === -1) {
        if (final || buf.length > 400) { onText(buf); buf = ''; }
        return;
      }
      const inner = buf.slice(2, end);
      buf = buf.slice(end + 2).replace(/^\s*\n?/, '');
      const m = inner.match(/^\s*(img|gen|facts?|timeline|map)\s*:(.*)$/is);
      if (m) {
        const items = m[2].split('|').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).slice(0, 8);
        if (items.length) onTerms(items, m[1].toLowerCase());
      }
    }
  };
  return { push: (t) => { buf += t; drain(false); }, flush: () => drain(true) };
}

// Turns one hidden tag into an event for the browser.
function sendTag(send, items, kind) {
  const split = (s) => {
    const i = s.search(/:\s/) >= 0 ? s.search(/:\s/) : s.indexOf(':');
    return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : ['', s];
  };
  if (kind === 'img') send('images', { terms: items.slice(0, 6) });
  else if (kind === 'gen') send('gen', { prompts: items.slice(0, 4) });
  else if (kind === 'fact' || kind === 'facts') {
    send('facts', { items: items.slice(0, 6).map((s) => { const [label, value] = split(s); return { label, value }; }).filter((f) => f.value) });
  } else if (kind === 'timeline') {
    send('timeline', { items: items.map((s) => { const [when, what] = split(s); return { when, what }; }).filter((e) => e.when && e.what) });
  } else if (kind === 'map') {
    const [name, lat, lon, zoom] = items;
    const la = parseFloat(lat), lo = parseFloat(lon), z = parseFloat(zoom);
    if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
      send('map', { name, lat: la, lon: lo, zoom: Number.isFinite(z) ? Math.max(2, Math.min(17, z)) : 9 });
    }
  }
}

function friendlyError(err) {
  if (err?.status === 401) return 'Your Anthropic API key was rejected. Please check ANTHROPIC_API_KEY.';
  if (err?.status === 429) return "I'm being rate limited right now. Please try again in a moment.";
  if (err?.status === 529) return 'Claude is overloaded right now. Please try again in a moment.';
  return 'Something went wrong: ' + (err?.message || 'unknown error');
}

// ---------------------------------------------------------------- voice (TTS)
// Speech for one sentence plus the exact time each letter is spoken, so the
// mouth can form the right shape for every sound. The browser asks for each
// sentence as soon as Claude has written it, so the face starts talking almost
// immediately.
app.post('/api/tts', async (req, res) => {
  if (!ELEVEN_KEY) return res.status(404).json({ error: 'no voice key' });
  const text = String(req.body?.text || '').slice(0, 2000);
  if (!text.trim()) return res.status(400).end();
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE)}/with-timestamps?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5', // lowest latency, 32 languages
          previous_text: req.body?.previous || undefined,
          voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
        }),
      },
    );
    if (!r.ok) {
      const msg = await r.text();
      console.error('ElevenLabs error', r.status, msg.slice(0, 300));
      return res.status(502).json({ error: 'tts failed' });
    }
    const j = await r.json();
    // normalized_alignment is what was actually spoken ("1939" -> "nineteen thirty-nine")
    const al = j.normalized_alignment?.characters?.length ? j.normalized_alignment : j.alignment;
    res.json({
      audio: j.audio_base64,
      chars: al?.characters || [],
      starts: al?.character_start_times_seconds || [],
      ends: al?.character_end_times_seconds || [],
    });
  } catch (err) {
    console.error('tts error', err?.message);
    if (!res.headersSent) res.status(502).json({ error: 'tts failed' });
  }
});

// ---------------------------------------------------------------- mic (STT)
// Auto-detects the spoken language (ElevenLabs Scribe). Used when the
// mic language is set to "Auto".
app.post('/api/stt', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!ELEVEN_KEY) return res.status(404).json({ error: 'no voice key' });
  try {
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    form.append('file', new Blob([req.body], { type: req.headers['content-type'] || 'audio/webm' }), 'audio.webm');
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY },
      body: form,
    });
    const j = await r.json();
    if (!r.ok) {
      console.error('STT error', r.status, JSON.stringify(j).slice(0, 300));
      return res.status(502).json({ error: 'stt failed' });
    }
    res.json({ text: j.text || '', language: j.language_code || '' });
  } catch (err) {
    console.error('stt error', err?.message);
    res.status(502).json({ error: 'stt failed' });
  }
});

// ---------------------------------------------------------------- AI images
// HD pictures: FLUX1.1 [pro] at 1440x800 (sharp, about 3 seconds, ~5 cents),
// falling back to the cheaper FLUX schnell at the same size if it fails.
const FAL_MODEL = process.env.FAL_IMAGE_MODEL || 'fal-ai/flux-pro/v1.1';
app.post('/api/genimage', async (req, res) => {
  if (!FAL_KEY) return res.status(404).json({ error: 'no image key' });
  const raw = String(req.body?.prompt || '').slice(0, 600);
  const prompt = /photo|painting|illustration|style/i.test(raw)
    ? `${raw}, highly detailed, sharp focus, high resolution`
    : `${raw}, cinematic photograph, sharp focus, highly detailed, 8k`;
  const size = { width: 1440, height: 800 };
  const attempt = async (model) => {
    const body = { prompt, image_size: size, num_images: 1, enable_safety_checker: true, output_format: 'jpeg' };
    if (model.includes('schnell')) body.num_inference_steps = 4;
    else body.safety_tolerance = '2';
    const r = await fetch(`https://fal.run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.images?.[0]?.url) throw new Error(`${model} ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j.images[0].url;
  };
  try {
    let url;
    try { url = await attempt(FAL_MODEL); } catch (err) {
      if (FAL_MODEL.includes('schnell')) throw err;
      console.warn('fal error, trying FLUX schnell:', err.message);
      url = await attempt('fal-ai/flux/schnell');
    }
    res.json({ url });
  } catch (err) {
    console.error('genimage error', err?.message);
    res.status(502).json({ error: 'image failed' });
  }
});

// ---------------------------------------------------------------- face
// If you haven't added your own face yet, grab a free one once.
// thispersondoesnotexist.com images are AI-generated, so no real person is shown.
async function ensureFace() {
  if (findFace()) return;
  try {
    const r = await fetch('https://thispersondoesnotexist.com/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.writeFileSync(path.join(PUBLIC, 'face.jpg'), Buffer.from(await r.arrayBuffer()));
    console.log('Downloaded a placeholder face to public/face.jpg (replace it with your own any time).');
  } catch (err) {
    console.warn('Could not download a placeholder face:', err.message, '- put any portrait at public/face.jpg');
  }
}

// The face landmark model (about 3.6 MB) is downloaded once and kept locally.
const MODEL_FILE = path.join(PUBLIC, 'models', 'face_landmarker.task');
async function ensureLandmarkModel() {
  if (fs.existsSync(MODEL_FILE)) return;
  try {
    const r = await fetch('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
    fs.writeFileSync(MODEL_FILE, Buffer.from(await r.arrayBuffer()));
    console.log('Downloaded the face landmark model.');
  } catch (err) {
    console.warn('Could not download the face landmark model:', err.message);
  }
}

await Promise.all([ensureFace(), ensureLandmarkModel()]);
app.listen(PORT, () => {
  console.log(`\n  AI Face is running:  http://localhost:${PORT}\n`);
  console.log(`  Claude: ${anthropic ? 'ready (' + MODEL + ', ' + SPEED + ')' : 'MISSING ANTHROPIC_API_KEY'}`);
  console.log(`  Voice:  ${ELEVEN_KEY ? 'ElevenLabs' : 'browser voice (add ELEVENLABS_API_KEY for a realistic voice)'}`);
  console.log(`  AI images: ${FAL_KEY ? 'fal.ai FLUX' : 'off (add FAL_KEY)'}`);
  console.log(`  Password: ${process.env.APP_PASSWORD ? 'on' : 'off (only this computer can use it; set APP_PASSWORD to use it from your phone)'}\n`);
});
