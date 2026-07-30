// Engine / motor / transmission defect detection over seller free text.
// The whole difficulty is negation: "no engine issues" and "new transmission"
// must PASS. See docs/FILTERS.md section 4 for the reasoning and the worked
// examples. When you find a phrasing this gets wrong, add it to
// tests/defects.test.js FIRST, then fix the rule.

/** Phrases that say the drivetrain is fine. Suppress weak flags; never a strong reject. */
export const POSITIVE_OVERRIDES = [
  'no engine issues', 'no engine problems', 'no mechanical issues',
  'no mechanical problems', 'no transmission issues', 'no transmission problems',
  'no issues', 'no problems', 'no leaks', 'no knocking', 'no smoke',
  'runs great', 'runs good', 'runs strong', 'runs perfect', 'runs like new',
  'runs and drives', 'run and drive', 'runs drives', 'drives great',
  'drives good', 'drives perfect', 'drives excellent', 'drives smooth',
  'motor runs strong', 'engine runs great', 'engine runs strong',
  'new engine', 'new motor', 'engine replaced', 'motor replaced',
  'engine rebuilt', 'motor rebuilt', 'rebuilt engine', 'rebuilt motor',
  'recently rebuilt', 'new transmission', 'transmission replaced',
  'rebuilt transmission', 'transmission rebuilt', 'recently serviced',
  'well maintained', 'shifts great', 'shifts smooth', 'shifts good',
  'cold ac', 'ice cold ac',

  // --- Spanish -------------------------------------------------------------
  // These matter as much as the negatives. Spanish listings lead with what
  // works ("corre y camina bien", "motor nuevo"), and without these the weak
  // flags would fire on cars the seller is describing as healthy.
  'no tiene problemas', 'sin problemas', 'sin fallas', 'no tiene fallas',
  'corre bien', 'camina bien', 'corre y camina', 'anda bien', 'jala bien',
  'funciona bien', 'trabaja bien', 'muy buenas condiciones',
  'buenas condiciones', 'excelentes condiciones', 'en buen estado',
  'motor nuevo', 'motor reconstruido', 'transmision nueva',
  'transmision reconstruida', 'recien reparado', 'recien servicio',
  'aire frio', 'todo funciona', 'titulo limpio',
];

