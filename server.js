// Talking-face AI super search assistant: small Node server.
// It keeps your API keys private and streams everything to the browser
// as fast as possible (answers, voice and images).
import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const SPEED = (process.env.CLAUDE_SPEED || 'fast').toLowerCase() === 'standard' ? 'standard' : 'fast';
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const FAL_KEY = process.env.FAL_KEY || '';

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const app = express();
app.use(express.json({ limit: '1mb' }));
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
  });
});

function findFace() {
  for (const f of ['face.png', 'face.jpg', 'face.jpeg', 'face.webp']) {
    const p = path.join(PUBLIC, f);
    if (fs.existsSync(p)) return '/' + f + '?v=' + Math.round(fs.statSync(p).mtimeMs);
  }
  return null;
}

// ---------------------------------------------------------------- ask (SSE)
const systemPrompt = () => `You are a friendly, brilliant AI search assistant with a human face. The user sees your face and hears you speak, so everything you write is read aloud.

Rules:
- Reply in the same language the user used.
- Be fast and spoken: usually 2 to 5 short sentences, unless the user asks for more detail.
- No markdown, no bullet lists, no URLs, no emojis. Write numbers and dates the way you'd say them.
- Use web search when the question needs current or specific facts. Don't announce that you are searching.
- VERY FIRST thing in every reply, before anything else (even before searching): one line in this exact format with 3 to 5 short, concrete, visual English image search terms for the topic:
[[img: term one | term two | term three]]
  You may add one more [[img: ...]] line later if the topic shifts. These lines are hidden from the user and drive pictures on screen.

Today's date is ${new Date().toDateString()}.`;

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
  const messages = [
    ...history
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: question },
  ];
  // history must start with a user turn and alternate
  while (messages.length && messages[0].role !== 'user') messages.shift();

  const tagParser = makeTagParser(
    (t) => send('text', { t }),
    (terms) => send('images', { terms }),
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
  } catch (err) {
    console.error('ask error:', err?.status, err?.message);
    send('error', { message: friendlyError(err) });
  }
  res.end();
});

async function runStream(messages, speed, { onText, onBlock, isClosed }) {
  const params = {
    model: MODEL,
    max_tokens: 4000,
    system: systemPrompt(),
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
      const m = inner.match(/^\s*img\s*:(.*)$/is);
      if (m) {
        const terms = m[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 6);
        if (terms.length) onTerms(terms);
      }
    }
  };
  return { push: (t) => { buf += t; drain(false); }, flush: () => drain(true) };
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
app.post('/api/genimage', async (req, res) => {
  if (!FAL_KEY) return res.status(404).json({ error: 'no image key' });
  const prompt = String(req.body?.prompt || '').slice(0, 500);
  try {
    const r = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: `${prompt}, cinematic, highly detailed, dramatic lighting, photorealistic`,
        image_size: 'landscape_16_9',
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.images?.[0]?.url) {
      console.error('fal error', r.status, JSON.stringify(j).slice(0, 300));
      return res.status(502).json({ error: 'image failed' });
    }
    res.json({ url: j.images[0].url });
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
  console.log(`  AI images: ${FAL_KEY ? 'fal.ai FLUX' : 'off (add FAL_KEY)'}\n`);
});
