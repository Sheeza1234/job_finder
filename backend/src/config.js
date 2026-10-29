// Tests must be hermetic: never read a developer's local .env (tests/setup.js sets this).
if (!process.env.JOBFINDER_NO_DOTENV) require('dotenv').config({ quiet: true });
const path = require('path');

const root = path.join(__dirname, '..');
module.exports = {
  root,
  port: Number(process.env.PORT || 3000),
  // Loopback by default: a personal tool holding your CV must not listen on the network unless you choose to.
  host: process.env.HOST || '127.0.0.1',
  trustProxy: process.env.TRUST_PROXY || '',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  appPassword: process.env.APP_PASSWORD || '',
  // Supabase: direct Postgres connection string (session pooler). Never the anon/service REST keys.
  databaseUrl: process.env.DATABASE_URL || '',
  // AI provider. Direct Anthropic by default; or any gateway (e.g. OmniRoute) via AI_BASE_URL.
  // AI_PROTOCOL: "anthropic" (Messages API, default) or "openai" (OpenAI-compatible /chat/completions, what gateways expose).
  aiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  aiBaseUrl: (process.env.AI_BASE_URL || '').replace(/\/+$/, ''),
  aiProtocol: process.env.AI_PROTOCOL === 'openai' ? 'openai' : 'anthropic',
  aiModel: process.env.AI_MODEL || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  joobleKey: process.env.JOOBLE_API_KEY || '',
  joobleKeyPk: process.env.JOOBLE_PK_API_KEY || '',
  rapidApiKey: process.env.RAPIDAPI_KEY || '',
  chromePath: process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => require('fs').existsSync(p)) || '',
  chromeArgs: (process.env.CHROME_ARGS || '').split(' ').filter(Boolean),
  assistHeadless: process.env.ASSIST_HEADLESS === 'true',
  extraBlockedHosts: (process.env.AUTOMATION_BLOCKED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  appSecret: process.env.APP_SECRET || '',
  schedulerEnabled: process.env.SCHEDULER !== 'off',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 15),
};
