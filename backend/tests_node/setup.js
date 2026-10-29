// Hermetic config: ignore any local .env and any AI/gateway variables in the shell.
process.env.JOBFINDER_NO_DOTENV = '1';
for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_PROTOCOL', 'AI_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'JOOBLE_API_KEY', 'RAPIDAPI_KEY', 'APP_PASSWORD', 'APP_SECRET']) delete process.env[k];

// Loaded before every test file. Tests must never reach the real internet: no job APIs, no AI provider, no employer
// sites, no email. Only loopback addresses (local fixtures) are allowed, so a test can never submit a real application.
const realFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    return Promise.reject(new Error(`Network blocked in tests: ${url.origin}`));
  }
  return realFetch(input, init);
};
