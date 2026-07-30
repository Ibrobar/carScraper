// Which language is a listing written in?
//
// Roughly a third of DFW Marketplace listings are Spanish. Two things depend on
// knowing that: the dashboard labels them and can show a translation, and it
// tells you at a glance whether the Spanish defect rules in lib/defects.js were
// the ones doing the work.
//
// Stopword-frequency, not a real classifier. It only has to separate English
// from Spanish on a few sentences of car-sale prose, and it must never need a
// network call.

const SPANISH_STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'que',
  'con', 'por', 'para', 'muy', 'pero', 'todo', 'toda', 'esta', 'este', 'esto',
  'tiene', 'tengo', 'vendo', 'venta', 'carro', 'coche', 'troca', 'camioneta',
  'motor', 'nuevo', 'nueva', 'buenas', 'buen', 'condiciones', 'millas',
  'titulo', 'limpio', 'corre', 'camina', 'funciona', 'necesita', 'papeles',
  'barato', 'precio', 'dueno', 'anos', 'esta', 'como', 'mas', 'bien', 'sin',
  'aire', 'frio', 'llantas', 'cambio', 'trato', 'informacion', 'llamar',
  'mensaje', 'gracias', 'listo', 'placas', 'seguro', 'primera', 'segunda',
]);

const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'have', 'has', 'runs', 'drives',
  'good', 'great', 'clean', 'title', 'miles', 'new', 'car', 'truck', 'selling',
  'sale', 'price', 'condition', 'needs', 'work', 'engine', 'transmission',
  'cold', 'everything', 'works', 'owner', 'call', 'text', 'please', 'thanks',
  'looking', 'asking', 'obo', 'cash', 'only', 'available',
]);

/** Strip accents and punctuation, split into lowercase words. */
function words(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * @returns {'es'|'en'|null} null when there isn't enough text to be sure —
 *          guessing on a five-word listing would just mislabel it.
 */
export function detectLanguage(text) {
  if (!text) return null;
  const tokens = words(text);
  if (tokens.length < 8) return null;

  let es = 0;
  let en = 0;
  for (const token of tokens) {
    if (SPANISH_STOPWORDS.has(token)) es++;
    if (ENGLISH_STOPWORDS.has(token)) en++;
  }

  // Accented characters and inverted punctuation are strong Spanish tells that
  // survive even when the vocabulary is mostly proper nouns.
  if (/[ñáéíóúü¿¡]/i.test(text)) es += 2;

  const total = es + en;
  if (total < 2) return null;
  if (es > en) return 'es';
  if (en > es) return 'en';
  return null;
}

/** Human label for a language code. */
export function languageName(code) {
  return { es: 'Spanish', en: 'English' }[code] ?? null;
}
