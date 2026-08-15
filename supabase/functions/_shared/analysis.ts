// GENERATED — do not edit. Copied from packages/core/src/ by tools/sync-edge-function.ts.
// Edit the original and run `pnpm sync:function`.

/** The vision pass over a listing's photos.
 *
 *  Deliberately runtime-agnostic — it uses nothing but `fetch`, so the same module runs under
 *  Node today and a Supabase Edge Function later without changes. Keep it that way: no node:
 *  imports, no process.env reads. Configuration arrives as arguments.
 */

import { flattenOntoWhite, looksTransparent } from './png.ts';

const MODEL = 'gpt-5.6-terra';
const ENDPOINT = 'https://api.openai.com/v1/responses';

/** Cost and latency both scale with image count, and galleries have a long tail of near
 *  duplicates. Beyond this the marginal photo tells us nothing new. */
export const MAX_IMAGES = 40;

/** The other half of the bill, which had no ceiling at all. See the note at the request body. */
export const MAX_OUTPUT_TOKENS = 4000;

const SYSTEM = `You analyse UK property listing photographs for someone deciding whether to view a flat.

You will receive every image from one listing, in order, each preceded by its index.

Rules:
- A floorplan is a scale drawing of the layout, not a photo. Listings often include one among the
  photos even when it is not labelled as a floorplan. Find it if it exists.
- Say separately whether a floorplan is PRESENT and whether it is LEGIBLE. A plan that is blank,
  blacked out, too low-resolution or otherwise unreadable is present but not legible, and that is
  a useful answer — it tells the reader the listing has not been assessed rather than that it
  failed the assessment.
- When the floorplan is not legible, anything it would have settled — room count, room sizes,
  whether there is a bath — must not be reported as "high" confidence on the strength of the
  photos alone. Photos routinely omit a second bathroom entirely.
- Read total floor area off the floorplan. Prefer a figure printed on the plan ("stated"). If none
  is printed but room dimensions are, sum them and say "computed". Otherwise "none".
- Count bedrooms and bathrooms from the floorplan where you can, otherwise from the photos.
- The biggest room is the single largest habitable room. Give its area in square feet.
- A bathtub means a full bath you can lie in. A shower cubicle alone is not a bathtub.
- Outdoor space means private space for this property: garden, terrace, balcony, roof terrace,
  patio, yard. A shared communal garden counts only if it is clearly private to the flat. A window
  box or Juliet balcony does not count.
- Estimate outdoor area only when there is something to reason from (the floorplan, or a photo
  with a clear sense of scale). Say plainly whether the number is measured or estimated.
- Give every measurement in square feet, as a positive integer. Zero is not an area.
- Never pair a measurement with a claim that contradicts it: an illegible floorplan has no total
  area, and a property with no outdoor space has no outdoor area.
- A HOUSE SHARE is a room in a shared house or flat rather than the whole property. The
  description is where this is stated: "room in a", "housemates", "shared kitchen", "all bills
  included, room". Bedroom counts do not settle it — a four-bedroom house let whole and a room in
  a four-bedroom house look identical in the numbers.
- LAUNDRY: say where the washing machine is, not merely whether one exists. "in-unit" means inside
  the property (a machine in the kitchen, a utility cupboard, a plumbed space on the floorplan).
  "in-building" means a communal laundry room or a basement machine shared with other flats.
  "none" means there is nowhere to wash clothes. Null when you cannot tell, which is common and
  is a better answer than a guess.
- DISHWASHER: an integrated or freestanding dishwasher visible in a kitchen photo, drawn on the
  floorplan, or named in the description.
- SLEEPING AREA: how separate the place to sleep is from the kitchen, in three answers.
  "separate-room" — the bed is in a room of its own, behind a door.
  "practically-separate" — one room on the plan, but you would not lie in bed looking at the hob:
  the sleeping area is on its own level (a mezzanine, loft or gallery — its own labelled area on
  the floorplan, or a platform reached by a ladder or stair in a photograph); or the room's outline
  turns a corner and the kitchen is round it; or something full-height and fixed stands between the
  two — a wall return, a partition, a floor-to-ceiling run of wardrobes.
  "same-space" — one open room where the kitchen and the place to sleep are in a single view.
  Judge the sleeping AREA, not the bed: an unfurnished studio has no bed in any photograph and its
  floorplan still answers this. A long room is not a divided one — a corner in the outline divides
  a room, a shallow recess or a chimney breast does not. A photograph holding both a bed and the
  kitchen is good evidence of "same-space"; no such photograph is weak evidence of the opposite,
  since it may only mean nobody stood there. Null when neither a plan nor a photo settles it.
- UTILITIES INCLUDED means the rent covers bills (gas, electricity, water, sometimes council tax
  or broadband). Only the description says this. False and null are treated the same downstream,
  so do not strain to prove a negative.
- NATURAL LIGHT: rate how much daylight the place gets as low, medium or high. Judge it from the
  photographs — how many windows there are, which way the rooms face where the floorplan says,
  how bright the rooms look without a lamp on, whether anything outside blocks the view. Estate
  agent photographs are shot to flatter, so a room that looks bright in one wide-angle frame with
  the lights on is not high. Low means a flat that will need lamps on in the daytime.
- Report confidence honestly. "low" is a useful answer; a confident wrong number is not.
- If something cannot be determined, return null rather than guessing.`;

