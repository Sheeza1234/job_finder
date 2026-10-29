// Jobicy public API (no key). Remote jobs only. Their terms ask for a credit link and for apply buttons to use the job URL from the feed.
const { fetchJson } = require('./http');
const { buildJob, remoteEligibility } = require('../normalize');

const TYPES = { 'full-time': 'full_time', 'part-time': 'part_time', contract: 'contract', freelance: 'contract', internship: 'internship' };

module.exports = {
  id: 'jobicy',
  label: 'Jobicy (remote jobs)',
  remoteOnly: true,
  enabled: () => true,
  async search({ keyword }) {
    const data = await fetchJson(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${encodeURIComponent(keyword)}`);
    return (data.jobs || [])
      .filter((j) => remoteEligibility(j.jobGeo) !== 'restricted')
      .map((j) => buildJob({
        source: 'jobicy', externalId: j.id, url: j.url, title: j.jobTitle, company: j.companyName,
        locationText: j.jobGeo ? `Remote (${j.jobGeo})` : 'Remote', description: j.jobDescription || j.jobExcerpt,
        workModeHint: 'remote', remoteRestriction: j.jobGeo || 'worldwide',
        employmentHint: TYPES[String((j.jobType || [])[0] || '').toLowerCase()] || 'unknown',
        industry: (j.jobIndustry || [])[0], postedAt: j.pubDate,
      }));
  },
};
