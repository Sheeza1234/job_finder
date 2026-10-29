const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../src/normalize');

test('sponsorship defaults to not_specified', async () => {
  assert.equal(n.detectSponsorship('Great role in Riyadh, competitive salary'), 'not_specified');
});
test('sponsorship detected only when explicit', async () => {
  assert.equal(n.detectSponsorship('Visa sponsorship is available'), 'yes');
  assert.equal(n.detectSponsorship('We will provide a work visa for the right hire'), 'yes');
  assert.equal(n.detectSponsorship('نوفر تأشيرة عمل للمرشح المناسب'), 'yes');
});
test('negative sponsorship wins over positive wording', async () => {
  assert.equal(n.detectSponsorship('No visa sponsorship available'), 'no');
  assert.equal(n.detectSponsorship('We are unable to sponsor visas'), 'no');
  assert.equal(n.detectSponsorship('Must have a valid Saudi iqama'), 'no');
});
test('relocation detection', async () => {
  assert.equal(n.detectRelocation('Relocation package offered'), 'yes');
  assert.equal(n.detectRelocation('No relocation assistance'), 'no');
  assert.equal(n.detectRelocation('Based in Jeddah'), 'not_specified');
});
test('cities in English and Arabic', async () => {
  assert.equal(n.detectCity('Riyadh, Saudi Arabia'), 'Riyadh');
  assert.equal(n.detectCity('جدة'), 'Jeddah');
  assert.equal(n.detectCity('Al-Khobar'), 'Al Khobar');
  assert.equal(n.detectCity('The Line, NEOM'), 'NEOM');
  assert.equal(n.detectCity('Dubai, UAE'), null);
});
test('remote eligibility', async () => {
  assert.equal(n.remoteEligibility('Worldwide'), 'worldwide');
  assert.equal(n.remoteEligibility('USA Only'), 'restricted');
  assert.equal(n.remoteEligibility('Middle East'), 'worldwide');
});
test('buildJob marks Saudi jobs and strips html', async () => {
  const j = n.buildJob({ source: 's', externalId: 1, title: 'Web Designer', locationText: 'Jeddah, Saudi Arabia', description: '<p>Hybrid role. 3 years experience</p>' });
  assert.equal(j.country, 'Saudi Arabia'); assert.equal(j.city, 'Jeddah');
  assert.equal(j.work_mode, 'hybrid'); assert.equal(j.experience_level, 'mid');
  assert.ok(!j.description.includes('<p>'));
});
test('non-Saudi non-remote jobs get no country', async () => {
  assert.equal(n.buildJob({ source: 's', externalId: 2, title: 'Dev', locationText: 'Berlin, Germany', description: 'x' }).country, null);
});