/** Unambiguous. These reject. */
export const STRONG_NEGATIVES = [
  { phrase: 'needs engine', reason: 'defect_engine' },
  { phrase: 'need engine', reason: 'defect_engine' },
  { phrase: 'needs a engine', reason: 'defect_engine' },
  { phrase: 'needs an engine', reason: 'defect_engine' },
  { phrase: 'needs motor', reason: 'defect_engine' },
  { phrase: 'needs a motor', reason: 'defect_engine' },
  { phrase: 'needs new engine', reason: 'defect_engine' },
  { phrase: 'needs new motor', reason: 'defect_engine' },
  { phrase: 'blown engine', reason: 'defect_engine' },
  { phrase: 'blown motor', reason: 'defect_engine' },
  { phrase: 'engine blown', reason: 'defect_engine' },
  { phrase: 'motor blown', reason: 'defect_engine' },
  { phrase: 'bad engine', reason: 'defect_engine' },
  { phrase: 'bad motor', reason: 'defect_engine' },
  { phrase: 'engine knock', reason: 'defect_engine' },
  { phrase: 'rod knock', reason: 'defect_engine' },
  { phrase: 'knocking noise', reason: 'defect_engine' },
  { phrase: 'seized', reason: 'defect_engine' },
  { phrase: 'locked up', reason: 'defect_engine' },
  { phrase: 'blown head gasket', reason: 'defect_engine' },
  { phrase: 'head gasket blown', reason: 'defect_engine' },
  { phrase: 'needs head gasket', reason: 'defect_engine' },
  { phrase: 'bad head gasket', reason: 'defect_engine' },
  { phrase: 'overheats', reason: 'defect_engine' },
  { phrase: 'overheating', reason: 'defect_engine' },

  { phrase: 'bad transmission', reason: 'defect_transmission' },
  { phrase: 'transmission bad', reason: 'defect_transmission' },
  { phrase: 'blown transmission', reason: 'defect_transmission' },
  { phrase: 'transmission slipping', reason: 'defect_transmission' },
  { phrase: 'slipping transmission', reason: 'defect_transmission' },
  { phrase: 'slips gears', reason: 'defect_transmission' },
  { phrase: 'slipping gears', reason: 'defect_transmission' },
  { phrase: 'needs transmission', reason: 'defect_transmission' },
  { phrase: 'needs a transmission', reason: 'defect_transmission' },
  { phrase: 'no reverse', reason: 'defect_transmission' },
  { phrase: 'wont go in reverse', reason: 'defect_transmission' },
  { phrase: 'wont shift', reason: 'defect_transmission' },
  { phrase: 'doesnt shift', reason: 'defect_transmission' },
  { phrase: 'hard shifting', reason: 'defect_transmission' },
  { phrase: 'bad trans', reason: 'defect_transmission' },

  { phrase: 'wont start', reason: 'defect_not_running' },
  { phrase: 'doesnt start', reason: 'defect_not_running' },
  { phrase: 'does not start', reason: 'defect_not_running' },
  { phrase: 'no start', reason: 'defect_not_running' },
  { phrase: 'not running', reason: 'defect_not_running' },
  { phrase: 'non running', reason: 'defect_not_running' },
  { phrase: 'nonrunning', reason: 'defect_not_running' },
  { phrase: 'not run', reason: 'defect_not_running' },
  { phrase: 'wont crank', reason: 'defect_not_running' },
  { phrase: 'wont run', reason: 'defect_not_running' },
  { phrase: 'doesnt run', reason: 'defect_not_running' },
  { phrase: 'not drivable', reason: 'defect_not_running' },
  { phrase: 'not driveable', reason: 'defect_not_running' },

  { phrase: 'for parts', reason: 'defect_parts_only' },
  { phrase: 'parts only', reason: 'defect_parts_only' },
  { phrase: 'parts car', reason: 'defect_parts_only' },
  { phrase: 'part out', reason: 'defect_parts_only' },
  { phrase: 'partout', reason: 'defect_parts_only' },
  { phrase: 'parting out', reason: 'defect_parts_only' },
  { phrase: 'part it out', reason: 'defect_parts_only' },
  { phrase: 'mechanic special', reason: 'defect_parts_only' },
  { phrase: 'mechanics special', reason: 'defect_parts_only' },
  { phrase: 'project car', reason: 'defect_parts_only' },

  // --- Spanish -------------------------------------------------------------
  // 31% of DFW listings are in Spanish. Without these, every one of them
  // bypassed defect detection entirely: "no prende", "motor malo" and
  // "para partes" were all sitting on the dashboard marked good.
  // Text is accent-stripped by normalizeText, so write these unaccented.
  { phrase: 'motor fundido', reason: 'defect_engine' },
  { phrase: 'motor malo', reason: 'defect_engine' },
  { phrase: 'motor danado', reason: 'defect_engine' },
  { phrase: 'motor quemado', reason: 'defect_engine' },
  { phrase: 'mal motor', reason: 'defect_engine' },
  { phrase: 'se calienta', reason: 'defect_engine' },        // overheats
  { phrase: 'se calento', reason: 'defect_engine' },         // overheated (past)
  { phrase: 'se sobrecalienta', reason: 'defect_engine' },
  { phrase: 'se sobrecalento', reason: 'defect_engine' },
  { phrase: 'detalles en el motor', reason: 'defect_engine' },
  { phrase: 'junta de culata', reason: 'defect_engine' },    // head gasket
  { phrase: 'empaque de cabeza', reason: 'defect_engine' },
  { phrase: 'motor golpeado', reason: 'defect_engine' },

  { phrase: 'transmision mala', reason: 'defect_transmission' },
  { phrase: 'mala transmision', reason: 'defect_transmission' },
  { phrase: 'transmision danada', reason: 'defect_transmission' },
  { phrase: 'caja mala', reason: 'defect_transmission' },
  { phrase: 'no cambia', reason: 'defect_transmission' },     // won't shift
  { phrase: 'no mete cambios', reason: 'defect_transmission' },
  { phrase: 'no tiene reversa', reason: 'defect_transmission' },
  { phrase: 'sin reversa', reason: 'defect_transmission' },
  // "patina" (slips) is deliberately NOT a bare phrase — it's also an English
  // word, and "great patina" on a classic is a selling point. Only the
  // transmission-qualified forms count; see STRONG_NEGATIVE_PATTERNS.

  { phrase: 'no arranca', reason: 'defect_not_running' },
  { phrase: 'no prende', reason: 'defect_not_running' },
  { phrase: 'no enciende', reason: 'defect_not_running' },
  { phrase: 'no camina', reason: 'defect_not_running' },
  { phrase: 'no jala', reason: 'defect_not_running' },
  { phrase: 'no corre', reason: 'defect_not_running' },
  // "no funciona" / "no sirve" are left out on purpose: they attach to the AC
  // or the radio at least as often as to the drivetrain, and our bias is that
  // letting junk through beats rejecting a good car. They flag instead.

  { phrase: 'para partes', reason: 'defect_parts_only' },
  { phrase: 'por partes', reason: 'defect_parts_only' },
  { phrase: 'para piezas', reason: 'defect_parts_only' },
  { phrase: 'solo partes', reason: 'defect_parts_only' },
  { phrase: 'para refacciones', reason: 'defect_parts_only' },
];

