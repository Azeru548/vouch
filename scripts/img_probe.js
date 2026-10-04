// Quick image probe: format + pixel dimensions straight from file headers (no deps).
const fs = require('fs');

function probe(file) {
  const b = fs.readFileSync(file);
  let format = 'unknown';
  let width = 0;
  let height = 0;
  if (b[0] === 0x89 && b[1] === 0x50) {
    format = 'png';
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
  } else if (b[0] === 0xff && b[1] === 0xd8) {
    format = 'jpeg';
    for (let i = 2; i < b.length - 9; ) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        height = b.readUInt16BE(i + 5);
        width = b.readUInt16BE(i + 7);
        break;
      }
      i += 2 + len;
    }
  }
  return { file, format, width, height, kb: Math.round(b.length / 1024) };
}

for (const f of process.argv.slice(2)) console.log(JSON.stringify(probe(f)));
