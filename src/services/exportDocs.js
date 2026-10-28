const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = require('docx');

// Merge the (fixed-fact) profile with the tailored wording into a render model.
function buildCvModel(profile, t) {
  const dates = (e) => [e.start, e.current ? 'Present' : e.end].filter(Boolean).join(' – ');
  const expById = new Map(profile.experience.map((e) => [e.id, e]));
  const projById = new Map(profile.projects.map((p) => [p.id, p]));
  // Tailored: the order (relevance) and wording come from `t`; every fact comes from the profile entry for that id.
  const exp = t ? t.experience.filter((e) => expById.has(e.id)).map((e) => ({ e: expById.get(e.id), bullets: e.bullets }))
    : profile.experience.map((e) => ({ e, bullets: e.bullets }));
  const proj = t ? t.projects.filter((p) => projById.has(p.id)).map((p) => ({ p: projById.get(p.id), description: p.description }))
    : profile.projects.map((p) => ({ p, description: p.description }));
  return {
    name: profile.fullName,
    contact: [profile.email, profile.phone, profile.location, profile.linkedinUrl, profile.websiteUrl, profile.portfolioUrl].filter(Boolean),
    headline: t?.headline || profile.headline,
    summary: t?.summary || profile.summary,
    skills: t?.skills?.length ? t.skills : profile.skills,
    experience: exp.map(({ e, bullets }) => ({ id: e.id, title: e.title, company: e.company, location: e.location, dates: dates(e), bullets })),
    projects: proj.map(({ p, description }) => ({ id: p.id, name: p.name, url: p.url, description })),
    education: profile.education.map((e) => ({ line: [e.degree, e.institution, e.year].filter(Boolean).join(', '), notes: e.notes })),
    certifications: profile.certifications.map((c) => [c.name, c.issuer, c.year].filter(Boolean).join(', ')),
    achievements: profile.achievements,
    languages: profile.languages,
  };
}

const heading = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 80 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } },
  children: [new TextRun({ text: text.toUpperCase(), bold: true, size: 22 })],
});
const para = (text, opts = {}) => new Paragraph({ spacing: { after: 60 }, ...opts, children: [new TextRun({ text, ...(opts.run || {}) })] });
const bullet = (text) => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 40 } });

const DOCX_STYLES = { default: { document: { run: { font: 'Arial', size: 21 } } } };

async function cvDocx(model, title = 'CV') {
  const c = [];
  c.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: model.name || 'Your Name', bold: true, size: 36 })] }));
  if (model.headline) c.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: model.headline, size: 24 })] }));
  if (model.contact.length) c.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: model.contact.join('  |  '), size: 18 })] }));
  if (model.summary) { c.push(heading('Summary')); c.push(para(model.summary)); }
  if (model.skills.length) { c.push(heading('Skills')); c.push(para(model.skills.join(' • '))); }
  if (model.experience.length) {
    c.push(heading('Experience'));
    for (const e of model.experience) {
      c.push(new Paragraph({ spacing: { before: 100 }, children: [
        new TextRun({ text: e.title, bold: true }), new TextRun({ text: e.company ? `, ${e.company}` : '' }),
        new TextRun({ text: e.dates ? `   (${e.dates})` : '', italics: true })] }));
      if (e.location) c.push(para(e.location, { run: { italics: true, size: 18 } }));
      e.bullets.forEach((b) => c.push(bullet(b)));
    }
  }
  if (model.projects.length) {
    c.push(heading('Projects'));
    for (const p of model.projects) {
      c.push(new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: p.name, bold: true }), new TextRun({ text: p.url ? `  ${p.url}` : '', size: 18 })] }));
      if (p.description) c.push(para(p.description));
    }
  }
  if (model.education.length) { c.push(heading('Education')); model.education.forEach((e) => { c.push(para(e.line)); if (e.notes) c.push(para(e.notes, { run: { size: 18 } })); }); }
  if (model.certifications.length) { c.push(heading('Certifications')); model.certifications.forEach((x) => c.push(bullet(x))); }
  if (model.achievements.length) { c.push(heading('Achievements')); model.achievements.forEach((x) => c.push(bullet(x))); }
  if (model.languages.length) { c.push(heading('Languages')); c.push(para(model.languages.join(', '))); }
  return Packer.toBuffer(new Document({ creator: model.name || 'Candidate', title, styles: DOCX_STYLES, sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } }, children: c }] }));
}

