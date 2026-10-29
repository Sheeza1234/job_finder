const crypto = require('crypto');

// Starting list only. Selecting a category does NOT imply the candidate qualifies;
// matching always compares job requirements with the real profile data.
const DEFAULT_CATEGORIES = [
  'Graphic Designer', 'Senior Graphic Designer', 'Brand Designer', 'UI/UX Designer',
  'Digital Marketing Specialist', 'SEO Specialist', 'Digital Solutions Consultant', 'Web Designer',
  'Frontend Developer', 'AI Tools / AI Automation Specialist', 'Shopify Developer', 'Creative Designer',
  'Marketing and Business Development Specialist',
];

// English + Arabic search keywords per category (used for provider queries).
const CATEGORY_KEYWORDS = {
  'Graphic Designer': ['graphic designer', 'مصمم جرافيك'],
  'Senior Graphic Designer': ['senior graphic designer', 'مصمم جرافيك أول'],
  'Brand Designer': ['brand designer', 'مصمم هوية بصرية'],
  'UI/UX Designer': ['ui ux designer', 'مصمم واجهات وتجربة المستخدم'],
  'Digital Marketing Specialist': ['digital marketing specialist', 'أخصائي تسويق رقمي'],
  'SEO Specialist': ['seo specialist', 'أخصائي تحسين محركات البحث'],
  'Digital Solutions Consultant': ['digital solutions consultant', 'مستشار حلول رقمية'],
  'Web Designer': ['web designer', 'مصمم مواقع'],
  'Frontend Developer': ['frontend developer', 'مطور واجهات أمامية'],
  'AI Tools / AI Automation Specialist': ['ai automation specialist', 'أخصائي أتمتة الذكاء الاصطناعي'],
  'Shopify Developer': ['shopify developer', 'مطور شوبيفاي'],
  'Creative Designer': ['creative designer', 'مصمم إبداعي'],
  'Marketing and Business Development Specialist': ['business development specialist marketing', 'أخصائي تطوير الأعمال والتسويق'],
};

const newId = () => crypto.randomBytes(4).toString('hex');
const str = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v, max = 200) => (Array.isArray(v) ? v : []).map((x) => str(x, max)).filter(Boolean);
const list = (v, fn) => (Array.isArray(v) ? v : []).map(fn);

function emptyProfile() {
  return normalize({});
}

// Coerces arbitrary input into the profile shape, assigning stable ids to list items.
function normalize(p = {}) {
  const prefs = p.preferences || {};
  return {
    fullName: str(p.fullName, 200), email: str(p.email, 200), phone: str(p.phone, 50),
    location: str(p.location, 200), headline: str(p.headline, 300), summary: str(p.summary, 3000),
    linkedinUrl: str(p.linkedinUrl, 500), websiteUrl: str(p.websiteUrl, 500), portfolioUrl: str(p.portfolioUrl, 500),
    yearsExperience: Number.isFinite(Number(p.yearsExperience)) ? Number(p.yearsExperience) : null,
    // categories: legacy starter-list picks. Target job titles are now tags in preferredTitles (see targetTitles()).
    categories: strList(p.categories), preferredTitles: strList(p.preferredTitles), cvKeywords: strList(p.cvKeywords, 60),
    skills: strList(p.skills, 100), languages: strList(p.languages, 100), achievements: strList(p.achievements, 500),
    experience: list(p.experience, (e) => ({
      id: str(e.id, 20) || newId(), title: str(e.title, 200), company: str(e.company, 200), location: str(e.location, 200),
      start: str(e.start, 20), end: str(e.end, 20), current: !!e.current, bullets: strList(e.bullets, 600),
    })),
    education: list(p.education, (e) => ({
      id: str(e.id, 20) || newId(), degree: str(e.degree, 200), institution: str(e.institution, 200),
      year: str(e.year, 20), notes: str(e.notes, 500),
    })),
    certifications: list(p.certifications, (c) => ({
      id: str(c.id, 20) || newId(), name: str(c.name, 200), issuer: str(c.issuer, 200), year: str(c.year, 20),
    })),
    projects: list(p.projects, (x) => ({
      id: str(x.id, 20) || newId(), name: str(x.name, 200), description: str(x.description, 1500),
      url: str(x.url, 500), tech: strList(x.tech, 100),
    })),
    // Saved answers for sensitive application questions. Never guessed: empty means "ask me".
    answers: {
      salaryExpectation: str(p.answers?.salaryExpectation, 200), noticePeriod: str(p.answers?.noticePeriod, 200),
      workAuthorization: str(p.answers?.workAuthorization, 300), visaStatus: str(p.answers?.visaStatus, 300),
      relocation: str(p.answers?.relocation, 300), expectedStartDate: str(p.answers?.expectedStartDate, 100),
    },
    preferences: {
      cities: strList(prefs.cities, 100), employmentTypes: strList(prefs.employmentTypes, 30),
      workModes: strList(prefs.workModes, 30), minSalary: Number(prefs.minSalary) || null,
      currency: str(prefs.currency, 5) || 'SAR', needsSponsorship: !!prefs.needsSponsorship,
      openToRelocation: prefs.openToRelocation !== false,
    },
  };
}

// Earlier versions pre-ticked all 13 starter categories for everyone, which assumed qualifications nobody confirmed.
// A profile whose categories are exactly that untouched default is treated as "no choice made yet".
async function getProfile(db) {
  const row = await db.prepare('SELECT data FROM profile WHERE id = 1').get();
  if (!row) return emptyProfile();
  const p = normalize(JSON.parse(row.data));
  if (p.categories.length === DEFAULT_CATEGORIES.length && DEFAULT_CATEGORIES.every((c) => p.categories.includes(c)) && !p.preferredTitles.length) p.categories = [];
  return p;
}

// The job titles the user is targeting: tags plus any legacy starter picks, de-duplicated.
const targetTitles = (p) => { const s = new Set(); return [...p.preferredTitles, ...p.categories].filter((t) => { const k = t.toLowerCase(); if (s.has(k)) return false; s.add(k); return true; }); };

async function saveProfile(db, input) {
  const p = normalize(input);
  await db.prepare(`INSERT INTO profile (id, data, updated_at) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(JSON.stringify(p), new Date().toISOString());
  return p;
}

// Flat lowercase text of everything the candidate has actually stated.
// Used to ground-check AI output (no unsupported claims).
function corpus(p) {
  return JSON.stringify([
    p.fullName, p.headline, p.summary, p.skills, p.languages, p.achievements, p.yearsExperience,
    p.experience.map((e) => [e.title, e.company, e.start, e.end, e.bullets]),
    p.education, p.certifications, p.projects,
  ]).toLowerCase();
}

module.exports = { targetTitles, DEFAULT_CATEGORIES, CATEGORY_KEYWORDS, emptyProfile, normalize, getProfile, saveProfile, corpus };
