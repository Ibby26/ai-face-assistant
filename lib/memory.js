// Long-term memory: short notes about you (name, interests, preferences, things
// you asked it to remember) plus your recent questions, kept in one small file
// on your own computer (data/memory.json). Claude updates the notes every few
// answers in the background, so it never slows down a reply.
import fs from 'node:fs';
import path from 'node:path';

const MAX_TURNS = 200;

export function createMemory({ dir, anthropic, model }) {
  const file = path.join(dir, 'memory.json');
  let mem = { profile: '', turns: [], pending: 0 };
  try { mem = { ...mem, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let updating = false;

  const save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(mem, null, 1));
      fs.renameSync(tmp, file);
    } catch (err) { console.warn('Could not save memory:', err.message); }
  };

  async function updateProfile() {
    if (!anthropic || updating || !mem.pending) return;
    updating = true;
    const recent = mem.turns.slice(-Math.min(mem.pending, 8));
    const count = mem.pending;
    try {
      const r = await anthropic.beta.messages.create({
        model,
        max_tokens: 600,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: `You keep short private notes about the one person who uses a voice assistant, so it can personalise future answers.
Keep: their name, where they live, languages they use, their interests and the subjects they ask about often, how they like answers, and anything they explicitly asked to be remembered.
Drop one-off trivia and anything they asked to forget. Never store passwords, card numbers or similar secrets.
Write at most 120 words in English, as short plain sentences. Output only the notes.`,
        messages: [{
          role: 'user',
          content: `Current notes:\n${mem.profile || '(none yet)'}\n\nNew conversation:\n${recent.map((t) => `User: ${t.q}\nAssistant: ${t.a.slice(0, 400)}`).join('\n\n')}\n\nWrite the updated notes.`,
        }],
      });
      const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) mem.profile = text.slice(0, 1500);
      mem.pending = Math.max(0, mem.pending - count);
      save();
    } catch (err) {
      console.warn('Memory update failed:', err?.message);
    } finally {
      updating = false;
    }
  }

  return {
    record(q, a) {
      mem.turns.push({ t: Date.now(), q: q.slice(0, 1000), a: a.slice(0, 2000) });
      if (mem.turns.length > MAX_TURNS) mem.turns = mem.turns.slice(-MAX_TURNS);
      mem.pending++;
      save();
      // personal things are noted right away; otherwise every 3 answers
      if (mem.pending >= 3 || /\b(remember|forget|my name|call me|i live|i am|i'm)\b/i.test(q)) updateProfile();
    },
    promptText() {
      if (!mem.profile && !mem.turns.length) return '';
      let s = '\n\nYou remember this person from earlier conversations. Use it naturally when it helps (for example, their name or interests), but don\'t recite it or say you are remembering.';
      if (mem.profile) s += `\nNotes about them:\n${mem.profile}`;
      const recent = mem.turns.slice(-8);
      if (recent.length) {
        s += '\nTheir most recent earlier questions (oldest first):\n' + recent.map((t) => {
          const d = new Date(t.t).toISOString().slice(0, 10);
          return `- ${d}: ${t.q.slice(0, 160)}`;
        }).join('\n');
      }
      return s;
    },
    summary() {
      return { profile: mem.profile, count: mem.turns.length };
    },
    clear() {
      mem = { profile: '', turns: [], pending: 0 };
      save();
    },
  };
}
