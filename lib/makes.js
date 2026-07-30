// Make -> origin classification, and pulling year/make/model out of a listing title.
// See docs/FILTERS.md section 2 for the reasoning behind the three-pass normalization.

export const ORIGINS = {
  american: [
    'ford', 'chevrolet', 'gmc', 'dodge', 'ram', 'chrysler', 'jeep', 'buick',
    'cadillac', 'lincoln', 'pontiac', 'saturn', 'mercury', 'oldsmobile',
    'plymouth', 'hummer', 'tesla', 'eagle',
  ],
  japanese: [
    'toyota', 'honda', 'nissan', 'mazda', 'subaru', 'mitsubishi', 'lexus',
    'acura', 'infiniti', 'scion', 'suzuki', 'isuzu', 'datsun',
  ],
  korean: ['hyundai', 'kia', 'genesis', 'daewoo'],
  german: [
    'bmw', 'mercedes-benz', 'audi', 'volkswagen', 'porsche', 'mini', 'smart',
    'opel', 'maybach',
  ],
  other: [
    'volvo', 'land rover', 'range rover', 'jaguar', 'fiat', 'alfa romeo',
    'saab', 'peugeot', 'renault', 'citroen', 'ferrari', 'lamborghini',
    'maserati', 'bentley', 'rolls-royce', 'aston martin', 'lotus', 'lucid',
    'rivian', 'polestar',
  ],
};

/** canonical make -> origin */
export const MAKE_TO_ORIGIN = Object.freeze(
  Object.fromEntries(
    Object.entries(ORIGINS).flatMap(([origin, makes]) => makes.map((m) => [m, origin])),
  ),
);

const CANONICAL_MAKES = Object.keys(MAKE_TO_ORIGIN);

// Explicit beats clever. Sellers type "chevy", "VW", "benz", "Volkswagon".
// Add to this table whenever you spot a new one in the wild — it is always
// safer than loosening the fuzzy threshold.
export const ALIASES = Object.freeze({
  // American
  chevy: 'chevrolet', chev: 'chevrolet', chevorlet: 'chevrolet',
  chevrolette: 'chevrolet', chevey: 'chevrolet',
  'gmc truck': 'gmc',
  dodgeram: 'ram', 'dodge ram': 'ram',
  caddy: 'cadillac', cadilac: 'cadillac', cadillac: 'cadillac',
  lincon: 'lincoln',
  olds: 'oldsmobile',
  // Japanese
  toyta: 'toyota', toyoda: 'toyota', tyota: 'toyota',
  hona: 'honda', hnda: 'honda',
  nisan: 'nissan', nissian: 'nissan',
  mitsu: 'mitsubishi', mitsubishi_motors: 'mitsubishi',
  infinity: 'infiniti', infinit: 'infiniti',
  suburu: 'subaru', subara: 'subaru',
  lexis: 'lexus',
  // Korean
  hundai: 'hyundai', hyandai: 'hyundai', hyunda: 'hyundai',
  // German — these matter most. A German car misread as unknown or, worse,
  // fuzzy-matched to Mercury is exactly the failure we cannot have.
  vw: 'volkswagen', volkswagon: 'volkswagen', volkswagan: 'volkswagen',
  volks: 'volkswagen',
  benz: 'mercedes-benz', merc: 'mercedes-benz', mercedes: 'mercedes-benz',
  'mercedes benz': 'mercedes-benz', mercedesbenz: 'mercedes-benz',
  mecedes: 'mercedes-benz', mercades: 'mercedes-benz', mercedez: 'mercedes-benz',
  bmws: 'bmw', beemer: 'bmw', bimmer: 'bmw',
  audhi: 'audi',
  porshe: 'porsche', porche: 'porsche',
  'mini cooper': 'mini',
  // Other
  landrover: 'land rover', 'range rover': 'land rover',
  'alfa': 'alfa romeo',
  rollsroyce: 'rolls-royce', 'rolls royce': 'rolls-royce',
});

// Two-word canonical makes, needed when parsing a title token-by-token.
const MULTIWORD_MAKES = CANONICAL_MAKES.filter((m) => m.includes(' '))
  .concat(['mercedes benz', 'rolls royce', 'range rover', 'mini cooper']);

