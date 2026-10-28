// Deterministic, explainable baseline match (no AI needed). The AI analysis refines this.
const KNOWN_SKILLS = [
  'photoshop', 'illustrator', 'indesign', 'figma', 'sketch', 'adobe xd', 'after effects', 'premiere', 'canva',
  'branding', 'brand identity', 'logo design', 'typography', 'motion graphics', 'packaging', 'print design',
  'ui design', 'ux design', 'user research', 'wireframing', 'prototyping', 'design systems',
  'html', 'css', 'javascript', 'typescript', 'react', 'vue', 'next.js', 'tailwind', 'sass', 'wordpress',
  'shopify', 'liquid', 'woocommerce', 'webflow', 'node.js', 'php', 'python', 'api',
  'seo', 'sem', 'google analytics', 'google ads', 'meta ads', 'facebook ads', 'social media', 'content marketing',
  'email marketing', 'hubspot', 'crm', 'copywriting', 'ppc', 'keyword research', 'analytics',
  'business development', 'lead generation', 'sales', 'proposal', 'consulting', 'project management',
  'automation', 'zapier', 'n8n', 'chatgpt', 'prompt engineering', 'llm', 'make.com',
  // software development
  'react native', 'redux', 'angular', 'svelte', 'express', 'nest.js', 'graphql', 'rest api', 'mongodb', 'sql', 'postgresql', 'mysql',
  'firebase', 'supabase', 'aws', 'docker', 'kubernetes', 'git', 'github', 'ci/cd', 'linux', 'java', 'c#', '.net', 'laravel', 'django',
  'flutter', 'expo', 'bootstrap', 'material ui', 'jest', 'testing', 'agile', 'scrum', 'microservices',
  'arabic', 'english',
];

// Common spellings of the same technology, so "ReactJS", "React.js" and "react" are one skill.
const ALIASES = [[/\breact\.?js\b/g, 'react'], [/\bvue\.?js\b/g, 'vue'], [/\bnextjs\b/g, 'next.js'], [/\bnodejs\b/g, 'node.js'], [/\bnestjs\b/g, 'nest.js'],
  [/\bhtml5\b/g, 'html'], [/\bcss3\b/g, 'css'], [/\btailwind css\b/g, 'tailwind'], [/\bpostgres\b/g, 'postgresql'], [/\bgithub actions\b/g, 'ci/cd'], [/\bfull[- ]stack\b/g, 'fullstack']];
const canon = (text) => ALIASES.reduce((t, [re, to]) => t.replace(re, to), String(text || '').toLowerCase());

