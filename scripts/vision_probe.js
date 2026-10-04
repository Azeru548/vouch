// One-shot vision probe: describe a local image with the Groq model Vouch already uses.
// Usage: node scripts/vision_probe.js <image> ["question"]
const fs = require('fs');
const path = require('path');

const { visionModel } = require('../config');

const KEY = process.env.GROQ_API_KEY;
const file = process.argv[2];
const question = process.argv[3] || 'Describe this image. Transcribe every piece of text you can read, verbatim.';

if (!KEY) { console.error('GROQ_API_KEY not set'); process.exit(1); }
if (!file) { console.error('usage: node scripts/vision_probe.js <image> [question]'); process.exit(1); }

const ext = path.extname(file).toLowerCase();
const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

async function main() {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: visionModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      temperature: 0,
      max_tokens: 900,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, JSON.stringify(body).slice(0, 400));
    process.exit(2);
  }
  console.log(body.choices[0].message.content);
  if (body.usage) console.error(`\n[${visionModel} tokens: ${body.usage.total_tokens}]`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });