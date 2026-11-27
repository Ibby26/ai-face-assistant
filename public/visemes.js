// Turns spoken letters into mouth shapes ("visemes").
// open: how far the jaw drops (0..1), width: lip width (1 = relaxed,
// <1 = rounded/pursed, >1 = spread/smile), teeth: how much upper teeth show.

export const SHAPES = {
  rest: { open: 0.0, width: 1.0, teeth: 0.0 },
  MBP: { open: 0.0, width: 0.94, teeth: 0.0, closed: true }, // lips pressed: m b p
  FV: { open: 0.1, width: 1.02, teeth: 1.0 }, // top teeth on lower lip: f v
  TH: { open: 0.22, width: 1.02, teeth: 0.9 },
  AA: { open: 0.95, width: 1.05, teeth: 0.5 }, // father, cat
  E: { open: 0.5, width: 1.15, teeth: 0.7 }, // bed
  I: { open: 0.28, width: 1.22, teeth: 0.8 }, // see
  O: { open: 0.7, width: 0.74, teeth: 0.2 }, // go
  U: { open: 0.3, width: 0.62, teeth: 0.0 }, // too, w
  CH: { open: 0.25, width: 0.88, teeth: 0.9 }, // sh ch j
  S: { open: 0.15, width: 1.12, teeth: 1.0 }, // s z
  T: { open: 0.3, width: 1.04, teeth: 0.7 }, // t d n l
  K: { open: 0.38, width: 1.0, teeth: 0.5 }, // k g h
  R: { open: 0.3, width: 0.82, teeth: 0.3 },
};

const MAP = {};
const add = (shape, letters) => { for (const ch of letters) MAP[ch] = shape; };
// Latin (most European languages, plus accents)
add('AA', 'aáàâäãåāą');
add('E', 'eéèêëēęě');
add('I', 'iíìîïīıyýÿ');
add('O', 'oóòôöõøō');
add('U', 'uúùûüūůwq');
add('MBP', 'mbp');
add('FV', 'fv');
add('S', 'szśźżşšžßcç');
add('CH', 'jxč');
add('T', 'tdnlñńňłţť');
add('K', 'kghğ');
add('R', 'rř');
// Cyrillic
add('AA', 'аяэ'); add('E', 'еєё'); add('I', 'иіїйы'); add('O', 'о'); add('U', 'уюў');
add('MBP', 'мбп'); add('FV', 'фв'); add('S', 'сзц'); add('CH', 'шщчж');
add('T', 'тдлн'); add('K', 'кгх'); add('R', 'р');
// Greek
add('AA', 'αά'); add('E', 'εέηή'); add('I', 'ιίυύ'); add('O', 'οόωώ');
add('MBP', 'μβπ'); add('FV', 'φ'); add('S', 'σςζξψ'); add('T', 'τδλνθ'); add('K', 'κγχ'); add('R', 'ρ');
// Arabic / Persian / Urdu
add('AA', 'اآأإىةه'); add('U', 'وؤ'); add('I', 'يئی'); add('MBP', 'مبپ'); add('FV', 'فڤ');
add('S', 'سصزظث'); add('CH', 'شجچژ'); add('T', 'تطدضلنذر'); add('K', 'كکگقغخحع');
// Hebrew
add('AA', 'אה'); add('U', 'ו'); add('I', 'י'); add('MBP', 'מםבפף'); add('S', 'סזצץש');
add('T', 'תטדלנן'); add('K', 'כךגקחע'); add('R', 'ר');
// Devanagari (Hindi) vowels and common consonants
add('AA', 'अआा'); add('I', 'इईिी'); add('U', 'उऊुू'); add('E', 'एऐेै'); add('O', 'ओऔोौ');
add('MBP', 'मबपभफ'); add('FV', 'व'); add('S', 'सशषज़'); add('T', 'तदनलटडथध'); add('K', 'कगखघह'); add('R', 'र');
// Japanese kana by vowel
add('AA', 'あかさたなはまやらわがざだばぱアカサタナハマヤラワガザダバパ');
add('I', 'いきしちにひみりぎじぢびぴイキシチニヒミリギジヂビピ');
add('U', 'うくすつぬふむゆるぐずづぶぷウクスツヌフムユルグズヅブプ');
add('E', 'えけせてねへめれげぜでべぺエケセテネヘメレゲゼデベペ');
add('O', 'おこそとのほもよろをごぞどぼぽオコソトノホモヨロヲゴゾドボポ');

// Korean Hangul: read the vowel inside each syllable block
function hangul(ch) {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  const v = Math.floor((code % 588) / 28);
  // ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ
  return ['AA', 'E', 'AA', 'E', 'O', 'E', 'O', 'E', 'O', 'AA', 'E', 'E', 'O', 'U', 'O', 'E', 'I', 'U', 'I', 'I', 'I'][v];
}

// letters we can't map (e.g. Chinese characters) cycle through natural shapes
const CYCLE = ['AA', 'E', 'O', 'I', 'U'];

export function shapeFor(ch, i = 0) {
  if (!ch || /\s/.test(ch)) return null; // gap between words
  const lower = ch.toLowerCase();
  const name = MAP[lower] || hangul(ch);
  if (name) return SHAPES[name];
  if (/[\p{P}\p{S}\d]/u.test(ch)) return null;
  if (/\p{L}/u.test(ch)) return SHAPES[CYCLE[i % CYCLE.length]];
  return null;
}

// Mouth shape at time t (seconds) in a clip with letter timings.
// Blends toward the next sound for smooth, natural movement (coarticulation).
export function shapeAt(al, t) {
  const { chars, starts, ends } = al;
  const n = chars.length;
  if (!n || t < (starts[0] ?? 0) - 0.08 || t > (ends[n - 1] ?? 0) + 0.05) return SHAPES.rest;
  // binary search for the letter being spoken
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t) lo = mid; else hi = mid - 1;
  }
  const i = lo;
  const cur = shapeAt.pick(chars, i, 0);
  const dur = Math.max(0.02, (ends[i] ?? starts[i] + 0.06) - starts[i]);
  const f = Math.max(0, Math.min(1, (t - starts[i]) / dur));
  const next = shapeAt.pick(chars, i + 1, 1);
  // start moving to the next shape in the last 40% of this sound
  const k = f < 0.6 ? 0 : (f - 0.6) / 0.4;
  return mix(cur, next, k * 0.6);
}
// letters with no shape of their own (spaces, punctuation, silent letters)
// borrow from their neighbours so the mouth doesn't snap shut mid-word
shapeAt.pick = (chars, i, dir) => {
  const s = shapeFor(chars[i], i);
  if (s) return s;
  // between words the mouth doesn't snap shut; keep the neighbouring shape
  // (loudness closes it in real pauses)
  const j = dir ? i + 1 : i - 1;
  return (chars[j] && shapeFor(chars[j], j)) || SHAPES.rest;
};

export function mix(a, b, k) {
  return {
    open: a.open + (b.open - a.open) * k,
    width: a.width + (b.width - a.width) * k,
    teeth: a.teeth + (b.teeth - a.teeth) * k,
    closed: k < 0.5 ? !!a.closed : !!b.closed,
  };
}