/**
 * Same weight as STRONG_NEGATIVES, but for families a fixed phrase list can't
 * cover. "needs transmission", "needs a new transmission", "need another
 * motor" are one idea with a dozen spellings — enumerating them all is how
 * "NEEDS TRANSMISSION" reached the dashboard the first time.
 */
export const STRONG_NEGATIVE_PATTERNS = [
  {
    // needs / need + optional filler + engine|motor
    pattern: /needs?\s+(?:a\s+|an\s+|another\s+|new\s+|good\s+|complete\s+|rebuilt\s+|replacement\s+)*(?:engine|motor)\b/g,
    reason: 'defect_engine',
  },
  {
    pattern: /needs?\s+(?:a\s+|an\s+|another\s+|new\s+|good\s+|complete\s+|rebuilt\s+|replacement\s+)*(?:transmission|tranny|trany|trans)\b/g,
    reason: 'defect_transmission',
  },
  {
    // "transmission work", "engine work" — a rebuild by another name
    pattern: /\b(?:transmission|tranny|trans|engine|motor)\s+work\b/g,
    reason: 'defect_transmission',
  },
  {
    // slips / slipping, in either order
    pattern: /\b(?:transmission|tranny|trans)\s+(?:is\s+)?slip(?:s|ping)?\b/g,
    reason: 'defect_transmission',
  },
  {
    pattern: /\bslipping\s+(?:transmission|tranny|trans)\b/g,
    reason: 'defect_transmission',
  },
  // Spanish "needs X". Accent-stripped upstream, so "transmisión" is "transmision".
  // Split by part so the reason code is right — "necesita motor" is an engine
  // fault, not a transmission one.
  {
    pattern: /\bnecesita\s+(?:un\s+|una\s+|el\s+|la\s+|otro\s+|otra\s+|nuevo\s+|nueva\s+)*motor\b/g,
    reason: 'defect_engine',
  },
  {
    pattern: /\bnecesita\s+(?:un\s+|una\s+|el\s+|la\s+|otro\s+|otra\s+|nuevo\s+|nueva\s+)*(?:transmision|caja|clutch|cloch)\b/g,
    reason: 'defect_transmission',
  },
  {
    // "patina" only when it's clearly the transmission or clutch slipping —
    // never bare, because "patina" is an English noun too.
    pattern: /\b(?:transmision|caja|clutch|cloch)\s+patina\b|\bpatina\s+(?:la\s+|el\s+)?(?:transmision|caja|clutch|cloch)\b/g,
    reason: 'defect_transmission',
  },
  {
    pattern: /\b(?:carro|coche|troca|camioneta)\s+(?:de\s+)?proyecto\b|\bes\s+un\s+proyecto\b/g,
    reason: 'defect_parts_only',
  },
];

