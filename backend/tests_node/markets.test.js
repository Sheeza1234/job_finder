const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const credentials = require('../src/services/credentials');
const providers = require('../src/providers');
const { detectCountry, detectCity, buildJob } = require('../src/normalize');
const { buildQueries, runSearch } = require('../src/services/search');
const { listJobs } = require('../src/services/jobsStore');
const { startApp, newDb } = require('./helpers');

const jooble = providers.all.find((p) => p.id === 'jooble');
const SA_KEY = 'saudi-key-1111111111'; const PK_KEY = 'pakistan-key-2222222222';

// Fake Jooble: records which country address and key each request used, and answers with that country's jobs.
const realFetch = globalThis.fetch;
function fakeJooble(calls) {
  return async (url, init) => {
    if (/^http:\/\/127\.0\.0\.1/.test(String(url))) return realFetch(url, init);   // the test client talks to the app for real
    const u = new URL(String(url)); const body = JSON.parse(init.body);
    calls.push({ host: u.hostname, key: u.pathname.split('/').pop(), location: body.location });
    const pk = u.hostname === 'pk.jooble.org';
    return { ok: true, json: async () => ({ jobs: [{ id: pk ? 'p1' : 's1', title: 'Full Stack Developer', company: pk ? 'Systems Ltd' : 'Elm', location: pk ? 'Lahore' : 'Riyadh', snippet: 'React Node.js', link: 'https://x.test/' + u.hostname }] }) };
  };
}
async function withFetch(fn, impl) { const real = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } }
const setKeys = (sa, pk) => { config.joobleKey = sa; config.joobleKeyPk = pk; };

test('country is detected from the country name or a known city, in both markets', async () => {
  assert.equal(detectCountry('Lahore, Punjab'), 'Pakistan'); assert.equal(detectCountry('Karachi'), 'Pakistan'); assert.equal(detectCountry('Islamabad, Pakistan'), 'Pakistan');
  assert.equal(detectCountry('Riyadh'), 'Saudi Arabia'); assert.equal(detectCountry('Dammam, Saudi Arabia'), 'Saudi Arabia');
  assert.equal(detectCountry('Lahore, Saudi Arabia'), 'Saudi Arabia', 'an explicit country name wins over a city');
  assert.equal(detectCountry('Remote'), null); assert.equal(detectCity('Lahore'), 'Lahore');
  assert.equal(buildJob({ source: 'x', externalId: '1', title: 'Dev', locationText: 'Karachi' }).country, 'Pakistan');
  assert.equal(buildJob({ source: 'x', externalId: '2', title: 'Dev', locationText: 'Jeddah' }).country, 'Saudi Arabia');
});

test('queries cover each selected country, alternate between them, and use Arabic keywords only for Saudi Arabia', async () => {
  const q = buildQueries({ categories: ['Graphic Designer'], cities: ['Riyadh', 'Lahore'], includeRemote: true, arabic: true, markets: ['SA', 'PK'] });
  assert.deepEqual(q.filter((x) => !x.remote).map((x) => `${x.market}:${x.city}:${x.keyword}`),
    ['SA:Riyadh:graphic designer', 'PK:Lahore:graphic designer', 'SA:Riyadh:مصمم جرافيك']);
  assert.equal(q.filter((x) => x.remote).length, 2, 'one remote query per keyword, not per country');
  const onlyPk = buildQueries({ categories: ['Web Designer'], cities: ['Riyadh'], includeRemote: false, markets: ['PK'] });
  assert.deepEqual(onlyPk.map((x) => [x.market, x.city]), [['PK', null]], 'a Saudi city is ignored when only Pakistan is selected');
});

