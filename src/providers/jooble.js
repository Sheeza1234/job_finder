// Jooble API. Keys are issued per country domain, so each market has its own key and address:
// Saudi Arabia -> sa.jooble.org (free key: https://jooble.org/api/about), Pakistan -> pk.jooble.org (https://pk.jooble.org/api/about).
// A Saudi key is refused by the Pakistan address (HTTP 403) and the other way round.
const { fetchJson } = require('./http');
const { buildJob } = require('../normalize');
const config = require('../config');
const credentials = require('../services/credentials');
const { MARKETS } = require('../markets');
const { parseSalary } = require('./remotive');

const keyFor = (market) => (market === 'PK' ? credentials.get('jooble_pk') || config.joobleKeyPk : credentials.get('jooble') || config.joobleKey);

module.exports = {
  id: 'jooble',
  label: 'Jooble (job aggregator)',
  enabled: () => !!(keyFor('SA') || keyFor('PK')),
  // Can this source answer a query for this market? (Needs that country's key.)
  supports: (q) => !!keyFor(q?.market || 'SA'),
  async search({ keyword, city, market = 'SA' }) {
    const m = MARKETS[market] || MARKETS.SA;
    const location = city ? `${city}, ${m.country}` : m.country;
    const data = await fetchJson(`https://${m.jooble}/api/${keyFor(m.code)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: keyword, location, page: 1 }),
    });
    return (data.jobs || []).map((j) => {
      const sal = parseSalary(j.salary);
      return buildJob({
        source: 'jooble', externalId: j.id, url: j.link, title: j.title, company: j.company,
        locationText: j.location || location, description: j.snippet, employmentHint: undefined,
        postedAt: j.updated, salaryMin: sal.min, salaryMax: sal.max,
        salaryCurrency: sal.currency || (sal.min ? (m.code === 'PK' ? 'PKR' : 'SAR') : undefined),
      });
    });
  },
};
