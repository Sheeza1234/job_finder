// Himalayas public API (no key). Remote jobs only; jobs tied to a country list are kept only when they name Pakistan, Saudi Arabia or a wide region.
const { fetchJson } = require('./http');
const { buildJob, remoteEligibility } = require('../normalize');

const TYPES = { 'full time': 'full_time', 'part time': 'part_time', contractor: 'contract', contract: 'contract', intern: 'internship', temporary: 'contract' };
const PERIODS = { hourly: 2000, daily: 250, weekly: 52, monthly: 12, yearly: 1 };

module.exports = {
  id: 'himalayas',
  label: 'Himalayas (remote jobs)',
  remoteOnly: true,
  enabled: () => true,
  async search({ keyword }) {
    const data = await fetchJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(keyword)}`);
    return (data.jobs || [])
      .filter((j) => {
        const where = (j.locationRestrictions || []).join(', ');
        return !where || remoteEligibility(where) !== 'restricted';
      })
      .map((j) => {
        const yearly = PERIODS[j.salaryPeriod] || 1;
        return buildJob({
          source: 'himalayas', externalId: j.guid, url: j.applicationLink || j.guid, title: j.title, company: j.companyName,
          locationText: (j.locationRestrictions || []).length ? `Remote (${j.locationRestrictions.join(', ')})` : 'Remote (worldwide)', description: j.description || j.excerpt,
          workModeHint: 'remote', remoteRestriction: (j.locationRestrictions || []).join(', '),
          employmentHint: TYPES[String(j.employmentType || '').toLowerCase()] || 'unknown',
          industry: (j.parentCategories || [])[0], postedAt: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : undefined,
          skills: j.categories || [],
          salaryMin: j.minSalary ? j.minSalary * yearly : undefined, salaryMax: j.maxSalary ? j.maxSalary * yearly : undefined,
          salaryCurrency: j.minSalary ? j.currency : undefined,
        });
      });
  },
};