/** The schema pins the *shape*, not the plausibility. OpenAI's strict structured-output mode
 *  rejects the numeric keywords that would have expressed the rest (`minimum`, `maximum`,
 *  `multipleOf`) and has no way at all to say "this integer must be absent when that boolean is
 *  false", so every constraint of that sort is enforced after parsing, in `validateAnalysis`. */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'images',
    'floorplan',
    'bedrooms',
    'bathrooms',
    'biggest_room',
    'bathtub',
    'outdoor',
    'amenities',
    'light',
    'summary',
  ],
  properties: {
    images: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'is_floorplan', 'room', 'caption'],
        properties: {
          index: { type: 'integer' },
          is_floorplan: { type: 'boolean' },
          room: { type: ['string', 'null'], description: 'e.g. kitchen, main bedroom, garden' },
          caption: { type: 'string', description: 'One sentence: what is actually in this image.' },
        },
      },
    },
    floorplan: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'legible', 'total_sqft', 'source', 'confidence'],
      properties: {
        present: { type: 'boolean' },
        legible: {
          type: 'boolean',
          description: 'False when a plan is there but cannot be read (blank, blacked out, too small).',
        },
        total_sqft: { type: ['integer', 'null'] },
        source: { type: 'string', enum: ['stated', 'computed', 'none'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    bedrooms: { type: ['integer', 'null'] },
    bathrooms: { type: ['integer', 'null'] },
    biggest_room: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'sqft', 'confidence'],
      properties: {
        label: { type: ['string', 'null'] },
        sqft: { type: ['integer', 'null'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    bathtub: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'confidence'],
      properties: {
        present: { type: ['boolean', 'null'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    outdoor: {
      type: 'object',
      additionalProperties: false,
      required: ['present', 'kind', 'sqft', 'is_estimate', 'confidence'],
      properties: {
        present: { type: ['boolean', 'null'] },
        kind: { type: ['string', 'null'], description: 'garden, terrace, balcony, patio, roof terrace' },
        sqft: { type: ['integer', 'null'] },
        is_estimate: { type: 'boolean', description: 'false only if the number is measured, not guessed' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    amenities: {
      type: 'object',
      additionalProperties: false,
      required: ['house_share', 'laundry', 'dishwasher', 'sleeping_area', 'utilities_included'],
      properties: {
        house_share: {
          type: 'object',
          additionalProperties: false,
          required: ['present', 'confidence'],
          properties: {
            present: { type: ['boolean', 'null'], description: 'true when this is a room in a share' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
        laundry: {
          type: 'object',
          additionalProperties: false,
          required: ['where', 'confidence'],
          properties: {
            where: { type: ['string', 'null'], enum: ['in-unit', 'in-building', 'none', null] },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
        dishwasher: {
          type: 'object',
          additionalProperties: false,
          required: ['present', 'confidence'],
          properties: {
            present: { type: ['boolean', 'null'] },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
        sleeping_area: {
          type: 'object',
          additionalProperties: false,
          required: ['separation', 'confidence'],
          properties: {
            separation: {
              type: ['string', 'null'],
              enum: ['separate-room', 'practically-separate', 'same-space', null],
            },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
        utilities_included: {
          type: 'object',
          additionalProperties: false,
          required: ['present', 'confidence'],
          properties: {
            present: { type: ['boolean', 'null'] },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
    },
    light: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'confidence'],
      properties: {
        level: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    summary: { type: 'string', description: 'Two or three sentences on what this place is like.' },
  },
} as const;

/** What the call actually cost, in tokens.
 *
 *  `input_tokens_details.cached_tokens` is part of it because cached input is an order of magnitude
 *  cheaper than fresh input, and pricing it at the full rate overstates the spend a monthly cap is
 *  counting. The Responses API has always returned it; it was simply not in this type, so the
 *  function had to re-declare the shape to read it. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

export interface AnalysisResult {
  model: string;
  imageCount: number;
  parsed: ParsedAnalysis;
  usage?: Usage;
}

/** An analysis that failed *after* OpenAI produced tokens, carrying what those tokens cost.
 *
 *  A failed call is not a free call. The model can burn a dollar of input and then return output
 *  that will not parse, and until this existed that dollar was spent against a cap that never saw
 *  it — the one kind of overspend a cap cannot notice, because nothing recorded it. The Edge
 *  Function reads `model` and `usage` off whatever it catches and records the charge before it
 *  releases the claim, so anything thrown from here after the response body is read says what it
 *  cost. */
export function chargedError(message: string, model: string, usage?: Usage): Error {
  return Object.assign(new Error(message), { model, usage });
}

export interface ParsedAnalysis {
  images: Array<{ index: number; is_floorplan: boolean; room: string | null; caption: string }>;
  floorplan: { present: boolean; legible: boolean; total_sqft: number | null; source: string; confidence: string };
  bedrooms: number | null;
  bathrooms: number | null;
  biggest_room: { label: string | null; sqft: number | null; confidence: string };
  bathtub: { present: boolean | null; confidence: string };
  light: { level: string | null; confidence: string };
  amenities: {
    house_share: { present: boolean | null; confidence: string };
    laundry: { where: string | null; confidence: string };
    dishwasher: { present: boolean | null; confidence: string };
    sleeping_area: { separation: string | null; confidence: string };
    utilities_included: { present: boolean | null; confidence: string };
  };
  outdoor: {
    present: boolean | null;
    kind: string | null;
    sqft: number | null;
    is_estimate: boolean;
    confidence: string;
  };
  summary: string;
}

export interface AnalyseOptions {
  apiKey: string;
  /** Gallery URLs first, floorplans last — see the ordering note below. */
  imageUrls: string[];
  floorplanUrls: string[];
  /** The agent's prose. Photographs cannot answer whether bills are included or whether this is a
   *  room in a share, and those were being asked of a model that had never seen the sentence
   *  stating them. */
  description?: string | null;
  /** Injected so tests can supply bytes without network. */
  fetchImpl?: typeof fetch;
}

export async function analyseListing({
  apiKey,
  imageUrls,
  floorplanUrls,
  description = null,
  fetchImpl = fetch,
}: AnalyseOptions): Promise<AnalysisResult> {
  // Floorplans go first and are never dropped by the cap: they carry the measurements, which are
  // the hardest part to get anywhere else.
  const ordered = [
    ...floorplanUrls.map((url) => ({ url, isFloorplan: true })),
    ...imageUrls.filter((url) => !floorplanUrls.includes(url)).map((url) => ({ url, isFloorplan: false })),
  ].slice(0, MAX_IMAGES);

  if (ordered.length === 0) throw new Error('no images to analyse');

  const fetched = await Promise.all(ordered.map((image) => toDataUrl(image.url, fetchImpl)));
  const usable = ordered.map((image, i) => ({ ...image, dataUrl: fetched[i]! })).filter((i) => i.dataUrl);
  if (usable.length === 0) throw new Error('every image failed to download');

  const content: unknown[] = [];
  // Before the images, so the model reads the claim and then looks for it, rather than forming an
  // impression from photographs and then being asked about bills.
  if (description && description.trim().length > 0) {
    content.push({
      type: 'input_text',
      text: `The agent's own description of this property:\n\n${description.trim()}`,
    });
  }
  usable.forEach((image, index) => {
    content.push({ type: 'input_text', text: `Image ${index}${image.isFloorplan ? ' (floorplan)' : ''}:` });
    content.push({
      type: 'input_image',
      image_url: image.dataUrl,
      // Floorplan dimensions are small printed text — this is OCR, and downscaling loses it.
      detail: image.isFloorplan ? 'original' : 'auto',
    });
  });

  const payload = JSON.stringify({
    model: MODEL,
    instructions: SYSTEM,
    input: [{ role: 'user', content }],
    // A ceiling on the half of the bill that has no natural one. Input is bounded by MAX_IMAGES;
    // output was bounded by nothing but the model deciding to stop, and output tokens are the
    // dearer side. The spend cap reserves a flat estimate per call and reconciles afterwards, so
    // an unbounded call is the one shape that can carry a project past $20 in a single request —
    // the locks stop concurrent overshoot and can do nothing about one expensive call.
    //
    // The schema is strict and the answer is a few dozen short fields, so this is roughly an order
    // of magnitude of headroom rather than a squeeze. A truncated response fails
    // `validateAnalysis` loudly as malformed JSON, which is the right outcome: half an analysis
    // rendered as settled fact is worse than none.
    max_output_tokens: MAX_OUTPUT_TOKENS,
    text: {
      format: { type: 'json_schema', name: 'listing_analysis', strict: true, schema: SCHEMA },
    },
  });

  // Rate limits and gateway errors are routine on a request this size; a bad key or a malformed
  // schema is not, and retrying those just burns time.
  let response!: Response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
    });
    if (response.ok) break;
    if (response.status !== 429 && response.status < 500) break;
    if (attempt < 2) await sleep(2000 * 2 ** attempt);
  }

  if (!response.ok) {
    throw new Error(`OpenAI returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }

  const body = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    usage?: Usage;
  };

  // Everything from here on has the usage block in hand, so every failure below is a charged one
  // and says so. Above this line OpenAI produced nothing and there is nothing to charge for.
  const text = body.output_text ?? body.output?.flatMap((o) => o.content ?? []).find((c) => c.text)?.text;
  if (!text) throw chargedError('OpenAI returned no output text', MODEL, body.usage);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw chargedError(`OpenAI returned output that is not JSON: ${text.slice(0, 200)}`, MODEL, body.usage);
  }

  let parsed: ParsedAnalysis;
  try {
    parsed = validateAnalysis(raw);
  } catch (e) {
    // A broken *shape* still throws — half a row is worse than none — but it throws with the bill
    // attached now. Rethrown rather than wrapped so the original message survives intact.
    throw chargedError(e instanceof Error ? e.message : String(e), MODEL, body.usage);
  }

  return {
    model: MODEL,
    imageCount: usable.length,
    parsed,
    usage: body.usage,
  };
}

/** No London flat has this much floor in it. The point of a ceiling is not to be a correct upper
 *  bound but to catch the failure mode where a model reads "10500" off a plan that says "1050" —
 *  a number wrong by an order of magnitude is the one a reader is least able to spot, because it
 *  arrives with the same confidence as the right one. */
const MAX_SQFT = 30_000;
/** Gardens can dwarf the house, so outdoor space gets its own, looser ceiling. */
const MAX_OUTDOOR_SQFT = 200_000;
/** Bedrooms and bathrooms. A listing with more than this is not a flat we are looking at. */
const MAX_ROOMS = 30;

const SOURCES = ['stated', 'computed', 'none'];
const CONFIDENCES = ['high', 'medium', 'low'];

/** Check the model's answer before anything downstream reads it as fact.
 *
 *  Two different failures need two different responses. A *shape* that is wrong — no `floorplan`
 *  object at all — means the contract broke, and the honest move is to throw so the caller writes
 *  no row and can retry; a half-built row is worse than none, and the extension's standing rule is
 *  to fail loudly rather than render blanks. A *value* that cannot be true — a negative area, a
 *  measurement off a plan the model just said was illegible — is dropped to null and logged. That
 *  asymmetry is the whole design: the panel and the shortlist render an area as a settled fact
 *  with no hedging available to them, so a number that cannot be true is strictly worse than an
 *  absent one. Absent, the UI says "unknown", which is exactly what we know.
 *
 *  Exported because `tools/check-analysis.ts` pins these rules, and because they are worth
 *  applying to any stored analysis, not only a fresh one. */
export function validateAnalysis(raw: unknown): ParsedAnalysis {
  if (!isRecord(raw)) throw new Error('OpenAI returned output that is not a JSON object');

  const floorplanIn = section(raw, 'floorplan');
  const biggestIn = section(raw, 'biggest_room');
  const bathtubIn = section(raw, 'bathtub');
  const outdoorIn = section(raw, 'outdoor');
  const amenitiesIn = section(raw, 'amenities');
  const lightIn = section(raw, 'light');

  const present = flag(floorplanIn.present, 'floorplan.present');
  // A plan that is not there cannot have been legible. The pair is read as one sentence in the
  // UI ("floorplan unreadable"), so letting them disagree puts a sentence on screen that no image
  // supports.
  let legible = flag(floorplanIn.legible, 'floorplan.legible');
  if (!present && legible) {
    warn('floorplan.legible was true with no floorplan present — taking it as illegible');
    legible = false;
  }

  let floorplanSqft = measurement(floorplanIn.total_sqft, 'floorplan.total_sqft', 1, MAX_SQFT);
  let source = choice(floorplanIn.source, SOURCES, 'none', 'floorplan.source');

  if (floorplanSqft !== null && !legible) {
    // Whichever half of this is the mistake, the number is the half that gets shown as a fact.
    warn(`dropping floorplan.total_sqft ${floorplanSqft}: the plan was reported illegible`);
    floorplanSqft = null;
  }
  if (floorplanSqft !== null && source === 'none') {
    warn(`dropping floorplan.total_sqft ${floorplanSqft}: source "none" means no figure was read`);
    floorplanSqft = null;
  }
  // The inverse is not a lie a reader can see, but "stated" with nothing stated makes the
  // provenance column meaningless, and provenance is why that column exists.
  if (floorplanSqft === null) source = 'none';

  let biggestSqft = measurement(biggestIn.sqft, 'biggest_room.sqft', 1, MAX_SQFT);
  if (biggestSqft !== null && floorplanSqft !== null && biggestSqft > floorplanSqft) {
    warn(`dropping biggest_room.sqft ${biggestSqft}: larger than the whole floor area (${floorplanSqft})`);
    biggestSqft = null;
  }

  const outdoorPresent = maybeFlag(outdoorIn.present, 'outdoor.present');
  let outdoorSqft = measurement(outdoorIn.sqft, 'outdoor.sqft', 1, MAX_OUTDOOR_SQFT);
  let outdoorKind = text(outdoorIn.kind);
  if (outdoorPresent === false) {
    // "No outdoor space, 200 sq ft of it" is the shape of contradiction that reads as precision.
    if (outdoorSqft !== null) {
      warn(`dropping outdoor.sqft ${outdoorSqft}: the listing was reported to have no outdoor space`);
      outdoorSqft = null;
    }
    if (outdoorKind !== null) {
      warn(`dropping outdoor.kind "${outdoorKind}": the listing was reported to have no outdoor space`);
      outdoorKind = null;
    }
  }

  return {
    images: images(raw.images),
    floorplan: {
      present,
      legible,
      total_sqft: floorplanSqft,
      source,
      confidence: choice(floorplanIn.confidence, CONFIDENCES, 'low', 'floorplan.confidence'),
    },
    bedrooms: measurement(raw.bedrooms, 'bedrooms', 0, MAX_ROOMS),
    bathrooms: measurement(raw.bathrooms, 'bathrooms', 0, MAX_ROOMS),
    biggest_room: {
      label: text(biggestIn.label),
      sqft: biggestSqft,
      confidence: choice(biggestIn.confidence, CONFIDENCES, 'low', 'biggest_room.confidence'),
    },
    bathtub: {
      present: maybeFlag(bathtubIn.present, 'bathtub.present'),
      confidence: choice(bathtubIn.confidence, CONFIDENCES, 'low', 'bathtub.confidence'),
    },
    outdoor: {
      present: outdoorPresent,
      kind: outdoorKind,
      sqft: outdoorSqft,
      is_estimate: flag(outdoorIn.is_estimate, 'outdoor.is_estimate', true),
      confidence: choice(outdoorIn.confidence, CONFIDENCES, 'low', 'outdoor.confidence'),
    },
    amenities: amenities(amenitiesIn),
    light: {
      // An unrecognised level becomes null rather than "medium": inventing a middle rating is a
      // claim about the flat, and "we could not tell" is the honest one.
      level: oneOfOrNull(lightIn.level, LIGHT_LEVELS, 'light.level'),
      confidence: choice(lightIn.confidence, CONFIDENCES, 'low', 'light.confidence'),
    },
    summary: typeof raw.summary === 'string' ? raw.summary : '',
  };
}

const LAUNDRY = ['in-unit', 'in-building', 'none'];
const LIGHT_LEVELS = ['low', 'medium', 'high'];
const SEPARATIONS = ['separate-room', 'practically-separate', 'same-space'];

/** Like `choice`, except an unrecognised value becomes null rather than a default. Use this
 *  wherever the default would itself be a claim about the property. */
function oneOfOrNull(value: unknown, allowed: string[], label: string): string | null {
  if (typeof value === 'string' && allowed.includes(value)) return value;
  if (value !== null && value !== undefined) {
    warn(`${label} was ${JSON.stringify(value)}, not one of ${allowed.join('/')} — reading it as unknown`);
  }
  return null;
}

/** The five amenities. Three are a yes/no/unknown with a confidence and share a reader — three
 *  near-identical blocks inline is three chances to paste the wrong key in and report the
 *  dishwasher's confidence against the house share. Laundry and the sleeping area are graded
 *  rather than present, and are read out longhand below. */
function amenities(raw: Record<string, unknown>): ParsedAnalysis['amenities'] {
  const laundryIn = section(raw, 'laundry');
  const sleepingIn = section(raw, 'sleeping_area');
  // `where` is the one field here that is not a boolean, and an unrecognised string has to become
  // null rather than a default: "in-building" invented out of nothing is a claim about the
  // building, and "none" invented out of nothing says the flat cannot wash clothes.
  const laundry = oneOfOrNull(laundryIn.where, LAUNDRY, 'amenities.laundry.where');

  return {
    house_share: yesNo(raw, 'house_share'),
    laundry: {
      where: laundry,
      confidence: choice(laundryIn.confidence, CONFIDENCES, 'low', 'amenities.laundry.confidence'),
    },
    dishwasher: yesNo(raw, 'dishwasher'),
    sleeping_area: {
      separation: oneOfOrNull(sleepingIn.separation, SEPARATIONS, 'amenities.sleeping_area.separation'),
      confidence: choice(sleepingIn.confidence, CONFIDENCES, 'low', 'amenities.sleeping_area.confidence'),
    },
    utilities_included: yesNo(raw, 'utilities_included'),
  };
}

function yesNo(parent: Record<string, unknown>, key: string): { present: boolean | null; confidence: string } {
  const found = section(parent, key);
  return {
    present: maybeFlag(found.present, `amenities.${key}.present`),
    confidence: choice(found.confidence, CONFIDENCES, 'low', `amenities.${key}.confidence`),
  };
}

/** `console` is the only logging surface both a bundled MV3 service worker and a Deno Edge
 *  Function have without a dependency, and this module takes none by design (it is copied verbatim
 *  into `supabase/functions/_shared/` by `pnpm sync:function`). The prefix is what makes these
 *  findable in the function logs, where they sit among Supabase's own output. */
function warn(message: string): void {
  console.warn(`[analysis] ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A required nested object. Its absence is a broken contract rather than a bad reading, so this
 *  throws — see the asymmetry described on `validateAnalysis`. */
function section(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (!isRecord(value)) throw new Error(`OpenAI returned no "${key}" object`);
  return value;
}

/** A count or an area the model claims to have read. Anything that cannot be an answer to the
 *  question asked — a fraction of a bedroom, a negative area, an area larger than any building we
 *  would be looking at — comes back null rather than being passed on. */
function measurement(value: unknown, label: string, min: number, max: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    warn(`dropping ${label}: ${JSON.stringify(value)} is not a value this can have`);
    return null;
  }
  return value;
}

function flag(value: unknown, label: string, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  warn(`${label} was ${JSON.stringify(value)}, not a boolean — reading it as ${fallback}`);
  return fallback;
}

/** The same, for the fields where "I could not tell" is a legitimate answer and must survive as
 *  null rather than collapsing into false. */
function maybeFlag(value: unknown, label: string): boolean | null {
  if (typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return null;
  warn(`${label} was ${JSON.stringify(value)}, not a boolean — reading it as unknown`);
  return null;
}

function choice(value: unknown, allowed: string[], fallback: string, label: string): string {
  if (typeof value === 'string' && allowed.includes(value)) return value;
  warn(`${label} was ${JSON.stringify(value)}, not one of ${allowed.join('/')} — reading it as ${fallback}`);
  return fallback;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Captions are the one field where a bad entry costs nothing but itself, so malformed ones are
 *  dropped individually instead of failing the whole analysis. */
function images(value: unknown): ParsedAnalysis['images'] {
  if (!Array.isArray(value)) {
    warn('images was not an array — recording no captions');
    return [];
  }
  const kept = value.filter(isRecord).filter((image) => Number.isInteger(image.index));
  if (kept.length !== value.length) warn(`dropped ${value.length - kept.length} malformed image entries`);
  return kept.map((image) => ({
    index: image.index as number,
    is_floorplan: image.is_floorplan === true,
    room: text(image.room),
    caption: typeof image.caption === 'string' ? image.caption : '',
  }));
}

/** Fetch an image and inline it as a data URL. We pass bytes rather than handing OpenAI a
 *  Rightmove CDN link to fetch, and we never persist the image itself.
 *
 *  Retried: a dropped image is a permanently worse analysis for that listing, and the whole
 *  listing is only ever analysed once, so there is no later pass to catch it. */
async function toDataUrl(url: string, fetchImpl: typeof fetch, attempts = 3): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url);
      // A 4xx other than 429 won't change on a retry; anything else might.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return '';
      if (response.ok) {
        const type = response.headers.get('content-type') ?? 'image/jpeg';
        if (!type.startsWith('image/')) return '';

        let bytes: Uint8Array = new Uint8Array(await response.arrayBuffer());
        // Rightmove's floorplans are transparent PNGs of dark line work. Sent as-is they get
        // composited onto black and the model sees a black rectangle — one verified plan came
        // back "almost entirely obscured/blackened", which silently produced "no bathtub" with
        // high confidence for a flat that has one. Flattening is deterministic, local and costs
        // nothing next to a second API round trip, so it happens on the way in rather than as a
        // retry after the model has already failed.
        if (looksTransparent(bytes)) {
          const flat = await flattenOntoWhite(bytes);
          bytes = flat.png;
          // The flattener hands back the original bytes for anything it cannot decode, and says so.
          // Worth a line: it means this image reached the model with alpha intact, and the last
          // time that happened it produced "no bathtub" with high confidence for a flat with one.
          if (!flat.opaque) warn(`sending ${url} still transparent: ${flat.reason}`);
        }

        return `data:${type};base64,${base64(bytes)}`;
      }
    } catch {
      // Network blip — fall through to the retry.
    }
    if (attempt < attempts - 1) await sleep(400 * 2 ** attempt);
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked: spreading a megabyte of bytes into one call blows the argument limit.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
