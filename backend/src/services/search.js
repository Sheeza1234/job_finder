const providers = require('../providers');
const { upsertJobs, getMode } = require('./jobsStore');
const health = { record: (...a) => require('./health').record(...a) };
const { CATEGORY_KEYWORDS } = require('./profile');

const { MARKETS, COUNTRIES, ALL_CITIES, marketOfCity } = require('../markets');
const SAUDI_CITIES = MARKETS.SA.cities;

// One query per title x market (x chosen city in that market), with the remote query once per title. Markets alternate so a
// query limit cannot starve the second country. Arabic keywords are only used for Saudi Arabia.
function buildQueries({ categories, cities, includeRemote, arabic, markets = ['SA'] }) {
  const queries = [];
  for (const cat of categories) {
    const kws = CATEGORY_KEYWORDS[cat] || [cat];
    const words = arabic ? kws : kws.slice(0, 1);
    for (const keyword of words) {
      for (const market of markets) {
        if (market !== 'SA' && keyword !== kws[0]) continue;
        const own = (cities || []).filter((c) => marketOfCity(c) === market);
        for (const city of own.length ? own : [null]) queries.push({ keyword, city, remote: false, market });
      }
      if (includeRemote) queries.push({ keyword: kws[0], city: null, remote: true, market: markets[0] });
    }
  }
  return queries;
}

async function pool(items, size, fn) {
  const results = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }));
  return results;
}

// Runs every enabled provider for each query; one failing provider never aborts the run.
async function runSearch(db, opts, providerList = providers.all) {
  if ((await getMode(db)) === 'demo') throw Object.assign(new Error('Demo mode shows sample data only. Switch to production in Settings to search real job sources.'), { status: 409 });
  const maxQueries = Math.min(Number(opts.maxQueries) || 12, 40);
  const markets = (opts.markets?.length ? opts.markets : ['SA']).filter((m) => MARKETS[m]);
  const countries = markets.map((m) => MARKETS[m].country);
  const queries = buildQueries({
    categories: opts.categories?.length ? opts.categories : [], cities: opts.cities || [],
    includeRemote: opts.includeRemote !== false, arabic: !!opts.arabic, markets,
  }).slice(0, maxQueries);

  const report = providerList.map((p) => ({ id: p.id, enabled: p.enabled(), fetched: 0, errors: [] }));
  const tasks = [];
  providerList.forEach((p, pi) => {
    if (!p.enabled()) return;
    for (const q of queries) {
      if (p.remoteOnly && !q.remote) continue; // remote-only sources: one query per keyword
      if (q.remote && p.id === 'jooble') continue;
      if (p.supports && !p.supports(q)) continue;      // e.g. Jooble without a key for that country
      tasks.push({ p, pi, q });
    }
  });

  const all = [];
  await pool(tasks, 4, async ({ p, pi, q }) => {
    try {
      const jobs = await p.search(q);
      report[pi].fetched += jobs.length; all.push(...jobs);
    } catch (e) {
      report[pi].errors.push(`${q.keyword}${q.city ? ' / ' + q.city : ''}: ${e.message}`);
    }
  });

  for (const r of report) if (r.enabled) await health.record(db, r.id, !(r.errors.length && !r.fetched), r.errors[0]);
  const eligible = all.filter((j) => countries.includes(j.country) || (j.work_mode === 'remote' && j.remote_eligibility !== 'restricted'));
  // Provider searches are loose ("developer" also returns office assistants), so keep only jobs that fit a role the candidate has or wants.
  const kept = opts.relevance ? eligible.filter(opts.relevance) : eligible;
  const newIds = [];
  const added = await upsertJobs(db, kept, newIds);
  return { queries: queries.length, fetched: all.length, kept: kept.length, filtered_out: eligible.length - kept.length, added, newIds, providers: report };
}

module.exports = { runSearch, buildQueries, SAUDI_CITIES, ALL_CITIES, COUNTRIES };
