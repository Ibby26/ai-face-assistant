// "npm run online": starts the assistant and opens a free, private https link
// to it through Cloudflare, so you can use it on your phone from anywhere.
// Your computer must stay on (and awake) while you use it.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';

if (!process.env.APP_PASSWORD) {
  console.error(`
  Please set a password first, so only you can open it.
  Open the .env file, add a line like this, save, and run "npm run online" again:

    APP_PASSWORD=pick-a-long-password-here
`);
  process.exit(1);
}

await import('../server.js');
const port = Number(process.env.PORT || 3000);

const bin = process.env.CLOUDFLARED || 'cloudflared';
const tunnel = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let shown = false;
const watch = (data) => {
  const m = String(data).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !shown) {
    shown = true;
    console.log(`
  ==============================================================
   Your private link (works on your phone, anywhere):

     ${m[0]}

   Scan this with your phone's camera, then sign in with your password:
`);
    qrcode.generate(m[0], { small: true }, (q) => console.log(q.replace(/^/gm, '     ')));
    console.log(`   The link changes each time you run this. Keep this window open.
  ==============================================================
`);
  }
};
tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);
tunnel.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(`
  Cloudflare's free tunnel tool (cloudflared) isn't installed yet. Install it once:

    Windows:  winget install --id Cloudflare.cloudflared
    Mac:      brew install cloudflared
    Other:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

  Then close this window, open a new one, and run "npm run online" again.
  (The assistant is still running here at http://localhost:${port})
`);
  } else console.error('Tunnel error:', err.message);
});
tunnel.on('exit', (code) => { if (code) console.error(`  The tunnel stopped (code ${code}). Run "npm run online" again.`); });
const stop = () => { tunnel.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
