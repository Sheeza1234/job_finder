// Browser tests of the real UI against a local server. Skipped when Chrome isn't installed.
// They never click "Fetch" (no network), never submit anything, and use no AI.
const test = require('node:test');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const config = require('../src/config');
const { startApp, SAMPLE_PROFILE } = require('./helpers');

const skip = !config.chromePath && 'Chrome not installed';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWS = ['dashboard', 'jobs', 'studio', 'applications', 'searchsettings', 'profile', 'documents', 'settings'];

async function withPage(fn, { profile = true, width = 1300, tolerate5xx = false } = {}) {
  const t = await startApp();
  if (profile) await t.call('PUT', '/api/profile', SAMPLE_PROFILE);
  const browser = await puppeteer.launch({ executablePath: config.chromePath, headless: true, args: config.chromeArgs.length ? config.chromeArgs : ['--no-sandbox'] });
  const page = await browser.newPage(); await page.setViewport({ width, height: 1000 });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('dialog', async (d) => { problems.push(`native dialog used: ${d.message().slice(0, 50)}`); await d.dismiss(); });
  page.on('request', (r) => { if (!r.url().startsWith(t.base) && !r.url().startsWith('data:')) problems.push(`external request: ${r.url()}`); });
  const nav = async (v) => {
    if (await page.$(`nav button[data-view=${v}]`)) await page.click(`nav button[data-view=${v}]`);
    else if (v === 'documents') { await page.click('nav button[data-view=studio]'); await sleep(700); await page.click('a ::-p-text(Manage my other files)'); }   // reached through the UI, as a user would
    else throw new Error(`no way to reach ${v}`);
    await sleep(700);
  };
  const text = (sel) => page.$eval(sel, (e) => e.innerText);
  try { await page.goto(t.base); await page.waitForSelector('#view .card, #view .stats, #view .onboard', { timeout: 8000 }); await fn({ page, t, nav, text, problems }); }
  finally { await browser.close(); await t.close(); }
  assert.deepEqual(problems.filter((p) => !(/status of 4\d\d/.test(p) || (tolerate5xx && /status of 5\d\d/.test(p)))), [], 'no script errors, native dialogs or external requests');
}

test('first run: one clear next step, honest empty states, no invented data', { skip }, () => withPage(async ({ page, text, nav }) => {
  const o = await text('.onboard'); assert.match(o, /Step 1: upload your CV/); assert.match(o, /0 of 4 done/); assert.ok(await page.$('.onboard input[type=file]'), 'the upload is right on the Home page');
  assert.match(o, /Fill in my profile by hand/);
  const m = await text('main'); assert.match(m, /No jobs yet/); assert.match(m, /Nothing is made up/); assert.ok(!/\[DEMO\]/.test(m));
  await nav('jobs'); assert.match(await text('main'), /Nothing is shown until it is real/);
}, { profile: false }));

test('demo mode: confirmed via dialog, banner never covers the navigation, labelled data, cleanly reversible', { skip }, () => withPage(async ({ page, nav, text }) => {
  await nav('settings');
  await page.click('summary ::-p-text(Advanced)'); await sleep(200);
  await page.click('button ::-p-text(Try demo mode)'); await sleep(300);
  assert.match(await text('dialog[open]'), /clearly labelled/);
  await page.click('dialog[open] button ::-p-text(Switch to demo mode)'); await sleep(1200);
  assert.equal(await page.$eval('#demoBanner', (e) => e.hidden), false);
  // regression: the banner once sat on top of the nav and swallowed clicks
  for (const v of VIEWS.filter((x) => x !== 'documents')) {
    const covered = await page.$eval(`nav button[data-view=${v}]`, (b) => { const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !(el === b || b.contains(el)); });
    assert.equal(covered, false, `${v} nav button is clickable in demo mode`);
  }
  await nav('jobs'); const jobs = await text('.split'); assert.ok(jobs.includes('[DEMO]') && jobs.includes('(demo)'));
  await page.click('.jobcard'); await sleep(700); const d = await text('.split'); assert.ok(d.includes('DEMO LISTING') && !d.includes('Open original posting'));
  assert.ok((await page.$$eval('.meter', (e) => e.map((x) => x.getAttribute('aria-label')))).every((a) => /percent, (Strong|Good|Fair|Weak) match/.test(a)));
  await page.click('#exitDemo'); await sleep(300);
  assert.equal(await page.$eval('dialog[open]', (e) => e.classList.contains('danger')), true, 'leaving demo deletes sample data, so it is flagged destructive');
  await page.keyboard.press('Escape'); await sleep(200); assert.equal(await page.$('dialog[open]'), null);
  assert.equal(await page.$eval('#demoBanner', (e) => e.hidden), false, 'Esc changes nothing');
  await page.click('#exitDemo'); await sleep(300); await page.click('dialog[open] button ::-p-text(Switch to production)'); await sleep(1200);
  assert.equal(await page.$eval('#demoBanner', (e) => e.hidden), true);
  await nav('jobs'); assert.ok(!(await text('main')).includes('[DEMO]'));
}));