test('with a key for each country, one search queries both addresses and merges the results', async () => {
  const [oa, ob] = [config.joobleKey, config.joobleKeyPk]; setKeys(SA_KEY, PK_KEY);
  const db = await newDb(); const calls = [];
  try {
    const r = await withFetch(() => runSearch(db, { categories: ['Full Stack Developer'], cities: [], markets: ['SA', 'PK'], includeRemote: false }, [jooble]), fakeJooble(calls));
    assert.deepEqual(calls.map((c) => `${c.host}|${c.key}|${c.location}`).sort(), [`pk.jooble.org|${PK_KEY}|Pakistan`, `sa.jooble.org|${SA_KEY}|Saudi Arabia`].sort(), 'each country uses its own address and key');
    assert.equal(r.added, 2);
    const all = (await listJobs(db, {})).jobs;
    assert.deepEqual(all.map((j) => j.country).sort(), ['Pakistan', 'Saudi Arabia']);
    assert.deepEqual((await listJobs(db, { country: 'Pakistan' })).jobs.map((j) => j.company), ['Systems Ltd']);
  } finally { setKeys(oa, ob); }
});

test('a missing key skips only that country; results from a country that was not selected are dropped', async () => {
  const [oa, ob] = [config.joobleKey, config.joobleKeyPk];
  try {
    setKeys(SA_KEY, '');
    let db = await newDb(); let calls = [];
    let r = await withFetch(() => runSearch(db, { categories: ['Full Stack Developer'], markets: ['SA', 'PK'], includeRemote: false }, [jooble]), fakeJooble(calls));
    assert.deepEqual(calls.map((c) => c.host), ['sa.jooble.org'], 'no request to the Pakistan address without its key'); assert.deepEqual(r.providers[0].errors, []); assert.equal(r.added, 1);
    setKeys(SA_KEY, PK_KEY); db = await newDb(); calls = [];
    r = await withFetch(() => runSearch(db, { categories: ['Full Stack Developer'], markets: ['PK'], includeRemote: false }, [jooble]), fakeJooble(calls));
    assert.deepEqual(calls.map((c) => c.host), ['pk.jooble.org']); assert.deepEqual((await listJobs(db, {})).jobs.map((j) => j.country), ['Pakistan']);
  } finally { setKeys(oa, ob); }
});

test('both keys can be saved in the app (encrypted, write-only), enabling each country; the Pakistan key is tested on its own address', async () => {
  const old = config.appSecret; config.appSecret = 'test-secret-at-least-16-chars';
  const t = await startApp();
  try {
    assert.equal(jooble.enabled(), false);
    await t.call('PUT', '/api/settings/job-sources/jooble', { key: SA_KEY });
    assert.equal(jooble.supports({ market: 'SA' }), true); assert.equal(jooble.supports({ market: 'PK' }), false);
    const out = (await t.call('PUT', '/api/settings/job-sources/jooble_pk', { key: PK_KEY })).body;
    assert.deepEqual(out.filter((s) => s.hasKey).map((s) => s.id).sort(), ['jooble', 'jooble_pk']);
    assert.ok(!JSON.stringify(out).includes(PK_KEY) && !(await t.db.prepare("SELECT value FROM settings WHERE key = 'provider_keys'").get()).value.includes(PK_KEY));
    assert.equal(jooble.supports({ market: 'PK' }), true);
    const calls = [];
    const res = await withFetch(() => t.call('POST', '/api/integrations/jooble_pk/test'), fakeJooble(calls));
    assert.equal(res.status, 200); assert.deepEqual(calls.map((c) => `${c.host}|${c.key}`), [`pk.jooble.org|${PK_KEY}`]);
  } finally { await credentials.load(t.db); config.appSecret = old; await t.close(); }
});

test('settings: countries default to both, at least one is required; meta lists each country with its cities', async () => {
  const t = await startApp();
  try {
    assert.deepEqual((await t.call('GET', '/api/settings/search')).body.markets, ['SA', 'PK']);
    assert.equal((await t.call('PUT', '/api/settings/search', { markets: [] })).status, 400);
    assert.deepEqual((await t.call('PUT', '/api/settings/search', { markets: ['PK'] })).body.markets, ['PK']);
    const m = (await t.call('GET', '/api/meta')).body;
    assert.deepEqual(m.markets.map((x) => x.code), ['SA', 'PK']); assert.ok(m.markets[1].cities.includes('Lahore') && m.cities.includes('Riyadh') && m.cities.includes('Karachi'));
  } finally { await t.close(); }
});