async function letterDocx(text, title = 'Cover letter', author = 'Candidate') {
  const rtl = /[؀-ۿ]/.test(text);
  const children = text.split(/\n\s*\n/).map((p) => new Paragraph({ bidirectional: rtl, spacing: { after: 160 }, children: [new TextRun({ text: p.trim(), size: 22 })] }));
  return Packer.toBuffer(new Document({ creator: author, title, styles: DOCX_STYLES, sections: [{ children }] }));
}

// ---- PDF (single column, standard font, real text so ATS parsers can read it)
// pdfkit's built-in fonts are Latin-only and it does no RTL shaping, so non-Latin text is refused rather than garbled.
const LATIN_OK = /^[\u0009\u000a\u000d\u0020-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026\u20ac]*$/;
function assertPdfSafe(text) {
  if (!LATIN_OK.test(text)) {
    throw Object.assign(new Error('PDF export supports Latin text only (Arabic/other scripts would be garbled). Download the DOCX instead.'), { status: 422 });
  }
}
const modelText = (m) => JSON.stringify(m).replace(/\\n/g, '\n');

function renderPdf(info, draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 55, right: 55 }, info: { Title: info.title, Author: info.author } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    draw(doc); doc.end();
  });
}

function cvPdf(model, title = 'CV') {
  assertPdfSafe(modelText(model));
  return renderPdf({ title, author: model.name || 'Candidate' }, (doc) => {
    const heading = (t) => { doc.moveDown(0.8).font('Helvetica-Bold').fontSize(10.5).text(t.toUpperCase()); doc.moveTo(doc.x, doc.y + 1).lineTo(doc.page.width - doc.page.margins.right, doc.y + 1).strokeColor('#888').lineWidth(0.5).stroke(); doc.moveDown(0.4); };
    const body = (t, opts) => doc.font('Helvetica').fontSize(10).fillColor('#000').text(t, opts);
    const bullet = (t) => doc.font('Helvetica').fontSize(10).text(`\u2022  ${t}`, { indent: 0, paragraphGap: 2 });
    doc.font('Helvetica-Bold').fontSize(18).text(model.name || 'Your Name', { align: 'center' });
    if (model.headline) doc.font('Helvetica').fontSize(11).text(model.headline, { align: 'center' });
    if (model.contact.length) doc.fontSize(9).text(model.contact.join('  |  '), { align: 'center' });
    if (model.summary) { heading('Summary'); body(model.summary); }
    if (model.skills.length) { heading('Skills'); body(model.skills.join(', ')); }
    if (model.experience.length) {
      heading('Experience');
      for (const e of model.experience) {
        doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10).text([e.title, e.company].filter(Boolean).join(', '), { continued: !!e.dates });
        if (e.dates) doc.font('Helvetica').text(`   (${e.dates})`);
        if (e.location) body(e.location);
        e.bullets.forEach(bullet);
      }
    }
    if (model.projects.length) {
      heading('Projects');
      for (const p of model.projects) { doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10).text(p.name + (p.url ? `  ${p.url}` : '')); if (p.description) body(p.description); }
    }
    if (model.education.length) { heading('Education'); model.education.forEach((e) => { body(e.line); if (e.notes) body(e.notes); }); }
    if (model.certifications.length) { heading('Certifications'); model.certifications.forEach(bullet); }
    if (model.achievements.length) { heading('Achievements'); model.achievements.forEach(bullet); }
    if (model.languages.length) { heading('Languages'); body(model.languages.join(', ')); }
  });
}

function letterPdf(text, title = 'Cover letter', author = 'Candidate') {
  assertPdfSafe(text);
  return renderPdf({ title, author }, (doc) => {
    doc.font('Helvetica').fontSize(11);
    text.split(/\n\s*\n/).forEach((p) => doc.text(p.trim(), { paragraphGap: 10, lineGap: 2 }));
  });
}

module.exports = { buildCvModel, cvDocx, letterDocx, cvPdf, letterPdf };