test('navigation: a slow screen never overwrites the one you moved to', { skip }, () => withPage(async ({ page, text }) => {
  await page.click('nav button[data-view=dashboard]'); await page.click('nav button[data-view=applications]'); await page.click('nav button[data-view=jobs]'); await sleep(1500);
  assert.match(await text('main'), /Search jobs/);
  assert.equal(await page.$eval('nav button.active', (e) => e.dataset.view), 'jobs');
}));

test('destructive actions need typed confirmation; Cancel does nothing', { skip }, () => withPage(async ({ page, nav, text, t }) => {
  await nav('settings');
  await page.click('button ::-p-text(Delete all my data)'); await sleep(300);
  assert.equal(await page.$eval('dialog[open] button.danger', (e) => e.disabled), true);
  await page.type('dialog[open] input', 'delete my data'); assert.equal(await page.$eval('dialog[open] button.danger', (e) => e.disabled), true, 'case must match');
  await page.click('dialog[open] button ::-p-text(Cancel)'); await sleep(200);
  assert.equal((await t.call('GET', '/api/profile')).body.fullName, 'Test Candidate');
}));

test('accessibility: every control is labelled, skip link and current-page marking exist', { skip }, () => withPage(async ({ page, nav }) => {
  await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.activeElement.classList.contains('skip')));
  const bad = [];
  for (const v of VIEWS) {
    await nav(v);
    if (v !== 'documents') assert.equal(await page.$eval('nav button.active', (e) => e.getAttribute('aria-current')), 'page');
    bad.push(...(await page.evaluate((view) => [...document.querySelectorAll('main input, main select, main textarea')].filter((el) => el.type !== 'hidden' && !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map((el) => `${view}: ${el.tagName} ${el.placeholder || el.type}`), v)));
  }
  assert.deepEqual(bad, []);
}));

test('responsive: no horizontal overflow on a phone-width screen', { skip }, () => withPage(async ({ page, nav }) => {
  const over = [];
  for (const v of VIEWS) { await nav(v); const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (o > 2) over.push(`${v}:${o}px`); }
  assert.deepEqual(over, []);
}, { width: 390 }));

test('errors are shown as a recoverable state, not a blank screen', { skip }, () => withPage(async ({ page, text, t }) => {
  const real = t.db.prepare.bind(t.db);
  t.db.prepare = (sql) => { if (/FROM applications a JOIN jobs j ON j.id = a.job_id WHERE/.test(sql) && !t.db.__off) throw new Error('simulated failure'); return real(sql); };
  const quiet = console.error; console.error = () => {};
  try {
    await page.click('nav button[data-view=dashboard]'); await sleep(900);
    assert.match(await text('main'), /Something went wrong/); assert.match(await text('main'), /Try again/);
    t.db.__off = true; await page.click('button ::-p-text(Try again)'); await sleep(900);
    assert.match(await text('main'), /at a glance/);
  } finally { console.error = quiet; t.db.prepare = real; }
}, { tolerate5xx: true }));

