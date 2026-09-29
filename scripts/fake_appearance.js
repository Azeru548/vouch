// Appearance descriptors for the known-fake library.
//
// Asking the vision model to describe a pack is a *separate* question from
// reading its registration number, and it is deliberately kept on its own
// endpoint. The number prompt was tuned down to a single question because
// requesting extra fields made the model misread numbers (see the "Vision
// extraction" notes in PROJECT_CONTEXT.md). Describing the pack must never be
// folded back into that prompt.
const APPEARANCE_PROMPT = [
  'Look at this product packaging photo.',
  'Describe only how the pack LOOKS, so it can be compared with a library of known fakes.',
  'Return ONLY a JSON object with exactly these keys:',
  '{"appearance": string, "brand_text": string|null, "pack_type": string|null}.',
  'Rules:',
  '- appearance: one or two sentences covering the pack type, the dominant colours, the shape or style of the main logo, the most prominent words printed, and any obvious printing faults.',
  '- brand_text: the largest brand name printed on the front, spelled exactly as on the pack, or null if it is unreadable.',
  '- pack_type: one short noun such as "carton", "blister strip", "sachet", "bottle" or "tube", or null.',
  '- Never read, guess or output a NAFDAC registration number.',
  '- Never say whether the product is genuine or fake.',
].join(' ');

const APPEARANCE_LIMITS = { appearance: 400, brand_text: 120, pack_type: 40 };

function cleanTextField(value, maxLength) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').replace(/^["'`\s]+|["'`\s]+$/g, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

// Turns whatever the model returned into the fields we store and search on.
// `descriptor` is the single string the client sends back to /verify.
function cleanAppearanceFields(parsed) {
  const appearance = cleanTextField(parsed?.appearance, APPEARANCE_LIMITS.appearance);
  const brand_text = cleanTextField(parsed?.brand_text, APPEARANCE_LIMITS.brand_text);
  const pack_type = cleanTextField(parsed?.pack_type, APPEARANCE_LIMITS.pack_type);
  const descriptor = [brand_text, pack_type, appearance].filter(Boolean).join(' — ') || null;
  return { appearance, brand_text, pack_type, descriptor, usable: Boolean(appearance) };
}

module.exports = { APPEARANCE_PROMPT, APPEARANCE_LIMITS, cleanAppearanceFields };
