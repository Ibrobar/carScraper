// Optional second-pass review of a listing description (docs/FILTERS.md, Stage 2).
//
// Off unless ANTHROPIC_API_KEY is set. Keyword rules will always miss creative
// phrasing ("she'll go in reverse if you're patient"); this catches some of it.
//
// The verdict AND the quoted evidence are stored on the listing, because an AI
// rejection you can't audit is worse than no AI at all.

import { config } from './config.js';

const SYSTEM = `You assess used-car listings for a car flipper. Given a listing title and
description, judge ONLY the condition of the engine/motor and transmission.

- "bad": the seller indicates the engine or transmission is broken, failing, needs
  replacement, or the car does not run or drive.
- "questionable": there is a hint of drivetrain trouble but it is ambiguous or minor.
- "good": no indication of engine or transmission trouble, or the seller says a
  problem was already repaired or replaced.

Cosmetic damage, body damage, tires, AC, electrical, and title status are NOT
drivetrain problems -- judge those as "good". A statement that a part was replaced
or rebuilt is positive, not negative. Quote the exact phrase you based the verdict
on in "evidence"; use an empty string if nothing stood out.`;

const SCHEMA = {
  type: 'object',
  properties: {
    drivetrain_condition: { type: 'string', enum: ['good', 'questionable', 'bad'] },
    evidence: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['drivetrain_condition', 'evidence', 'confidence'],
  additionalProperties: false,
};

// Model families differ in what request params they accept. Opus 5 / Fable 5 /
// Sonnet 5 take adaptive thinking + effort; Haiku 4.5 rejects `effort` outright.
function capabilities(model) {
  if (/^claude-(opus-5|fable-5|mythos-5)/.test(model)) {
    return { effort: true, adaptiveThinking: true, fallbacks: true };
  }
  if (/^claude-(sonnet-5|opus-4-[78]|sonnet-4-6|opus-4-6)/.test(model)) {
    return { effort: true, adaptiveThinking: true, fallbacks: false };
  }
  return { effort: false, adaptiveThinking: false, fallbacks: false };
}

let clientPromise = null;

async function getClient() {
  if (!config.aiKey) return null;
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then((mod) => new mod.default({ apiKey: config.aiKey }))
      .catch(() => null);
  }
  return clientPromise;
}

export function aiEnabled() {
  return Boolean(config.aiKey);
}

/**
 * @returns {Promise<{verdict:string, evidence:string, confidence:number}|null>}
 *          null when the stage is off, the SDK is missing, the model declined,
 *          or the call failed. A failure here must never fail a scrape.
 */
export async function reviewDescription(listing) {
  const client = await getClient();
  if (!client) return null;

  const model = config.aiModel;
  const caps = capabilities(model);

  const params = {
    model,
    max_tokens: 512,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Title: ${listing.title || '(none)'}\n\nDescription:\n${listing.description || '(none)'}`,
      },
    ],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  };
  if (caps.adaptiveThinking) params.thinking = { type: 'adaptive' };
  // Short classification — no need to spend reasoning budget on it.
  if (caps.effort) params.output_config.effort = 'low';

  try {
    let response;
    if (caps.fallbacks) {
      // Safety classifiers can decline a request outright; the fallback re-serves
      // it on another model inside the same call instead of losing the listing.
      response = await client.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } else {
      response = await client.messages.create(params);
    }

    if (response.stop_reason === 'refusal') return null;

    const text = response.content.find((block) => block.type === 'text')?.text;
    if (!text) return null;

    const parsed = JSON.parse(text);
    return {
      verdict: parsed.drivetrain_condition,
      evidence: parsed.evidence ?? '',
      confidence: Number(parsed.confidence) || 0,
    };
  } catch (err) {
    // Never let the optional stage break a scrape.
    console.warn(`  ai review failed for ${listing.fb_id}: ${err.message}`);
    return null;
  }
}

const TRANSLATE_SYSTEM = `Translate the used-car listing description to English.

Rules:
- Translate only. Do not summarize, add commentary, or clean up the seller's claims.
- Keep the meaning exact, especially anything about the engine, motor, or
  transmission -- those decide whether the car is worth looking at.
- Keep prices, phone numbers, mileage, years, and model names as written.
- Keep the rough line structure.
- If the text is already English, return it unchanged.

Return only the translation, with no preamble.`;

/**
 * Translate a listing description to English for display.
 *
 * Display only — defect detection reads the ORIGINAL text via the Spanish rules
 * in lib/defects.js. Filtering must not depend on an optional API being
 * configured, or turning the key off would silently stop catching
 * "necesita transmision".
 *
 * @returns {Promise<string|null>} null when the stage is off or the call failed.
 */
export async function translateDescription(text) {
  const client = await getClient();
  if (!client || !text || text.trim().length < 12) return null;

  const model = config.aiModel;
  const caps = capabilities(model);

  const params = {
    model,
    max_tokens: 2048,
    system: TRANSLATE_SYSTEM,
    messages: [{ role: 'user', content: text.slice(0, 6000) }],
  };
  if (caps.adaptiveThinking) params.thinking = { type: 'adaptive' };
  if (caps.effort) params.output_config = { effort: 'low' };

  try {
    const response = caps.fallbacks
      ? await client.beta.messages.create({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
      : await client.messages.create(params);

    if (response.stop_reason === 'refusal') return null;
    return response.content.find((block) => block.type === 'text')?.text?.trim() ?? null;
  } catch (err) {
    console.warn(`  translation failed: ${err.message}`);
    return null;
  }
}