test('upload a CV: profile fills itself, only missing fields are highlighted, manual editing and undo work', { skip }, async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const ai = require('../src/services/ai'); const { fakeAi } = require('./helpers');
  const file = path.join(os.tmpdir(), `jf-cv-${Date.now()}.txt`);
  fs.writeFileSync(file, 'Layla Hassan\nRiyadh, Saudi Arabia | +966 50 123 4567 | layla.hassan@example.com\nGraphic Designer at Studio Nine');
  ai.setClient(fakeAi({ fullName: 'Layla Hassan', headline: 'Graphic Designer', location: 'Riyadh, Saudi Arabia', skills: ['Figma', 'Photoshop'],
    experience: [{ title: 'Graphic Designer', company: 'Studio Nine', start: '2019-01', end: '2023-06', bullets: ['Designed brand identities'] }], education: [{ degree: 'BA Design', institution: 'KSU' }] }));
  try {
    await withPage(async ({ page, nav, text, t }) => {
      await nav('documents');
      await (await page.$('main input[type=file]')).uploadFile(file);
      await page.click('main button ::-p-text(Upload)'); await page.waitForSelector('dialog[open]', { timeout: 8000 });
      const d = await text('dialog[open]');
      assert.match(d, /Your profile was filled from your CV/); assert.match(d, /✓ Full name/); assert.match(d, /Skills \(2 added\)/);
      assert.match(d, /Still missing: Professional summary/); assert.match(d, /can make mistakes/);
      await page.click('dialog[open] button ::-p-text(Review & add missing)'); await sleep(900);
      assert.equal(await page.$eval('input[type=email]', (e) => e.value), 'layla.hassan@example.com');
      const banner = await text('main'); assert.match(banner, /Filled automatically from jf-cv-/); assert.match(banner, /Still missing: Professional summary/);
      assert.equal((await page.$$('.needs')).length, 1, 'only the missing field is highlighted');
      assert.equal(await page.$eval('.needs textarea', (e) => e.value), '');
      // add the missing detail by hand
      await page.type('.needs textarea', 'Designer focused on branding.'); await page.click('button ::-p-text(Save profile)'); await sleep(900);
      assert.match(await page.$$eval('.warn, .good', (els) => els.map((e) => e.innerText).join(' / ')), /All the essentials are filled in/); assert.equal((await page.$$('.needs')).length, 0);
      assert.equal((await t.call('GET', '/api/profile')).body.summary, 'Designer focused on branding.');
      // undo
      await page.click('button ::-p-text(Undo auto-fill)'); await sleep(300);
      await page.click('dialog[open] button ::-p-text(Undo auto-fill)'); await sleep(900);
      assert.equal((await t.call('GET', '/api/profile')).body.fullName, '');
      assert.match(await text('main'), /Still missing: .*Full name/);
    }, { profile: false });
  } finally { ai.setClient(null); fs.rmSync(file, { force: true }); }
});

test('Profile offers both paths: upload a CV right there to fetch details, or fill in manually', { skip }, async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const ai = require('../src/services/ai'); const { fakeAi } = require('./helpers');
  const file = path.join(os.tmpdir(), `jf-cv2-${Date.now()}.txt`);
  fs.writeFileSync(file, 'Omar Saleh\nJeddah | +966 50 111 2222 | omar@example.com');
  ai.setClient(fakeAi({ fullName: 'Omar Saleh', headline: 'Web Designer', skills: ['Figma'] }));
  try {
    await withPage(async ({ page, nav, text, t }) => {
      await nav('profile');
      const m = await text('main'); assert.match(m, /Option 1: fetch details from your CV/); assert.match(m, /Option 2: add details manually/);
      assert.match(m, /Upload CV & fetch my details/);
      await (await page.$('.choicebox input[type=file]')).uploadFile(file);
      await page.click('.choicebox button ::-p-text(Upload CV & fetch my details)'); await page.waitForSelector('dialog[open]', { timeout: 8000 });
      assert.match(await text('dialog[open]'), /Your profile was filled from your CV/);
      await page.click('dialog[open] button ::-p-text(Close)'); await sleep(900);
      assert.equal(await page.$eval('input[type=email]', (e) => e.value), 'omar@example.com');
      assert.equal((await t.call('GET', '/api/profile')).body.fullName, 'Omar Saleh');
      // manual path still works for anything missing
      await page.type('.needs textarea', 'Added by hand.'); await page.click('button ::-p-text(Save profile)'); await sleep(800);
      assert.equal((await t.call('GET', '/api/profile')).body.summary, 'Added by hand.');
    }, { profile: false });
  } finally { ai.setClient(null); fs.rmSync(file, { force: true }); }
});

