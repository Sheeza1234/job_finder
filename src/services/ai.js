const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');

let client = null;
class AiNotConfigured extends Error {
  constructor(msg) { super(msg || 'AI is not configured. Set ANTHROPIC_API_KEY (or AI_API_KEY and AI_BASE_URL for a gateway) in .env to enable job analysis, CV tailoring and cover letters.'); this.status = 503; }
}

// host.docker.internal is how a container reaches a gateway running on the same machine.
const LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal'];
// A gateway sees your profile and job text, so it must be reached over HTTPS unless it runs on this machine.
function gatewayUrl() {
  if (!config.aiBaseUrl) return null;
  let u; try { u = new URL(config.aiBaseUrl); } catch { throw new AiNotConfigured('AI_BASE_URL is not a valid URL.'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.includes(u.hostname))) throw new AiNotConfigured('AI_BASE_URL must use https:// (plain http is only allowed for localhost), because your profile and job text are sent to it.');
  return u;
}
// Where AI requests go, for disclosure and status pages.
function target() {
  const host = config.aiBaseUrl ? (() => { try { return new URL(config.aiBaseUrl).host; } catch { return config.aiBaseUrl; } })() : null;
  return { gateway: !!config.aiBaseUrl, host, protocol: config.aiProtocol, model: config.aiModel, name: host ? `AI gateway at ${host}` : 'Anthropic' };
}

const isConfigured = () => !!client || (!!config.aiKey && (config.aiProtocol !== 'openai' || !!config.aiBaseUrl));
function getClient() {
  if (client) return client;
  if (!config.aiKey) throw new AiNotConfigured();
  const u = gatewayUrl();
  client = new Anthropic({ apiKey: config.aiKey, ...(u ? { baseURL: config.aiBaseUrl } : {}) });
  return client;
}
// Test hook: inject a fake client exposing messages.create().
function setClient(c) { client = c; }

// OpenAI-compatible chat completion (what gateways such as OmniRoute expose). No extra dependency.
async function openaiComplete({ system, user, maxTokens }) {
  if (!config.aiKey) throw new AiNotConfigured();
  if (!config.aiBaseUrl) throw new AiNotConfigured('AI_PROTOCOL=openai needs AI_BASE_URL (the gateway address, e.g. https://gateway.example.com/v1).');
  gatewayUrl();
  let res;
  try {
    res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.aiKey}` },
      body: JSON.stringify({ model: config.aiModel, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) { throw Object.assign(new Error(`AI gateway unreachable: ${e.message}`), { status: 502 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`AI gateway error (HTTP ${res.status}): ${String(data?.error?.message || data?.error || res.statusText).slice(0, 200)}`), { status: 502 });
  const c = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(c) ? c.map((p) => p.text || '').join('') : c;
  if (typeof text !== 'string' || !text) throw Object.assign(new Error('AI gateway returned no text; check AI_MODEL is a model your gateway serves.'), { status: 502 });
  return text;
}

function extractJson(text) {
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  const bad = (m) => Object.assign(new Error(m), { status: 502 });
  if (start < 0 || end < start) throw bad('AI returned no JSON object; please retry');
  try { return JSON.parse(text.slice(start, end + 1)); } catch { throw bad('AI returned malformed JSON; please retry'); }
}

// Outcome of the most recent call (since server start), for the integration status page.
const lastCall = {};
const health = () => ({ ...lastCall });

async function completeText({ system, user, maxTokens = 2000 }) {
  try {
    let text;
    if (!client && config.aiProtocol === 'openai') text = await openaiComplete({ system, user, maxTokens });
    else {
      const res = await getClient().messages.create({ model: config.aiModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
      text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    lastCall.last_ok_at = new Date().toISOString();
    return text;
  } catch (e) {
    if (!(e instanceof AiNotConfigured)) { lastCall.last_error_at = new Date().toISOString(); lastCall.last_error = String(e.message).slice(0, 300); }
    throw e;
  }
}

async function completeJson(args) {
  const text = await completeText({ ...args, user: `${args.user}\n\nRespond with a single JSON object and nothing else.` });
  return extractJson(text);
}

module.exports = { target, health, isConfigured, setClient, completeText, completeJson, extractJson, AiNotConfigured };
