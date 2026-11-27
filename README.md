# AI Face – talking AI super search assistant

A big, realistic face that you talk to. It assembles itself from glowing AI fragments when it wakes up, answers any question in your language with live web search, speaks the answer with lip-synced mouth movement, and floods the screen with fast-changing real photos and AI-generated pictures while it thinks and talks.

## What you need

- **Node.js 20 or newer** – download from https://nodejs.org (pick "LTS").
- **Chrome or Edge** on your computer (best mic and audio support).
- API keys (below). Only the Anthropic key is required; the other two make it much better.

| Key | What it does | Where to get it | Rough cost |
|---|---|---|---|
| `ANTHROPIC_API_KEY` (required) | The brain: answers + live web search | https://console.anthropic.com/settings/keys (add a few dollars of credit under Billing) | about 1–3 cents per question in fast mode, plus $10 per 1,000 web searches |
| `ELEVENLABS_API_KEY` (recommended) | Realistic streaming voice in 30+ languages, and the "auto-detect any language" microphone | https://elevenlabs.io/app/settings/api-keys (the $5 or $22/month plan) | included in plan |
| `FAL_KEY` (recommended) | AI-generated images in about a second (FLUX) | https://fal.ai/dashboard/keys (add credit) | about 0.3 cents per image, 2–3 per question |

Without ElevenLabs the face uses your browser's built-in voice. Without fal.ai you still get real photos.

## Run it

```bash
git clone <this repo>
cd ai-face-assistant
npm install
cp .env.example .env        # on Windows: copy .env.example .env
```

Open `.env` in any text editor, paste your keys after the `=` signs, save, then:

```bash
npm start
```

Open **http://localhost:3000**, click **Tap to wake**, and allow the microphone when asked.

## Using it

- **Talk:** click the mic (or hold **Space**), speak, and stop talking. It answers automatically.
- **Type:** type in the box and press Enter.
- **Interrupt:** start talking or asking again at any time; **Esc** stops it.
- **Language:** just speak or type in any language; it answers in the same one. In Settings (gear icon) you can pin the microphone to one language, which is a little faster than auto-detect.

## Change the face

Two easy ways:

1. **In the app:** Settings → **Change face…** and pick any portrait photo. It's remembered in that browser.
2. **For good:** save your picture as `public/face.jpg` (or `.png`) and refresh.

Best results: a front-facing photo, face roughly centered, mouth closed, good light, at least 600 pixels tall. The mouth and eyes are found automatically. To check, turn on Settings → **Show face mesh**: the mesh should sit on the face, with a pink line along the lips.

On the first start, if there is no face yet, the server downloads a free one from thispersondoesnotexist.com (an AI-generated person, so it's nobody real).

## The morphing face

The face never stops changing: its eyes, brows, nose, lips, cheekbones and jawline each slowly turn into features from other people, one after another, while the gaze stays steady. Skin tone and lighting always come from your main photo, so it reads as one living face.

- On first start the server downloads 8 AI-generated faces (people who don't exist) into `public/faces`.
- Add your own photos to `public/faces` (front-facing works best) and refresh. Photos there are never committed to git.
- Turn it off any time in Settings → **Morph between different people's features**.

## Speed settings

The app is built for speed: the answer streams word by word, each sentence is turned into speech the moment it's written, and pictures appear before the answer is even ready.

- `CLAUDE_SPEED=fast` (default) uses Claude's fast mode: up to 2.5× faster replies at twice the token price. If your account can't use fast mode yet, it automatically falls back to standard speed. Set it to `standard` to save money.
- `CLAUDE_MODEL` defaults to `claude-opus-5-5`.

## How it works

- `server.js` – keeps your keys private. `/api/ask` streams Claude's answer (with web search), `/api/tts` returns ElevenLabs Flash voice per sentence with per-letter timing, `/api/stt` transcribes speech with automatic language detection, `/api/genimage` makes FLUX images on fal.ai.
- `public/face.js` – the face: shard intro, then the talking photo, blinking and idle head motion.
- `public/mesh.js` – realistic talking: finds 478 points on the face (MediaPipe, served by this app; the model is downloaded once on first start), wraps the photo on a triangle mesh and moves it like a real jaw, lips and eyelids on the GPU. Where the lips part, a soft mouth interior shows through; if the photo already shows teeth, those are kept.
- `public/visemes.js` – turns each spoken letter into a mouth shape. ElevenLabs reports exactly when every letter is spoken, so the mouth forms “m”, “o”, “ee”, “f” and so on in time with the voice (works for Latin, Cyrillic, Greek, Arabic, Hebrew, Hindi, Japanese kana and Korean; other scripts fall back to natural movement).
- `public/app.js` – mic, streaming, the voice queue and the picture stream (Wikipedia and Wikimedia Commons photos plus AI images).
