const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { startApp } = require('./helpers');

test('APP_PASSWORD protects everything when set', async () => {
  config.appPassword = 's3cret';
  const ctx = await startApp();
  try {
    assert.equal((await fetch(ctx.base + '/api/profile')).status, 401);
    assert.equal((await fetch(ctx.base + '/')).status, 401);
    const ok = 'Basic ' + Buffer.from('me:s3cret').toString('base64');
    assert.equal((await fetch(ctx.base + '/api/profile', { headers: { Authorization: ok } })).status, 200);
    const bad = 'Basic ' + Buffer.from('me:wrong').toString('base64');
    assert.equal((await fetch(ctx.base + '/api/profile', { headers: { Authorization: bad } })).status, 401);
  } finally { config.appPassword = ''; await ctx.close(); }
});
