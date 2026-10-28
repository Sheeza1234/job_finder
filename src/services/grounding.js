// Anti-fabrication checks. AI output (and the user's own edits) may only restate what the
// candidate's profile supports; anything else is dropped or surfaced as a warning.
const { corpus } = require('./profile');
const { KNOWN_SKILLS, has, profileSkillSet, matchJob } = require('./match');

const NUM_RE = /\d[\d,.]*\s?%?/g;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9؀-ۿ+#.]+/g, ' ').trim();

// Figures (years, percentages, counts) in `text` that appear nowhere in the profile.
function unsupportedFigures(profile, text) {
  const base = corpus(profile);
  const bad = [];
  for (const m of String(text).match(NUM_RE) || []) {
    const n = m.trim().replace(/[.,]$/, '');
    if (n.length < 2 && !n.includes('%')) continue; // ignore single digits like "3 steps"
    if (!base.includes(n.toLowerCase())) bad.push(n);
  }
  return [...new Set(bad)];
}

// Known skills/tools named in free text that the profile never mentions. This catches job-description
// keywords being sprinkled into a summary or bullet as if they were claimed experience.
function unsupportedSkillMentions(profile, text) {
  const mine = profileSkillSet(profile);
  const base = corpus(profile);
  const t = String(text).toLowerCase();
  return KNOWN_SKILLS.filter((k) => has(t, k) && !mine.has(k) && !has(base, k));
}

// Grounds the wording part of a CV (also used for manual edits). Facts come from the profile by id.
function groundContent(profile, t) {
  const warnings = [];
  const expIds = new Set(profile.experience.map((e) => e.id));
  const projIds = new Set(profile.projects.map((p) => p.id));
  const known = new Set(profile.skills.map(norm));
  const corp = norm(corpus(profile));

  const check = (label, text) => {
    const figs = unsupportedFigures(profile, text);
    if (figs.length) warnings.push(`${label}: figure(s) not found in your profile: ${figs.join(', ')}. Verify or remove.`);
    const sk = unsupportedSkillMentions(profile, text);
    if (sk.length) warnings.push(`${label}: mentions ${sk.join(', ')}, which your profile does not support. Remove it or add it to your profile if it is true.`);
  };

  const headline = String(t.headline || '').trim();
  check('Headline', headline);
  const summary = String(t.summary || '').trim();
  check('Summary', summary);

  const skills = [];
  for (const s of Array.isArray(t.skills) ? t.skills : []) {
    const k = norm(s);
    if (known.has(k) || (k.length > 2 && corp.includes(k))) skills.push(String(s));
    else warnings.push(`Removed skill "${s}": not in your profile.`);
  }

  const experience = [];
  for (const e of Array.isArray(t.experience) ? t.experience : []) {
    if (!expIds.has(e.id)) { warnings.push(`Dropped an experience entry with unknown id "${e.id}".`); continue; }
    const bullets = (Array.isArray(e.bullets) ? e.bullets : []).map(String).map((b) => b.trim()).filter(Boolean);
    bullets.forEach((b) => check('Experience bullet', b));
    experience.push({ id: e.id, bullets });
  }

  const projects = [];
  for (const p of Array.isArray(t.projects) ? t.projects : []) {
    if (!projIds.has(p.id)) { warnings.push(`Dropped a project with unknown id "${p.id}".`); continue; }
    check('Project', p.description || '');
    projects.push({ id: p.id, description: String(p.description || '') });
  }
  return { content: { headline: headline || profile.headline || '', summary, skills, experience, projects }, warnings: [...new Set(warnings)] };
}

// Full tailoring result: grounded content + explanations, keywords actually supported, and honest gaps.
function groundTailoredCv(profile, t, job) {
  const { content, warnings } = groundContent(profile, t);
  const corp = norm(corpus(profile));

  const keywords = [];
  for (const k of Array.isArray(t.keywords_used) ? t.keywords_used : []) {
    const word = String(k?.keyword ?? k).trim(); const nk = norm(word);
    if (nk.length > 1 && (corp.includes(nk) || profile.skills.map(norm).includes(nk))) keywords.push({ keyword: word, supported_by: String(k?.supported_by || '') });
    else if (word) warnings.push(`Keyword "${word}" was not applied: your profile does not support it.`);
  }

  const changes = (Array.isArray(t.changes) ? t.changes : []).map((c) => ({
    section: String(c.section || ''), change: String(c.change || ''), reason: String(c.reason || ''),
  })).filter((c) => c.change);

  // Gaps: the AI's view plus a deterministic keyword scan, so a gap is never hidden by a model omission.
  const gaps = (Array.isArray(t.gaps) ? t.gaps : []).map((g) => ({
    requirement: String(g.requirement || g), note: String(g.note || ''), source: 'ai',
  })).filter((g) => g.requirement);
  if (job) {
    const seen = new Set(gaps.map((g) => norm(g.requirement)));
    for (const m of matchJob(profile, job).missingSkills) {
      const already = gaps.some((x) => norm(x.requirement).includes(norm(m)));   // AI already said it in longer words
      if (!seen.has(norm(m)) && !already) gaps.push({ requirement: m, note: 'Named in the job text; not found in your profile.', source: 'keyword scan' });
    }
  }

  return { content, warnings, keywords, changes, gaps, notes: Array.isArray(t.notes) ? t.notes.map(String) : [] };
}

module.exports = { unsupportedFigures, unsupportedSkillMentions, groundContent, groundTailoredCv };
