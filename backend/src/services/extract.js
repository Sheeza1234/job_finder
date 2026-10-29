const fs = require('fs');
const path = require('path');

async function pdfText(buf) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buf });
  try { return (await parser.getText()).text.replace(/\n-- \d+ of \d+ --\n/g, '\n').trim(); } finally { await parser.destroy(); }
}

async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const buf = fs.readFileSync(filePath);
  if (ext === '.pdf') {
    return pdfText(buf);
  }
  if (ext === '.docx') {
    return (await require('mammoth').extractRawText({ buffer: buf })).value.trim();
  }
  if (['.txt', '.md'].includes(ext)) return buf.toString('utf8').trim();
  return ''; // images etc. are stored but not text-extracted
}

module.exports = { extractText, pdfText };

// Uploaded files must actually be what their extension claims (not an executable renamed to .pdf).
const SIGNATURES = { '.pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  '.docx': (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) && b.includes('word/document.xml'),
  '.png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  '.txt': (b) => !b.subarray(0, 4096).includes(0), '.md': (b) => !b.subarray(0, 4096).includes(0) };

function validateUpload(filePath, ext) {
  const check = SIGNATURES[ext.toLowerCase()];
  const buf = fs.readFileSync(filePath);
  if (!check || !check(buf)) throw Object.assign(new Error(`The file content does not match a valid ${ext} file.`), { status: 400 });
}

// Parsing runs with a time limit and a size cap so a hostile file cannot hang or flood the server.
async function safeExtract(filePath, name) {
  const text = await Promise.race([extractText(filePath, name), new Promise((_, rej) => setTimeout(() => rej(new Error('Extraction timed out')), 20000).unref())]);
  return text.slice(0, 300000);
}

module.exports.validateUpload = validateUpload;
module.exports.safeExtract = safeExtract;
