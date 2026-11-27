// Password lock: with APP_PASSWORD set, every page and API needs you to sign
// in once per browser (remembered for a year). Without a password, only this
// computer itself can use the app, so it is never open to the internet by
// accident.
import crypto from 'node:crypto';
import express from 'express';

const COOKIE = 'aiface_auth';
const YEAR = 365 * 24 * 3600;

export function setupLock(app, password) {
  const token = password
    ? crypto.createHmac('sha256', password).update('ai-face-assistant v1').digest('base64url')
    : '';
  const fails = new Map(); // ip -> { n, until }

  const isLocal = (req) => {
    // a tunnel or proxy adds these headers; then the visitor is NOT local
    if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false;
    const ip = req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  };
  const signedIn = (req) => {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return false;
    const a = Buffer.from(m[1]), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  app.get('/login', (req, res) => {
    if (!password) return res.redirect('/');
    res.type('html').send(loginPage(req.query.e === '1', req.query.wait));
  });

  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    if (!password) return res.redirect('/');
    const ip = req.headers['cf-connecting-ip'] || req.ip || 'x';
    const f = fails.get(ip) || { n: 0, until: 0 };
    if (Date.now() < f.until) return res.redirect('/login?wait=' + Math.ceil((f.until - Date.now()) / 1000));
    const given = Buffer.from(String(req.body?.password || ''));
    const want = Buffer.from(password);
    const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      f.n++;
      // slow down guessing: after 5 wrong tries, wait longer each time
      if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60, 2 ** (f.n - 4) * 15) * 1000;
      fails.set(ip, f);
      return res.redirect('/login?e=1');
    }
    fails.delete(ip);
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; Max-Age=${YEAR}; HttpOnly; SameSite=Lax${secure}`);
    res.redirect('/');
  });

  app.get('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    res.redirect(password ? '/login' : '/');
  });

  // the app icon, manifest and service worker are harmless and must load
  // before you sign in, so the phone can install the app
  const PUBLIC_PATHS = /^\/(manifest\.json|sw\.js|icons\/[\w.-]+\.png)$/;

  app.use((req, res, next) => {
    if (PUBLIC_PATHS.test(req.path)) return next();
    if (password ? signedIn(req) : isLocal(req)) return next();
    if (!password) {
      return res.status(403).type('html').send(page('Locked',
        '<p>This assistant is only open on the computer it runs on.</p><p>To use it from your phone, set <code>APP_PASSWORD</code> in the <code>.env</code> file and restart.</p>'));
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in again.' });
    res.redirect('/login');
  });
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><meta name="theme-color" content="#03050a"><link rel="manifest" href="/manifest.json"><link rel="icon" href="/icons/favicon.png"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Nova"><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 40%,#0d1424,#02030a 70%);color:#eef3ff;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}
.box{width:min(360px,100%);padding:28px;border-radius:20px;background:rgba(14,18,28,.8);border:1px solid rgba(255,255,255,.12);text-align:center}
h1{font-size:22px;margin:0 0 14px}input{width:100%;box-sizing:border-box;font-size:18px;padding:12px 14px;border-radius:12px;border:1px solid rgba(255,255,255,.18);background:#0b0f18;color:#eef3ff;margin-bottom:12px}
button{width:100%;font-size:18px;padding:12px;border:0;border-radius:999px;cursor:pointer;color:#001018;background:linear-gradient(135deg,#4fd1ff,#a36bff)}
.err{color:#ff8fa3;margin:0 0 12px}code{background:#1a2030;padding:1px 5px;border-radius:5px}</style></head>
<body><div class="box">${body}</div></body></html>`;
}

function loginPage(wrong, wait) {
  const msg = wait ? `<p class="err">Too many tries. Wait ${Number(wait) || 30} seconds.</p>` : wrong ? '<p class="err">Wrong password, try again.</p>' : '';
  return page('Sign in', `<h1>AI Face</h1>${msg}<form method="post" action="/login">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<button type="submit">Open</button></form>`);
}