// ---- job titles: compare roles, not exact strings
const LEVEL_WORDS = new Set(['senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'intern', 'trainee', 'remote', 'freelance', 'contract', 'the', 'and', 'of', 'a', 'in', 'for', 'to', 'ii', 'iii', 'iv']);
const GENERIC = new Set(['developer', 'engineer', 'specialist', 'manager', 'consultant', 'officer', 'assistant', 'executive', 'designer', 'analyst', 'coordinator', 'representative', 'programmer']);
function titleTokens(title) {
  const t = String(title || '').toLowerCase().replace(/front[- ]end/g, 'frontend').replace(/back[- ]end/g, 'backend').replace(/full[- ]stack/g, 'fullstack')
    .replace(/\bui\/ux\b/g, 'ui ux').replace(/\bengineers?\b|\bprogrammers?\b|\bdevelopers?\b/g, 'developer');
  return t.split(/[^a-z0-9\u0600-\u06ff+#.]+/).filter((x) => x.length > 1 && !LEVEL_WORDS.has(x));
}
// How well a job title fits one wanted title: share of the wanted title's DISTINCTIVE words that appear in the job title.
// Generic words (developer, manager...) alone never count, so "Service Desk Engineer" does not fit "Full Stack Developer".
function titleFit(wanted, jobTitle) {
  const w = titleTokens(wanted); const j = new Set(titleTokens(jobTitle));
  const distinct = [...new Set(w.filter((x) => !GENERIC.has(x)))];
  if (!distinct.length) return w.length && w.every((x) => j.has(x)) ? 1 : 0;
  return distinct.filter((x) => j.has(x)).length / distinct.length;
}

// Titles that describe the candidate: chosen tags (and legacy picks), the CV headline, and roles actually held.
function roleTitles(profile) {
  const seen = new Set(); const out = [];
  const add = (t) => { const v = String(t || '').replace(/\s+/g, ' ').trim(); const k = titleTokens(v).join(' '); if (v.length >= 3 && v.length <= 60 && k && !seen.has(k)) { seen.add(k); out.push(v); } };
  [...profile.preferredTitles, ...profile.categories].forEach(add);
  String(profile.headline || '').split(/[·|/,;•–—]| - /).forEach(add);
  profile.experience.forEach((e) => add(e.title));
  return out;
}

const tokens = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9؀-ۿ+#.]+/).filter((t) => t.length > 1));
// Whole-word match that also accepts simple plurals ("identity" ~ "identities", "logo" ~ "logos").
const has = (text, term) => {
  const t = term.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  const pat = /y$/.test(term) ? `${t.slice(0, -1)}(?:y|ies)` : `${t}(?:e?s)?`;
  return new RegExp(`(^|[^a-z0-9])${pat}($|[^a-z0-9])`, 'i').test(text);
};

function profileSkillSet(p) {
  const raw = canon([...p.skills, ...p.projects.flatMap((x) => x.tech), ...p.certifications.map((c) => c.name),
    ...p.experience.flatMap((e) => e.bullets)].join(' '));
  return new Set(KNOWN_SKILLS.filter((k) => has(raw, k)).concat(p.skills.map((s) => s.toLowerCase())));
}

const LEVEL_MIN_YEARS = { entry: 0, mid: 2, senior: 5, lead: 8 };

function matchJob(profile, job) {
  // freshly fetched jobs carry skills as a JSON string; stored jobs have an array
  const jobSkillList = Array.isArray(job.skills) ? job.skills : (() => { try { return JSON.parse(job.skills || '[]'); } catch { return []; } })();
  const text = canon(`${job.title} ${job.description} ${jobSkillList.join(' ')}`);
  const jobSkills = KNOWN_SKILLS.filter((k) => has(text, k) && !['english', 'arabic'].includes(k));
  const mine = profileSkillSet(profile);
  const matched = jobSkills.filter((k) => mine.has(k));
  const missing = jobSkills.filter((k) => !mine.has(k));
  const skillScore = jobSkills.length ? matched.length / jobSkills.length : 0.4;

  // Title match: the best of every title that describes the candidate (chosen tags, CV headline, roles held).
  let titleScore = 0;
  for (const w of roleTitles(profile)) titleScore = Math.max(titleScore, titleFit(w, job.title));

  let expScore = 0.6;
  const yrs = profile.yearsExperience;
  if (yrs != null && LEVEL_MIN_YEARS[job.experience_level] != null) {
    const need = LEVEL_MIN_YEARS[job.experience_level];
    expScore = yrs >= need ? 1 : Math.max(0, 1 - (need - yrs) / 4);
  }

  const empty = !profile.skills.length && !profile.experience.length;
  const score = empty ? null : Math.round(100 * (0.5 * skillScore + 0.35 * titleScore + 0.15 * expScore));
  return { score, matchedSkills: matched, missingSkills: missing, titleScore: +titleScore.toFixed(2), expScore: +expScore.toFixed(2) };
}

// A fetched job is kept only if its title fits a role the candidate has or wants, or it scores well overall.
// Titles to search for: what the user chose, then the roles on their CV. (Order matters: maxQueries caps the list.)
const searchTitles = (profile) => roleTitles(profile);

function isRelevant(profile, job) {
  const m = matchJob(profile, job);
  if (m.score == null) return true;                       // empty profile: nothing to judge against
  return roleTitles(profile).some((w) => titleFit(w, job.title) >= 0.5) || m.score >= 60;
}

module.exports = { searchTitles, matchJob, isRelevant, roleTitles, titleFit, canon, KNOWN_SKILLS, has, profileSkillSet };