test('job-title tags: suggested from the CV with reasons, easy to remove and add, saved only on Save', { skip }, async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const ai = require('../src/services/ai'); const { fakeAi } = require('./helpers');
  const file = path.join(os.tmpdir(), `jf-cv3-${Date.now()}.txt`);
  fs.writeFileSync(file, 'Sara Ali\nsara@example.com +966 50 222 3333\nUI/UX Designer. Figma, prototyping, user research, Photoshop, branding, SEO.');
  ai.setClient(fakeAi({ fullName: 'Sara Ali', headline: 'UI/UX Designer', skills: ['Figma'], keywords: ['Figma', 'branding'],
    suggested_titles: [{ title: 'UI/UX Designer', reason: 'Figma and user research', evidence: ['figma', 'user research'] }, { title: 'Brand Designer', reason: 'branding', evidence: ['branding'] }] }));
  try {
    await withPage(async ({ page, nav, text, t }) => {
      await nav('profile');
      await (await page.$('.choicebox input[type=file]')).uploadFile(file);
      await page.click('.choicebox button ::-p-text(Upload CV & fetch my details)'); await page.waitForSelector('dialog[open]', { timeout: 8000 });
      assert.match(await text('dialog[open]'), /Target job titles \(2 suggested\)/);
      await page.click('dialog[open] button ::-p-text(Close)'); await sleep(900);
      const tags = () => page.$$eval('.tag', (e) => e.map((x) => x.innerText.replace('×', '').trim()));
      assert.deepEqual(await tags(), ['UI/UX Designer', 'Brand Designer']);
      assert.match(await text('main'), /Keywords we found in your CV/);
      assert.equal(await page.$$eval('.pill', (e) => e.some((x) => x.innerText === 'figma')), true);
      // remove one, add a custom one with Enter: nothing is saved until Save
      await page.click('button[aria-label="Remove Brand Designer"]');
      await page.type('input[aria-label="Add a job title"]', 'Product Designer'); await page.keyboard.press('Enter');
      assert.deepEqual(await tags(), ['UI/UX Designer', 'Product Designer']);
      assert.deepEqual((await t.call('GET', '/api/profile')).body.preferredTitles, ['UI/UX Designer', 'Brand Designer'], 'not saved yet');
      assert.equal(await page.$eval('.savebar', (e) => e.classList.contains('dirty')), true, 'the page shows there are unsaved changes');
      await page.click('.savebar button'); await sleep(900);
      assert.deepEqual((await t.call('GET', '/api/profile')).body.preferredTitles, ['UI/UX Designer', 'Product Designer']);
      assert.deepEqual((await t.call('GET', '/api/profile')).body.categories, []);
      // suggestions with reasons, one click to add
      await page.click('button ::-p-text(Suggest job titles from my CV)'); await sleep(1200);
      assert.match(await text('main'), /Suggested from your CV/); assert.match(await text('main'), /Figma and user research/);
      assert.equal(await page.$eval('button.sugg[data-title="UI/UX Designer"]', (b) => b.disabled), true, 'already a tag');
      await page.click('button.sugg[data-title="Brand Designer"]'); assert.deepEqual(await tags(), ['UI/UX Designer', 'Product Designer', 'Brand Designer']);
    }, { profile: false });
  } finally { ai.setClient(null); fs.rmSync(file, { force: true }); }
});

test('simple by default: Jobs filters are tucked under "More filters"; Preferences and Settings hide technical options', { skip }, () => withPage(async ({ page, nav, text }) => {
  await nav('jobs');
  assert.equal(await page.$eval('main details', (d) => d.open), false); assert.match(await text('main'), /Find new jobs online/);
  assert.equal(await page.$$eval('main > div .grid label, main .grid label', (l) => l.some((x) => x.offsetParent !== null && /Lowest salary/.test(x.innerText))), false, 'salary etc. are hidden until asked for');
  await nav('searchsettings'); const pref = await text('main');
  for (const w of ['What jobs do you want?', 'Look for new jobs for me', 'Tell me when…', 'Only strong matches']) assert.ok(pref.includes(w), w);
  assert.equal(await page.$eval('details.optional', (d) => d.open), false);
  await nav('settings'); const set = await text('main');
  assert.ok(set.includes('Email me') && set.includes('Privacy and my data'));
  assert.equal(await page.$eval('details.optional', (d) => d.open), false, 'technical status and demo mode are under Advanced');
  assert.ok(!/ANTHROPIC|Production readiness/.test(await page.$eval('main', (m) => [...m.children].filter((c) => !c.matches('details')).map((c) => c.innerText).join(' '))), 'no technical jargon in the main part');
}));

