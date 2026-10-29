// JSearch via RapidAPI (Google for Jobs index). Needs RAPIDAPI_KEY.
const { fetchJson } = require('./http');
const { buildJob } = require('../normalize');
const config = require('../config');
const credentials = require('../services/credentials');
const key = () => credentials.get('jsearch') || config.rapidApiKey;

const { MARKETS } = require('../markets');

const TYPE = { FULLTIME: 'full_time', PARTTIME: 'part_time', CONTRACTOR: 'contract', INTERN: 'internship' };

module.exports = {
  id: 'jsearch',
  label: 'JSearch (Google for Jobs)',
  enabled: () => !!key(),
  supports: () => true,
  async search({ keyword, city, remote, market = 'SA' }) {
    const m = MARKETS[market] || MARKETS.SA;
    const q = remote ? `${keyword} remote` : `${keyword} in ${city ? city + ', ' : ''}${m.country}`;
    const params = new URLSearchParams({ query: q, page: '1', num_pages: '1', country: m.jsearch });
    if (remote) params.set('work_from_home', 'true');
    const data = await fetchJson(`https://jsearch.p.rapidapi.com/search?${params}`, {
      headers: { 'X-RapidAPI-Key': key(), 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
    });
    return (data.data || []).map((j) => buildJob({
      source: 'jsearch', externalId: j.job_id, url: j.job_apply_link || j.job_google_link,
      title: j.job_title, company: j.employer_name,
      locationText: [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || (j.job_is_remote ? 'Remote' : ''),
      description: j.job_description, employmentHint: TYPE[j.job_employment_type],
      workModeHint: j.job_is_remote ? 'remote' : undefined, postedAt: j.job_posted_at_datetime_utc,
      salaryMin: j.job_min_salary, salaryMax: j.job_max_salary, salaryCurrency: j.job_salary_currency,
      skills: j.job_required_skills || [],
    }));
  },
};
