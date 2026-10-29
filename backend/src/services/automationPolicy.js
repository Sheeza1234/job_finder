const dns = require('dns').promises;
const config = require('../config');
const { isPrivateIp } = require('./importJob');

// Sites whose terms restrict automated access/form-filling. We hand control back to the user for these
// and never try to work around it. Extend with AUTOMATION_BLOCKED_HOSTS.
const BLOCKED_HOSTS = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'bayt.com', 'gulftalent.com', 'naukrigulf.com',
  'monster.com', 'ziprecruiter.com', 'google.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'whatsapp.com'];

function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
const matchesHost = (host, list) => list.some((b) => host === b || host.endsWith(`.${b}`));

function manualFallback(reason) {
  return { allowed: false, reason, fallback: 'manual', message: `${reason} Use Manual assistance (Mode A): open the listing and apply yourself using the checklist, CV and cover letter.` };
}

// Static policy check (no network): is browser assistance acceptable for this URL?
function assistPolicy(url) {
  let u; try { u = new URL(url); } catch { return manualFallback('This job has no valid URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) return manualFallback('Only http(s) pages can be opened.');
  const host = u.hostname.toLowerCase();
  if (matchesHost(host, [...BLOCKED_HOSTS, ...config.extraBlockedHosts])) {
    return manualFallback(`${host} does not permit automated form-filling.`);
  }
  return { allowed: true };
}

// Refuse targets on private networks (a browser opened by this server must not be pointed at internal services).
async function assertPublicHost(url, lookup = dns.lookup) {
  if (process.env.ASSIST_ALLOW_PRIVATE === 'true') return;
  const { hostname } = new URL(url);
  const addrs = await lookup(hostname, { all: true }).catch(() => { throw Object.assign(new Error(`Could not resolve ${hostname}.`), { status: 422 }); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw Object.assign(new Error('That address is on a private network and will not be opened.'), { status: 422 });
}

module.exports = { assistPolicy, assertPublicHost, BLOCKED_HOSTS, hostOf };