test('Jobs page is upfront when no Saudi or Pakistani job source is connected, and the Settings card explains how to fix it', { skip }, () => withPage(async ({ page, nav, text }) => {
  await nav('jobs');
  assert.match(await text('.warn'), /only seeing remote jobs/); assert.match(await text('.warn'), /Jooble is free/);
  assert.match(await text('main'), /Only show jobs that fit me/);
  await page.click('.warn button ::-p-text(Connect job sources)'); await sleep(900);
  const m = await text('main'); assert.match(m, /Find jobs in Saudi Arabia and Pakistan/); assert.match(m, /Job sources for Saudi Arabia and Pakistan are not connected yet/); assert.match(m, /Jooble Pakistan/); assert.match(m, /Not connected/);
  assert.ok(await page.$('input[aria-label="Jooble API key"]'));
}));

// Responsive: at phone, tablet and desktop widths no page may spill past the screen (scroll containers excepted).
for (const width of [360, 768, 1300]) {
  test(`layout holds at ${width}px on every page`, { skip }, () => withPage(async ({ page, nav, t }) => {
    // Real-world content is what breaks layouts: very long titles/words, several jobs, a tracked application.
    const long = 'Senior Full-Stack Software Engineering Lead (React/Node/AWS) — Digital Transformation Programme';
    let jobId;
    for (let i = 0; i < 4; i++) {
      const r = await t.call('POST', '/api/jobs/import', { title: `${long} ${i}`, company: 'Extraordinarily-Long-Company-Name-For-Testing-Wrapping Holding Ltd', location: 'Riyadh, Saudi Arabia', url: `https://example.com/${'very-long-path-segment-'.repeat(6)}${i}`, text: `A genuine job description for testing the layout with React Node and a_very_long_unbroken_token_${'x'.repeat(80)} in Riyadh.` });
      jobId = r.body.id;
    }
    await t.call('POST', '/api/applications', { job_id: jobId });
    for (const v of VIEWS) {
      await nav(v);
      const spill = await page.evaluate(() => {
        const W = document.documentElement.clientWidth, out = [];
        const scrolls = (el) => { for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
        for (const el of document.querySelectorAll('main *, header *')) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > W + 1 && !scrolls(el) && getComputedStyle(el).position !== 'fixed') out.push(`${el.tagName}.${el.className} right=${Math.round(r.right)}`);
        }
        return out.slice(0, 5);
      });
      assert.deepEqual(spill, [], `${v} at ${width}px has content past the screen edge`);
    }
  }, { width }));
}

test('Jobs page offers Bayt, GulfTalent, NaukriGulf and Sabbar as site-limited searches in a new tab, never scraped', { skip }, () => withPage(async ({ page, nav }) => {
  await nav('jobs');
  await page.click('summary ::-p-text(Also search Bayt)'); await sleep(200);
  const links = await page.$$eval('main a[href*="google.com/search"]', (a) => a.map((x) => ({ t: x.innerText.replace(' ↗', ''), h: decodeURIComponent(x.href), target: x.target, rel: x.rel })));
  assert.deepEqual(links.map((l) => l.t), ['Bayt', 'GulfTalent', 'NaukriGulf', 'Sabbar']);
  for (const l of links) { assert.equal(l.target, '_blank'); assert.match(l.rel, /noopener/); assert.match(l.h, /Saudi Arabia/); }
  assert.match(links[0].h, /site:bayt\.com .*jobs/); assert.match(links[3].h, /site:sabbar\.com/);
  assert.match(await page.$eval('main', (m) => m.innerText), /do not allow apps to collect their jobs automatically/);
}));
