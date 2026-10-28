// Saudi and Pakistani normalisation: cities (EN/AR), country, employment type, work mode,
// experience level, and explicit sponsorship / relocation detection.

const CITIES = [
  { name: 'Riyadh', re: /riyadh|الرياض/i, country: 'Saudi Arabia' },
  { name: 'Jeddah', re: /jeddah|jiddah|jidda|جدة|جدّة/i, country: 'Saudi Arabia' },
  { name: 'Dammam', re: /dammam|الدمام/i, country: 'Saudi Arabia' },
  { name: 'Al Khobar', re: /al[\s-]?khobar|khobar|الخبر/i, country: 'Saudi Arabia' },
  { name: 'Dhahran', re: /dhahran|الظهران/i, country: 'Saudi Arabia' },
  { name: 'Mecca', re: /mecca|makkah|مكة/i, country: 'Saudi Arabia' },
  { name: 'Medina', re: /medina|madinah|المدينة المنورة/i, country: 'Saudi Arabia' },
  { name: 'NEOM', re: /\bneom\b|نيوم/i, country: 'Saudi Arabia' },
  { name: 'Jubail', re: /jubail|الجبيل/i, country: 'Saudi Arabia' },
  { name: 'Yanbu', re: /yanbu|ينبع/i, country: 'Saudi Arabia' },
  { name: 'Tabuk', re: /tabuk|تبوك/i, country: 'Saudi Arabia' },
  { name: 'Abha', re: /\babha\b|أبها/i, country: 'Saudi Arabia' },
  { name: 'Taif', re: /\btaif\b|الطائف/i, country: 'Saudi Arabia' },
  { name: 'Qiddiya', re: /qiddiya|القدية/i, country: 'Saudi Arabia' },
  { name: 'Red Sea Global', re: /red sea (global|project)|البحر الأحمر/i, country: 'Saudi Arabia' },
  { name: 'Diriyah', re: /diriyah|الدرعية/i, country: 'Saudi Arabia' },
  // Pakistan
  { name: 'Lahore', re: /lahore|لاہور/i, country: 'Pakistan' },
  { name: 'Karachi', re: /karachi|کراچی/i, country: 'Pakistan' },
  { name: 'Islamabad', re: /islamabad|اسلام آباد/i, country: 'Pakistan' },
  { name: 'Rawalpindi', re: /rawalpindi|راولپنڈی/i, country: 'Pakistan' },
  { name: 'Faisalabad', re: /faisalabad|فیصل آباد/i, country: 'Pakistan' },
  { name: 'Multan', re: /multan|ملتان/i, country: 'Pakistan' },
  { name: 'Peshawar', re: /peshawar|پشاور/i, country: 'Pakistan' },
  { name: 'Sialkot', re: /sialkot|سیالکوٹ/i, country: 'Pakistan' },
  { name: 'Gujranwala', re: /gujranwala|گوجرانوالہ/i, country: 'Pakistan' },
  { name: 'Quetta', re: /quetta|کوئٹہ/i, country: 'Pakistan' },
];

const SAUDI_RE = /saudi|\bksa\b|المملكة العربية السعودية|السعودية/i;

function detectCity(text) {
  for (const c of CITIES) if (c.re.test(text || '')) return c.name;
  return null;
}

const PAKISTAN_RE = /pakistan|پاکستان/i;
const cityCountry = (name) => CITIES.find((c) => c.name === name)?.country || null;

// An explicit country name wins; otherwise the country of a recognised city.
function detectCountry(text) {
  const t = text || '';
  if (SAUDI_RE.test(t)) return 'Saudi Arabia';
  if (PAKISTAN_RE.test(t)) return 'Pakistan';
  const c = CITIES.find((x) => x.re.test(t));
  return c ? c.country : null;
}

const isSaudiLocation = (text) => detectCountry(text) === 'Saudi Arabia';

function detectEmploymentType(text) {
  const t = (text || '').toLowerCase();
  if (/part[\s-]?time|دوام جزئي/.test(t)) return 'part_time';
  if (/contract|freelance|temporary|عقد مؤقت|عقد/.test(t)) return 'contract';
  if (/intern(ship)?|تدريب/.test(t)) return 'internship';
  if (/full[\s-]?time|دوام كامل|permanent/.test(t)) return 'full_time';
  return 'unknown';
}

function detectWorkMode(text) {
  const t = (text || '').toLowerCase();
  if (/hybrid|هجين/.test(t)) return 'hybrid';
  if (/remote|work from home|wfh|عن بعد/.test(t)) return 'remote';
  if (/on[\s-]?site|onsite|in[\s-]office|في الموقع/.test(t)) return 'onsite';
  return 'unknown';
}

function detectExperienceLevel(title, description) {
  const t = (title || '').toLowerCase();
  if (/\b(lead|head|director|principal|manager)\b|رئيس|مدير/.test(t)) return 'lead';
  if (/\b(senior|sr\.?)\b|أول|خبير/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|entry|graduate|trainee|intern)\b|مبتدئ|حديث التخرج/.test(t)) return 'entry';
  const m = (description || '').match(/(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years|yrs|سنوات|سنة)/i);
  if (m) {
    const y = Number(m[1]);
    if (y >= 8) return 'lead';
    if (y >= 5) return 'senior';
    if (y >= 2) return 'mid';
    return 'entry';
  }
  return 'unknown';
}

