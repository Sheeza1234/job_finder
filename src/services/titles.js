// Target job titles derived from the CV. Tags are SUGGESTIONS backed by evidence (keywords actually present in the CV);
// the user can remove or add any. A tag never means "you qualify": matching still compares each job to the real profile.
const { KNOWN_SKILLS, has } = require('./match');

// Offline rules (no AI, nothing leaves the machine): a title is suggested when enough of its skills appear in the CV.
const RULES = [
  { title: 'Graphic Designer', any: ['photoshop', 'illustrator', 'indesign', 'canva', 'typography', 'print design', 'packaging', 'logo design'], min: 1 },
  { title: 'Brand Designer', any: ['branding', 'brand identity', 'logo design', 'typography'], min: 1 },
  { title: 'UI/UX Designer', any: ['figma', 'sketch', 'adobe xd', 'ui design', 'ux design', 'wireframing', 'prototyping', 'user research', 'design systems'], min: 1 },
  { title: 'Web Designer', any: ['wordpress', 'webflow', 'html', 'css', 'figma'], min: 2 },
  { title: 'Frontend Developer', any: ['html', 'css', 'javascript', 'typescript', 'react', 'vue', 'next.js', 'tailwind'], min: 2 },
  { title: 'Shopify Developer', any: ['shopify', 'liquid', 'woocommerce'], min: 1 },
  { title: 'Digital Marketing Specialist', any: ['google ads', 'meta ads', 'facebook ads', 'social media', 'content marketing', 'email marketing', 'ppc', 'google analytics'], min: 2 },
  { title: 'SEO Specialist', any: ['seo', 'keyword research'], min: 1 },
  { title: 'AI Tools / AI Automation Specialist', any: ['ai', 'automation', 'zapier', 'n8n', 'chatgpt', 'prompt engineering', 'llm', 'make.com'], min: 2 },
  { title: 'Motion Graphics Designer', any: ['motion graphics', 'after effects', 'premiere'], min: 1 },
  { title: 'Marketing and Business Development Specialist', any: ['business development', 'lead generation', 'sales', 'proposal'], min: 2 },
  { title: 'Digital Solutions Consultant', any: ['consulting', 'project management', 'crm', 'hubspot'], min: 2 },
  { title: 'Creative Designer', any: ['photoshop', 'illustrator', 'figma', 'canva', 'after effects'], min: 2 },
];
const MAX_TAGS = 8;

// Everything the CV/profile says, as one lowercase string to search.
function corpusOf(profile, cvText) {
  return `${cvText || ''}\n${JSON.stringify([profile.headline, profile.summary, profile.skills, profile.languages,
    profile.experience.map((e) => [e.title, e.company, e.bullets]), profile.education, profile.certifications, profile.projects])}`.toLowerCase();
}

const keywordsIn = (corpus) => KNOWN_SKILLS.filter((k) => !['english', 'arabic'].includes(k) && has(corpus, k));

function suggestLocal(profile, cvText) {
  const corpus = corpusOf(profile, cvText);
  const out = [];
  for (const r of RULES) {
    const evidence = r.any.filter((k) => has(corpus, k));
    if (evidence.length >= r.min) out.push({ title: r.title, evidence, reason: `Your CV mentions ${evidence.join(', ')}` });
  }
  out.sort((a, b) => b.evidence.length - a.evidence.length);
  if ((profile.yearsExperience || 0) >= 5 && out.some((s) => s.title === 'Graphic Designer')) {
    const g = out.find((s) => s.title === 'Graphic Designer');
    out.unshift({ title: 'Senior Graphic Designer', evidence: g.evidence, reason: `${profile.yearsExperience} years of experience plus ${g.evidence.join(', ')}` });
  }
  return { keywords: keywordsIn(corpus), suggestions: out.slice(0, MAX_TAGS) };
}

// AI output is untrusted: keep only titles with at least one evidence keyword that really appears in the CV/profile.
function validateAi(raw, profile, cvText) {
  const corpus = corpusOf(profile, cvText);
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const seen = new Set(); const suggestions = [];
  for (const t of Array.isArray(raw?.suggested_titles) ? raw.suggested_titles : []) {
    const title = clean(t?.title, 80); if (!title || seen.has(title.toLowerCase())) continue;
    const evidence = (Array.isArray(t.evidence) ? t.evidence : []).map((e) => clean(e, 40)).filter((e) => e && has(corpus, e.toLowerCase()));
    if (!evidence.length) continue;                       // no evidence in the CV: not suggested
    seen.add(title.toLowerCase()); suggestions.push({ title, evidence: [...new Set(evidence)].slice(0, 6), reason: clean(t.reason, 160) || `Your CV mentions ${evidence.join(', ')}` });
  }
  const aiKeywords = (Array.isArray(raw?.keywords) ? raw.keywords : []).map((k) => clean(k, 40)).filter((k) => k && has(corpus, k.toLowerCase()));
  return { keywords: [...new Set([...aiKeywords, ...keywordsIn(corpus)])].slice(0, 40), suggestions: suggestions.slice(0, MAX_TAGS) };
}

const uniq = (arr) => { const s = new Set(); return arr.filter((x) => { const k = x.toLowerCase(); if (s.has(k)) return false; s.add(k); return true; }); };

module.exports = { suggestLocal, validateAi, keywordsIn, corpusOf, uniq, RULES };
