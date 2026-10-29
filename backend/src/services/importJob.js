const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { buildJob, stripHtml } = require('../normalize');
const ai = require('./ai');
const assistant = require('./assistant');
const { upsertJobs } = require('./jobsStore');

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l === '::';
}

// Fetch a single user-supplied URL. Refuses non-http(s) and private-network targets, re-validating every redirect hop.
async function safeFetch(rawUrl, lookup = dns.lookup, hops = 3) {
  let u = new URL(rawUrl);
  for (let i = 0; i <= hops; i++) {
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are allowed');
    const addrs = await lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('URL resolves to a private or invalid address');
    const res = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'JobFinderAssistant/1.0' }, signal: AbortSignal.timeout(15000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
    return { status: res.status, html: (await res.text()).slice(0, 2_000_000), url: u.href };
  }
  throw new Error('Too many redirects');
}

async function safeFetchHtml(rawUrl, lookup) {
  const r = await safeFetch(rawUrl, lookup);
  if (r.status < 200 || r.status >= 300) throw new Error(`Page returned HTTP ${r.status}`);
  return r.html;
}

// Best-effort "is this listing still up?" check. JS-rendered pages can look open when they are not, so this only suggests.
async function checkListing(url, lookup) {
  try {
    const r = await safeFetch(url, lookup);
    if (r.status === 404 || r.status === 410) return { state: 'expired', detail: `The page returns HTTP ${r.status}.` };
    if (r.status >= 400) return { state: 'unknown', detail: `The site returned HTTP ${r.status}.` };
    if (/no longer (accepting|available)|position (has been )?filled|(job|vacancy|position|listing) (is )?(closed|expired)|this job (has )?expired|انتهى التقديم|الوظيفة غير متاحة/i.test(stripHtml(r.html))) {
      return { state: 'likely_expired', detail: 'The page says the position is closed or filled.' };
    }
    return { state: 'appears_open', detail: 'The page loads and does not say it is closed (not a guarantee).' };
  } catch (e) { return { state: 'unknown', detail: e.message }; }
}

function fromJsonLd(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : data['@graph'] || [data];
      const jp = items.find((i) => i && [].concat(i['@type']).includes('JobPosting'));
      if (jp) return jp;
    } catch { /* ignore malformed block */ }
  }
  return null;
}

async function importJob(db, { url, text, title, company, location }) {
  let fields = { title, company, location, description: text, url };
  if (url && !text) {
    const html = await safeFetchHtml(url);
    const jp = fromJsonLd(html);
    if (jp) {
      const loc = jp.jobLocation?.address || (Array.isArray(jp.jobLocation) ? jp.jobLocation[0]?.address : null) || {};
      fields = {
        title: jp.title, company: jp.hiringOrganization?.name,
        location: [loc.addressLocality, loc.addressRegion, loc.addressCountry?.name || loc.addressCountry].filter(Boolean).join(', '),
        description: jp.description, url,
        employment: [].concat(jp.employmentType || [])[0], posted: jp.datePosted, validThrough: jp.validThrough,
        salary: jp.baseSalary?.value, remote: jp.jobLocationType === 'TELECOMMUTE',
      };
    } else {
      fields.description = stripHtml(html);
      fields.title = title || (html.match(/<title>([^<]+)/i) || [])[1];
    }
  }
  if (!fields.description || fields.description.length < 40) throw new Error('Not enough job text to import');

  // Unstructured text: let AI fill in fields when available; otherwise require a title.
  if ((!fields.title || !fields.company) && ai.isConfigured()) {
    try { fields = { ...(await assistant.structureJobText(fields.description)), ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) }; }
    catch { /* fall back to what we have */ }
  }
  if (!fields.title) throw new Error('Could not determine a job title; please provide one');

  const hash = crypto.createHash('sha1').update(url || fields.description).digest('hex').slice(0, 16);
  const empMap = { FULL_TIME: 'full_time', PART_TIME: 'part_time', CONTRACTOR: 'contract', INTERN: 'internship' };
  const job = buildJob({
    source: 'manual', externalId: hash, url, title: fields.title, company: fields.company,
    locationText: fields.location, description: fields.description,
    employmentHint: empMap[fields.employment] || fields.employment_type, workModeHint: fields.remote ? 'remote' : undefined,
    expiresAt: fields.validThrough && !isNaN(new Date(fields.validThrough)) ? new Date(fields.validThrough).toISOString() : undefined,
    industry: fields.industry, postedAt: fields.posted ? new Date(fields.posted).toISOString() : new Date().toISOString(),
    salaryMin: fields.salary?.minValue, salaryMax: fields.salary?.maxValue, salaryCurrency: fields.salary?.currency,
  });
  await upsertJobs(db, [job]);
  return (await db.prepare('SELECT id FROM jobs WHERE source=? AND external_id=?').get('manual', hash)).id;
}

module.exports = { importJob, safeFetch, safeFetchHtml, checkListing, isPrivateIp, fromJsonLd };
