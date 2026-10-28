const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const ai = require('../src/services/ai');
const { startApp, SAMPLE_PROFILE, SAMPLE_JOB } = require('./helpers');

// A local stand-in for an OpenAI-compatible gateway (e.g. OmniRoute).
function gateway(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => { const r = { url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null }; seen.push(r); handler(r, res); });
  }).listen(0);
  return { srv, seen, base: `http://127.0.0.1:${srv.address().port}/v1` };
}
const reply = (text) => (_r, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: text } }] })); };

async function withGateway(handler, fn, extra = {}) {
  const g = gateway(handler);
  const old = { ...config };
  Object.assign(config, { aiKey: 'gw-secret-key-123', aiBaseUrl: g.base, aiProtocol: 'openai', aiModel: 'anthropic/claude-sonnet-5-5', ...extra });
  ai.setClient(null);
  const t = await startApp();
  const quiet = console.error; console.error = () => {};
  try { await t.call('PUT', '/api/profile', SAMPLE_PROFILE); await fn({ t, g }); }
  finally { console.error = quiet; Object.assign(config, old); await t.close(); g.srv.close(); }
}
const importJob = async (t) => (await t.call('POST', '/api/jobs/import', SAMPLE_JOB)).body.id;

test('OpenAI-compatible gateway: correct request shape, auth, and end-to-end job analysis', async () => {
  await withGateway(reply(JSON.stringify({ score: 77, verdict: 'possible_match', summary: 'ok', strengths: ['Figma'], gaps: [], requirements: [], keywords: ['Figma'] })), async ({ t, g }) => {
    const id = await importJob(t);
    const r = await t.call('POST', `/api/jobs/${id}/analyze`);
    assert.equal(r.status, 200); assert.equal(r.body.score, 77);
    const req = g.seen[0];
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.auth, 'Bearer gw-secret-key-123');
    assert.equal(req.body.model, 'anthropic/claude-sonnet-5-5'); assert.ok(req.body.max_tokens > 0);
    assert.deepEqual(req.body.messages.map((m) => m.role), ['system', 'user']);
    assert.match(req.body.messages[1].content, /Senior Graphic Designer/);
  });
});

test('gateway: every AI feature works through it (tailor, cover letter)', async () => {
  const tailor = JSON.stringify({ headline: 'Graphic Designer', summary: 'Designer with 4 years of experience in branding.', skills: ['Figma'], experience: [{ id: 'exp1', bullets: ['Designed brand identities for 12 clients'] }], projects: [], keywords_used: [], changes: [], gaps: [] });
  let n = 0;
  await withGateway((r, res) => reply(n++ === 0 ? tailor : 'Dear Hiring Manager, I enjoy branding work. Regards, Test Candidate')(r, res), async ({ t }) => {
    const id = await importJob(t);
    const cv = await t.call('POST', `/api/jobs/${id}/tailor`); assert.equal(cv.status, 201); assert.equal(cv.body.model.experience[0].company, 'Acme Studio');
    const l = await t.call('POST', `/api/jobs/${id}/cover-letter`, {}); assert.equal(l.status, 201); assert.match(l.body.text, /branding work/);
  });
});

test('consent text names the gateway as a third party; default names Anthropic', async () => {
  const t0 = await startApp(); try { assert.match((await t0.call('GET', '/api/privacy')).body.disclosure.ai, /Anthropic/); } finally { t0.close(); }
  await withGateway(reply('{}'), async ({ t }) => {
    const d = (await t.call('GET', '/api/privacy')).body.disclosure.ai;
    assert.match(d, /AI gateway at 127\.0\.0\.1:\d+/); assert.match(d, /forwards it to the model provider/); assert.ok(!/to Anthropic \(/.test(d));
    assert.equal((await t.call('GET', '/api/status')).body.ai_target.gateway, true);
  });
});

test('gateway failures surface as provider errors without leaking the key', async () => {
  await withGateway((_r, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'invalid key gw-secret-key-123' } })); }, async ({ t }) => {
    const id = await importJob(t);
    const r = await t.call('POST', `/api/jobs/${id}/analyze`); assert.equal(r.status, 502); assert.match(r.body.error, /AI gateway error \(HTTP 401\)/);
    assert.equal((await t.call('GET', '/api/integrations')).body.find((i) => i.id === 'ai').state, 'failing');
  });
  await withGateway(reply(''), async ({ t }) => { const id = await importJob(t); const r = await t.call('POST', `/api/jobs/${id}/analyze`); assert.equal(r.status, 502); assert.match(r.body.error, /AI_MODEL/); });
  await withGateway(reply('{}'), async ({ t }) => {
    config.aiBaseUrl = 'http://127.0.0.1:1/v1';
    const id = await importJob(t); const r = await t.call('POST', `/api/jobs/${id}/analyze`); assert.equal(r.status, 502); assert.match(r.body.error, /unreachable/);
  });
});

test('a remote gateway must use https; localhost may use http; the key never reaches the browser', async () => {
  await withGateway(reply('{}'), async ({ t }) => {
    config.aiBaseUrl = 'http://host.docker.internal:1/v1';
    const dockerHost = await importJob(t).then((jid) => t.call('POST', `/api/jobs/${jid}/analyze`));
    assert.equal(dockerHost.status, 502, 'a gateway on the Docker host is treated as local (reached, then refused to connect)');
    config.aiBaseUrl = 'http://gateway.example.com/v1';
    const id = await importJob(t); const r = await t.call('POST', `/api/jobs/${id}/analyze`);
    assert.equal(r.status, 503); assert.match(r.body.error, /https/);
    for (const u of ['/api/status', '/api/integrations', '/api/readiness', '/api/privacy', '/api/privacy/export']) {
      assert.ok(!JSON.stringify((await t.call('GET', u)).body).includes('gw-secret-key-123'), `${u} leaks the key`);
    }
  });
});

test('openai protocol without a base URL is reported as not configured, not as a crash', async () => {
  const old = { ...config }; Object.assign(config, { aiKey: 'k', aiBaseUrl: '', aiProtocol: 'openai' }); ai.setClient(null);
  const t = await startApp();
  try {
    assert.equal(ai.isConfigured(), false);
    const i = (await t.call('GET', '/api/integrations')).body.find((x) => x.id === 'ai');
    assert.equal(i.state, 'not_configured'); assert.match(i.detail, /AI_BASE_URL/);
  } finally { Object.assign(config, old); await t.close(); }
});

test('integration test button works through the gateway and sends no personal data', async () => {
  await withGateway(reply('OK'), async ({ t, g }) => {
    const r = await t.call('POST', '/api/integrations/ai/test'); assert.equal(r.status, 200);
    assert.deepEqual(g.seen[0].body.messages.map((m) => m.content), ['Reply with the single word OK.', 'ping']);
    const row = (await t.call('GET', '/api/integrations')).body.find((i) => i.id === 'ai');
    assert.equal(row.state, 'ok'); assert.match(row.label, /AI gateway at 127\.0\.0\.1/);
  });
});