const NON_CAR_KEYWORDS = [
  'trailer', 'camper', 'rv ', 'motorhome', 'atv', 'utv', 'jet ski', 'jetski',
  'golf cart', 'motorcycle', 'scooter', 'dirt bike', 'dirtbike', 'moped',
  'boat', 'pontoon', 'tractor', 'forklift', 'go kart', 'gokart', 'lawn mower',
];

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeMakeString(input) {
  if (!input || typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/[._/\\]+/g, ' ')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

// Deliberately tight. A false `unknown` is cheap — it shows up in the rejected
// list and you add an alias. A false match is expensive: a Mercedes silently
// classified as a Mercury is precisely the car you don't want to buy. Strings
// under 4 chars are alias-or-nothing, because "ram" is one edit from half the
// alphabet.
const FUZZY_MIN_LENGTH = 4;
const FUZZY_MAX_DISTANCE = 2;
const FUZZY_MIN_SIMILARITY = 0.82;

function fuzzyMatch(normalized) {
  if (normalized.length < FUZZY_MIN_LENGTH) return null;
  let best = null;
  for (const candidate of CANONICAL_MAKES) {
    const distance = levenshtein(normalized, candidate);
    if (distance > FUZZY_MAX_DISTANCE) continue;
    const similarity = 1 - distance / Math.max(normalized.length, candidate.length);
    if (similarity < FUZZY_MIN_SIMILARITY) continue;
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  return best ? best.candidate : null;
}

/**
 * Resolve any make string to a canonical make.
 * @returns {{ make: string|null, origin: string, matchedBy: 'exact'|'alias'|'fuzzy'|'none' }}
 */
export function classifyMake(input) {
  const normalized = normalizeMakeString(input);
  if (!normalized) return { make: null, origin: 'unknown', matchedBy: 'none' };

  if (MAKE_TO_ORIGIN[normalized]) {
    return { make: normalized, origin: MAKE_TO_ORIGIN[normalized], matchedBy: 'exact' };
  }

  const aliased = ALIASES[normalized];
  if (aliased) {
    return { make: aliased, origin: MAKE_TO_ORIGIN[aliased] ?? 'unknown', matchedBy: 'alias' };
  }

  // "mercedes-benz" vs "mercedes benz" — try the dash/space variants before fuzzy.
  const dashed = normalized.replace(/\s+/g, '-');
  if (MAKE_TO_ORIGIN[dashed]) {
    return { make: dashed, origin: MAKE_TO_ORIGIN[dashed], matchedBy: 'alias' };
  }
  const spaced = normalized.replace(/-+/g, ' ');
  if (MAKE_TO_ORIGIN[spaced]) {
    return { make: spaced, origin: MAKE_TO_ORIGIN[spaced], matchedBy: 'alias' };
  }
  if (ALIASES[spaced]) {
    const target = ALIASES[spaced];
    return { make: target, origin: MAKE_TO_ORIGIN[target] ?? 'unknown', matchedBy: 'alias' };
  }

  const fuzzy = fuzzyMatch(normalized);
  if (fuzzy) {
    return { make: fuzzy, origin: MAKE_TO_ORIGIN[fuzzy], matchedBy: 'fuzzy' };
  }

  return { make: null, origin: 'unknown', matchedBy: 'none' };
}

const YEAR_MIN = 1960;
const yearMax = () => new Date().getFullYear() + 1;

/**
 * Pull year / make / model out of a listing title. The near-universal
 * Marketplace pattern is "<year> <make> <model...>", e.g.
 * "2008 Chevy Silverado 1500 - runs great".
 * @returns {{ year: number|null, make: string|null, origin: string, model: string|null }}
 */
export function parseTitle(title) {
  const empty = { year: null, make: null, origin: 'unknown', model: null };
  if (!title || typeof title !== 'string') return empty;

  const cleaned = title.replace(/\s+/g, ' ').trim();
  const yearMatch = cleaned.match(/\b(19[6-9]\d|20\d{2})\b/);
  let year = null;
  let rest = cleaned;

  if (yearMatch) {
    const candidate = Number(yearMatch[1]);
    if (candidate >= YEAR_MIN && candidate <= yearMax()) {
      year = candidate;
      rest = cleaned.slice(yearMatch.index + yearMatch[1].length).trim();
    }
  }

  // Cut at the first separator so the seller's blurb doesn't end up as the
  // model: "Chevy Silverado 1500 - runs great" must not yield "Silverado 1500
  // runs great". A spaced dash only, so "F-150" survives intact.
  //
  // The middot matters more than it looks: Facebook writes vehicle titles as
  // "2007 Chevrolet Tahoe · Z71 Sport Utility 4D", and leaving it in put a
  // dangling "·" into the offer message actually sent to a seller.
  rest = rest.split(/\s*[·•]\s*|\s+[-–—|]\s+|[,;(]/)[0].trim();

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ...empty, year };

  // Two-word makes first ("Land Rover", "Mercedes Benz"), else one token.
  if (tokens.length >= 2) {
    const pair = normalizeMakeString(`${tokens[0]} ${tokens[1]}`);
    if (MULTIWORD_MAKES.includes(pair) || ALIASES[pair]) {
      const { make, origin } = classifyMake(pair);
      if (make) {
        return { year, make, origin, model: tokens.slice(2, 4).join(' ') || null };
      }
    }
  }

  const { make, origin } = classifyMake(tokens[0]);
  // Two tokens of model is enough for "Silverado 1500" / "Grand Caravan" and
  // stops trim levels and adjectives from piling up.
  return { year, make, origin, model: make ? tokens.slice(1, 3).join(' ') || null : null };
}

/** Boats, trailers, ATVs — things the car_truck URL filter occasionally lets through. */
export function looksLikeNonCar(text) {
  if (!text) return false;
  const haystack = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;
  return NON_CAR_KEYWORDS.some((keyword) => haystack.includes(keyword));
}
