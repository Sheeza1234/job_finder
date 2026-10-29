const versions = require('./versions');
const { cvDocx, cvPdf, letterDocx, letterPdf } = require('./exportDocs');

const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const safe = (s) => String(s || 'document').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 40) || 'document';
const httpError = (status, message) => Object.assign(new Error(message), { status });

function checkFormat(format) {
  if (!MIME[format]) throw httpError(400, 'format must be pdf or docx');
  return format;
}

// Drafts are downloadable for review but are named DRAFT; only approved versions are used to apply.
async function cvFile(db, versionId, format = 'pdf') {
  checkFormat(format);
  const v = await versions.needCv(db, versionId);
  const job = await db.prepare('SELECT company, title FROM jobs WHERE id = ?').get(v.job_id);
  const model = versions.cvModel(v);
  const title = `${model.name || 'CV'} - ${job.title}`;
  const buffer = format === 'pdf' ? await cvPdf(model, title) : await cvDocx(model, title);
  return { buffer, mime: MIME[format], format, approved: v.status === 'approved',
    filename: `CV_${safe(model.name)}_${safe(job.company)}_v${v.version_no}${v.status === 'approved' ? '' : '_DRAFT'}.${format}` };
}

async function letterFile(db, letterId, format = 'pdf', profile = {}) {
  checkFormat(format);
  const l = await versions.needLetter(db, letterId);
  const job = await db.prepare('SELECT company, title FROM jobs WHERE id = ?').get(l.job_id);
  const title = `Cover letter - ${job.title}`;
  const buffer = format === 'pdf' ? await letterPdf(l.text, title, profile.fullName) : await letterDocx(l.text, title, profile.fullName);
  return { buffer, mime: MIME[format], format, approved: l.status === 'approved',
    filename: `CoverLetter_${safe(profile.fullName)}_${safe(job.company)}_v${l.version_no}${l.status === 'approved' ? '' : '_DRAFT'}.${format}` };
}

module.exports = { cvFile, letterFile, MIME };