// Sponsorship is "not_specified" unless the text explicitly says otherwise.
// Negative phrases are checked first so "no visa sponsorship" never reads as "yes".
const SPONSOR_NO = [
  /no\s+(visa\s+)?sponsorship/i,
  /(unable|not able|cannot|can't|do not|don't|will not|won't)\s+(to\s+)?(provide\s+|offer\s+)?(visa\s+)?sponsor/i,
  /sponsorship\s+(is\s+)?not\s+(available|provided|offered)/i,
  /must\s+(already\s+)?(have|hold)\s+(a\s+)?(valid\s+)?(saudi\s+)?(iqama|work (permit|visa)|right to work)/i,
  /saudi nationals only|للسعوديين فقط|سعودي الجنسية/i,
];
const SPONSOR_YES = [
  /visa\s+sponsorship\s+(is\s+)?(available|provided|offered|included)/i,
  /(we|company|employer)\s+(will\s+)?(provide|offer|sponsor|arrange)s?\s+(a\s+)?(work\s+)?(visa|iqama|sponsorship)/i,
  /(visa|iqama|work permit)\s+(sponsorship\s+)?(will be\s+)?(provided|sponsored|arranged)/i,
  /sponsorship\s+(available|provided|offered)/i,
  /visa\s+sponsor(ed|ship)\b(?!.*\bnot\b)/i,
  /تأشيرة\s+(عمل\s+)?(مقدمة|متوفرة|مضمونة)|نوفر\s+(تأشيرة|إقامة)|توفير\s+(التأشيرة|الإقامة)/i,
];
const RELOC_NO = [/no\s+relocation/i, /relocation\s+(is\s+)?not\s+(available|provided|offered)/i];
const RELOC_YES = [
  /relocation\s+(package|assistance|support|allowance|bonus|benefits?)/i,
  /(we|company)\s+(will\s+)?(offer|provide|cover)s?\s+relocation/i,
  /relocation\s+(is\s+)?(provided|offered|available|included)/i,
  /بدل\s+انتقال|مساعدة\s+في\s+الانتقال|دعم\s+الانتقال/i,
];

function classify(text, yes, no) {
  const t = text || '';
  if (no.some((r) => r.test(t))) return 'no';
  if (yes.some((r) => r.test(t))) return 'yes';
  return 'not_specified';
}

const detectSponsorship = (text) => classify(text, SPONSOR_YES, SPONSOR_NO);
const detectRelocation = (text) => classify(text, RELOC_YES, RELOC_NO);

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// Remote jobs: can someone in Pakistan or relocating to KSA apply?
function remoteEligibility(locationRestriction) {
  const t = (locationRestriction || '').trim();
  if (!t) return 'unknown';
  if (/worldwide|anywhere|global|any location|all countries/i.test(t)) return 'worldwide';
  if (/pakistan|saudi|ksa|mena|middle east|gulf|gcc|asia|emea|apac/i.test(t)) return 'worldwide';
  return 'restricted';
}

// Normalise any provider's raw record into the jobs-table shape.
function buildJob({ source, externalId, url, title, company, locationText, description, employmentHint,
  workModeHint, remoteRestriction, industry, salaryMin, salaryMax, salaryCurrency, postedAt, expiresAt, skills }) {
  const desc = stripHtml(description);
  const all = `${title} ${locationText || ''} ${desc}`;
  const city = detectCity(locationText) || detectCity(`${title} ${desc}`.slice(0, 600));
  const country = detectCountry(locationText) || (city && !locationText ? cityCountry(city) : null);
  let workMode = workModeHint && workModeHint !== 'unknown' ? workModeHint : detectWorkMode(`${title} ${locationText || ''} ${desc.slice(0, 800)}`);
  return {
    source,
    external_id: String(externalId),
    url: url || null,
    title: String(title || '').trim(),
    company: company || null,
    city,
    country,
    location_text: locationText || null,
    description: desc,
    employment_type: employmentHint && employmentHint !== 'unknown' ? employmentHint : detectEmploymentType(`${title} ${desc.slice(0, 600)}`),
    work_mode: workMode,
    remote_eligibility: workMode === 'remote' ? remoteEligibility(remoteRestriction || locationText) : null,
    industry: industry || null,
    experience_level: detectExperienceLevel(title, desc),
    salary_min: salaryMin ?? null,
    salary_max: salaryMax ?? null,
    salary_currency: salaryCurrency || null,
    posted_at: postedAt || null,
    expires_at: expiresAt || null,
    sponsorship: detectSponsorship(all),
    relocation: detectRelocation(all),
    skills: JSON.stringify(skills || []),
  };
}

// Identity of a posting across sources: employer + title + city. Null when the employer is unknown (too weak to merge on).
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, ' ').trim();
function jobFingerprint(j) {
  return j.company && j.title ? `${slug(j.company)}|${slug(j.title)}|${slug(j.city)}` : null;
}
const urlKey = (u) => { try { const x = new URL(u); return x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, ''); } catch { return null; } };

module.exports = {
  jobFingerprint, urlKey,
  CITIES, detectCity, detectCountry, isSaudiLocation, detectEmploymentType, detectWorkMode, detectExperienceLevel,
  detectSponsorship, detectRelocation, stripHtml, remoteEligibility, buildJob,
};