/** Ambiguous. These become a badge you can read, not a rejection. */
export const WEAK_NEGATIVES = [
  { phrase: 'check engine light', flag: 'check_engine_light' },
  { phrase: 'engine light', flag: 'check_engine_light' },
  { phrase: 'engine light on', flag: 'check_engine_light' },
  { phrase: 'as is', flag: 'sold_as_is' },
  { phrase: 'as-is', flag: 'sold_as_is' },
  { phrase: 'needs work', flag: 'needs_work' },
  { phrase: 'needs tlc', flag: 'needs_work' },
  { phrase: 'needs some work', flag: 'needs_work' },
  { phrase: 'engine issue', flag: 'engine_mentioned' },
  { phrase: 'engine issues', flag: 'engine_mentioned' },
  { phrase: 'engine problem', flag: 'engine_mentioned' },
  { phrase: 'motor issue', flag: 'engine_mentioned' },
  { phrase: 'transmission issue', flag: 'transmission_mentioned' },
  { phrase: 'transmission problem', flag: 'transmission_mentioned' },
  { phrase: 'trans issue', flag: 'transmission_mentioned' },
  { phrase: 'mechanical issue', flag: 'mechanical_issues' },
  { phrase: 'mechanical issues', flag: 'mechanical_issues' },
  { phrase: 'mechanical problem', flag: 'mechanical_issues' },
  { phrase: 'mechanical problems', flag: 'mechanical_issues' },
  { phrase: 'smokes', flag: 'smoking' },
  { phrase: 'smoking', flag: 'smoking' },
  { phrase: 'burns oil', flag: 'burns_oil' },
  { phrase: 'leaks oil', flag: 'oil_leak' },
  { phrase: 'oil leak', flag: 'oil_leak' },
  { phrase: 'timing chain', flag: 'timing' },
  { phrase: 'timing belt', flag: 'timing' },

  // --- Spanish -------------------------------------------------------------
  { phrase: 'no funciona', flag: 'something_not_working' },
  { phrase: 'no sirve', flag: 'something_not_working' },
  { phrase: 'necesita reparacion', flag: 'needs_work' },
  { phrase: 'necesita trabajo', flag: 'needs_work' },
  { phrase: 'necesita arreglo', flag: 'needs_work' },
  { phrase: 'como esta', flag: 'sold_as_is' },              // "as is"
  { phrase: 'tal como esta', flag: 'sold_as_is' },
  { phrase: 'luz del motor', flag: 'check_engine_light' },
  { phrase: 'check engine encendido', flag: 'check_engine_light' },
  { phrase: 'fuga de aceite', flag: 'oil_leak' },
  { phrase: 'tira aceite', flag: 'oil_leak' },
  { phrase: 'echa humo', flag: 'smoking' },
  { phrase: 'saca humo', flag: 'smoking' },
  { phrase: 'problema mecanico', flag: 'mechanical_issues' },
  { phrase: 'problemas mecanicos', flag: 'mechanical_issues' },
  { phrase: 'falla', flag: 'mechanical_issues' },
  { phrase: 'proyecto', flag: 'needs_work' },
];

/** Words that flip the meaning of a phrase that follows them. */
const NEGATORS = [
  'no', 'not', 'never', 'without', 'nothing', 'none', 'zero', 'dont',
  'doesnt', 'didnt', 'wont', 'isnt', 'arent', 'hasnt', 'havent', 'aint',
  // Spanish. "no" is shared. "sin" = without, "nunca" = never,
  // "ningun/ninguna" = none.
  'sin', 'nunca', 'ningun', 'ninguna', 'ningunos', 'nada',
];

/**
 * Words meaning the problem was already fixed.
 *
 * "just" was here and was a real bug: "runs great, just needs transmission"
 * got cancelled as if the transmission had been repaired, and the car reached
 * the dashboard. "just" minimizes, it doesn't repair. Anything genuinely
 * repaired says so with one of the verbs below ("just replaced" still cancels
 * on "replaced"), so nothing is lost by dropping it.
 */
const REPAIR_VERBS = [
  'new', 'brand', 'rebuilt', 'replaced', 'replacement', 'serviced', 'fixed',
  'repaired', 'changed', 'installed', 'refreshed', 'redone', 'upgraded',
  'swapped',
  // Spanish. Same idea: "motor nuevo" and "transmision reconstruida" describe a
  // car that was fixed, not one that's broken.
  'nuevo', 'nueva', 'nuevos', 'nuevas', 'reconstruido', 'reconstruida',
  'reparado', 'reparada', 'cambiado', 'cambiada', 'instalado', 'instalada',
  'reemplazado', 'reemplazada', 'arreglado', 'arreglada', 'recien',
];

// Cutting the lookback at these prevents a negator from an unrelated clause
// leaking forward. "No rust. Engine knock." must NOT cancel — without this the
// "no" in the previous sentence would wrongly clear the knock.
const CLAUSE_BREAKS = [
  // The comma is load-bearing. Without it, a real listing read
  // "Detalles en el motor, se calentó y ya no la moví, se va completa o por
  // partes" — and the "no" from "ya no la moví" reached forward two clauses to
  // cancel "por partes", so a car being sold for parts showed up as good.
  '.', '!', '?', ';', ',', '\n', '·',
  ' but ', ' however ', ' although ', ' though ',
  ' pero ', ' aunque ', ' sin embargo ',
];

const LOOKBACK_CHARS = 40;

/**
 * A negator has to be CLOSE to what it negates.
 *
 * "no engine issues" is one word apart. "no frena lo vendo así para partes" is
 * four — there the "no" belongs to "frena" (doesn't brake), and letting it
 * reach "para partes" marked a parts car as good. Measuring in words instead of
 * characters is what separates those two cases; 40 characters happily spans a
 * whole clause.
 */
