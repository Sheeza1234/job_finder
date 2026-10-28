// Remotive public API (no key). Remote jobs only; we keep those a candidate in
// Pakistan / relocating to KSA could plausibly apply to (not region-restricted).
const { fetchJson } = require('./http');
const { buildJob, remoteEligibility } = require('../normalize');

module.exports = {
  id: 'remotive',
  label: 'Remotive (remote jobs)',
  remoteOnly: true,
  enabled: () => true,
  async search({ keyword }) {
    const url = `https://remotive.com/api/remote-jobs?limit=50&search=${encodeURIComponent(keyword)}`;
    const data = await fetchJson(url);
    return (data.jobs || [])
      .filter((j) => remoteEligibility(j.candidate_required_location) !== 'restricted')
      .map((j) => {
        const sal = parseSalary(j.salary);
        return buildJob({
          source: 'remotive', externalId: j.id, url: j.url, title: j.title, company: j.company_name,
          locationText: `Remote (${j.candidate_required_location || 'unspecified'})`,
          description: j.description, workModeHint: 'remote', remoteRestriction: j.candidate_required_location,
          employmentHint: ({ full_time: 'full_time', part_time: 'part_time', contract: 'contract', freelance: 'contract' })[j.job_type] || 'unknown',
          industry: j.category, postedAt: j.publication_date, skills: j.tags || [],
          salaryMin: sal.min, salaryMax: sal.max, salaryCurrency: sal.currency,
        });
      });
  },
};

function parseSalary(s) {
  if (!s) return {};
  const nums = String(s).replace(/,/g, '').match(/\d+(\.\d+)?k?/gi) || [];
  const vals = nums.map((n) => (/k$/i.test(n) ? parseFloat(n) * 1000 : parseFloat(n))).filter((n) => n >= 100);
  const currency = /\$|usd/i.test(s) ? 'USD' : /€|eur/i.test(s) ? 'EUR' : /£|gbp/i.test(s) ? 'GBP' : /sar|ريال/i.test(s) ? 'SAR' : undefined;
  return { min: vals[0], max: vals[1] ?? vals[0], currency };
}
module.exports.parseSalary = parseSalary;
