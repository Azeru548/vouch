// Extract the numbered product list from a screenshot via Groq vision.
// Usage: node scripts/extract_list.js <image> [outfile]
// Output: JSONL, one {"n":<number|null>,"name":"<product>","note":"<qualifier>"} per line.
const fs = require('fs');
const { visionModel } = require('../config');

const KEY = process.env.GROQ_API_KEY;
const file = process.argv[2];
const out = process.argv[3];

if (!KEY) { console.error('GROQ_API_KEY not set'); process.exit(1); }
if (!file) { console.error('usage: node scripts/extract_list.js <image> [outfile]'); process.exit(1); }

const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

const PROMPT = `This is a screenshot of a social media post containing a numbered list of product names.
Transcribe EVERY product name visible, in reading order (top to bottom, left column then right column).
Rules:
- Output one product per line, format: <number>|<product name>|<short qualifier if any>
- <number> is the integer printed before the name; use "?" if no number is visible.
- Keep the product name EXACTLY as printed, including strength, form and brand.
- Do NOT summarise, merge, correct or invent anything. Transcribe only what you can actually read.
- Output nothing except these lines.`;

async function once() {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: visionModel,
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      temperature: 0,
      max_tokens: 900,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.choices[0].message.content;
}

async function main() {
  let text = '';
  // The free tier caps output at 1000 tokens/min, so stay under it and retry on 429.
  for (let attempt = 0; attempt < 4; attempt++) {
    try { text = await once(); break; } catch (e) {
      console.error(`attempt ${attempt + 1}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 25000));
    }
  }
  if (!text) { console.error('all attempts failed'); process.exit(2); }

  const rows = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s\-*\d]+[.)]?\s*/, '').trim();
    if (!line || !/[a-z]/i.test(line)) continue;
    const parts = line.split('|');
    const n = /^\d+$/.test(parts[0].trim()) ? Number(parts[0].trim()) : null;
    const name = (parts[1] || line).trim();
    const note = (parts[2] || '').trim();
    if (name) rows.push({ n, name, note });
  }
  for (const r of rows) {
    const line = `${r.n ?? '?'}|${r.name}${r.note ? '|' + r.note : ''}`;
    console.log(line);
    if (out) fs.appendFileSync(out, line + '\n');
  }
  console.error(`\n[${rows.length} rows from ${file}]`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });