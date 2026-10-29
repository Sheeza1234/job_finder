// Remote OK public feed (no key). One feed for every keyword, so it is fetched once a minute and filtered here.
// Their terms ask for a visible link back to Remote OK; the Jobs page shows the source name on every card.
const { fetchJson } = require('./http');
const { buildJob, remoteEligibility } = require('../normalize');

let cache = { at: 0, jobs: null };
async function feed() {
  if (cache.jobs && Date.now() - cache.at < 60000) return cache.jobs;
  const data = await fetchJson('https://remoteok.com/api', { headers: { 'User-Agent': 'job-finder personal use' } }, 25000);
  cache = { at: Date.now(), jobs: (Array.isArray(data) ? data : []).filter((j) => j.position) };
  return cache.jobs;
}

module.exports = {
  id: 'remoteok',
  label: 'Remote OK (remote jobs)',
  remoteOnly: true,
  enabled: () => true,
  async search({ keyword }) {
    const words = String(keyword).toLowerCase().split(/\s+/).filter(Boolean);
    return (await feed())
      .filter((j) => {
        const hay = `${j.position} ${(j.tags || []).join(' ')}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .filter((j) => remoteEligibility(j.location) !== 'restricted')
      .slice(0, 50)
      .map((j) => buildJob({
        source: 'remoteok', externalId: j.id, url: j.url || j.apply_url, title: j.position, company: j.company,
        locationText: j.location ? `Remote (${j.location})` : 'Remote', description: j.description, workModeHint: 'remote',
        remoteRestriction: j.location || 'worldwide', postedAt: j.date, skills: j.tags || [],
        salaryMin: j.salary_min || undefined, salaryMax: j.salary_max || undefined, salaryCurrency: j.salary_min ? 'USD' : undefined,
      }));
  },
};