const LOOKBACK_WORDS = 3;

/**
 * Lowercase, drop apostrophes ("won't" -> "wont"), strip accents, collapse
 * whitespace.
 *
 * Accent stripping is what makes the Spanish rules work: sellers write
 * "transmisión", "transmision", and "TRANSMISIÓN" interchangeably, and without
 * folding them together each spelling would need its own phrase.
 */
export function normalizeText(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/'/g, '')
    .replace(/[–—]/g, '-')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All matches for one of the STRONG_NEGATIVE_PATTERNS regexes. */
function findPatternOccurrences(haystack, pattern) {
  // Clone so the shared `g` regex doesn't carry lastIndex between calls.
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const hits = [];
  let match;
  while ((match = regex.exec(haystack)) !== null) {
    hits.push({ index: match.index, text: match[0] });
    if (match.index === regex.lastIndex) regex.lastIndex++;
  }
  return hits;
}

/** All match offsets for a phrase, on word boundaries. */
function findOccurrences(haystack, phrase) {
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(phrase)}(?![a-z0-9])`, 'g');
  const hits = [];
  let match;
  while ((match = pattern.exec(haystack)) !== null) {
    hits.push(match.index);
    if (match.index === pattern.lastIndex) pattern.lastIndex++;
  }
  return hits;
}

/**
 * Is this hit cancelled by a negator or repair verb just before it?
 * Only looks within the current clause.
 */
function isCancelled(haystack, index) {
  let window = haystack.slice(Math.max(0, index - LOOKBACK_CHARS), index);

  // Trim back to the start of the current clause.
  let cutAt = -1;
  for (const brk of CLAUSE_BREAKS) {
    const at = window.lastIndexOf(brk);
    if (at > cutAt) cutAt = at + brk.length - 1;
  }
  if (cutAt >= 0) window = window.slice(cutAt + 1);

  const words = window.split(/[^a-z0-9]+/).filter(Boolean).slice(-LOOKBACK_WORDS);
  return words.some((word) => NEGATORS.includes(word) || REPAIR_VERBS.includes(word));
}

/**
 * Scan title + description for drivetrain trouble.
 * @returns {{
 *   rejected: boolean,
 *   reasons: string[],
 *   flags: string[],
 *   positives: string[],
 *   cancelled: string[]
 * }}
 */
export function scanDefects(text) {
  const haystack = normalizeText(text);
  const result = { rejected: false, reasons: [], flags: [], positives: [], cancelled: [] };
  if (!haystack) return result;

  for (const phrase of POSITIVE_OVERRIDES) {
    if (findOccurrences(haystack, phrase).length) result.positives.push(phrase);
  }

  const reasons = new Set();
  for (const { phrase, reason } of STRONG_NEGATIVES) {
    for (const index of findOccurrences(haystack, phrase)) {
      if (isCancelled(haystack, index)) {
        // A cancelled hit is itself mildly reassuring — someone who volunteers
        // "no transmission problems" is usually telling the truth.
        result.cancelled.push(phrase);
        continue;
      }
      reasons.add(reason);
    }
  }

  for (const { pattern, reason } of STRONG_NEGATIVE_PATTERNS) {
    for (const { index, text } of findPatternOccurrences(haystack, pattern)) {
      if (isCancelled(haystack, index)) {
        result.cancelled.push(text);
        continue;
      }
      reasons.add(reason);
    }
  }

  const flags = new Set();
  for (const { phrase, flag } of WEAK_NEGATIVES) {
    for (const index of findOccurrences(haystack, phrase)) {
      if (isCancelled(haystack, index)) {
        result.cancelled.push(phrase);
        continue;
      }
      flags.add(flag);
    }
  }

  // A clear positive statement about how it runs clears the soft warnings.
  // "sold as is but runs and drives great" is a car worth looking at.
  // It deliberately does NOT clear a strong negative: "needs engine, runs
  // great otherwise" is still a car that needs an engine.
  const STRONG_POSITIVE_PREFIXES = [
    'runs', 'drives', 'run and',
    'corre', 'camina', 'anda bien', 'jala bien', 'funciona bien', 'trabaja bien',
  ];
  const hasStrongPositive = result.positives.some((p) =>
    STRONG_POSITIVE_PREFIXES.some((prefix) => p.startsWith(prefix)),
  );
  if (hasStrongPositive) flags.clear();

  result.reasons = [...reasons];
  result.flags = [...flags];
  result.rejected = result.reasons.length > 0;
  return result;
}
