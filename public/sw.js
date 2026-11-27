// Lets the app be installed on your home screen. Everything still comes live
// from your computer; only a small "you're offline" page is kept.
const CACHE = 'nova-v1';
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nova</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#03050a;color:#eaf2ff;font:16px system-ui;text-align:center;padding:24px">
<div><p style="font-size:20px;margin:0 0 8px">Nova can't be reached</p><p style="color:#8b97ad;margin:0">Check that your computer is on and running <code>npm run online</code>, then try again.</p>
<button onclick="location.reload()" style="margin-top:18px;padding:10px 22px;border:0;border-radius:999px;background:linear-gradient(135deg,#4fd1ff,#9b6bff);font:inherit;cursor:pointer">Try again</button></div>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // everything else goes straight to the network
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html' } })));
});
