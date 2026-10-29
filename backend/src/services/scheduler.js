// Background jobs: recurring searches and reminders. Runs inside the server process on a timer, with state in the
// database so a restart catches up on a missed run; nothing depends on an open browser tab.
//
// Discovery and applying are separate by design: this file never imports the application workflows
// (browser assist / auto-submit) and never changes an application's status. It only finds jobs and notifies.
const providers = require('../providers');
const settings = require('./settings');
const profileSvc = require('./profile');
const jobsStore = require('./jobsStore');
const { runSearch } = require('./search');
const { matchJob, isRelevant, searchTitles } = require('./match');
const { notify } = require('./notifications');
const { audit } = require('./audit');
const privacy = require('./privacy');
const ai = require('./ai');

const HOUR = 3600e3;
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const getState = async (db) => (await settings.get(db, 'scheduler_state')) || {};
const setState = async (db, patch) => settings.set(db, 'scheduler_state', { ...(await getState(db)), ...patch });

// Most recent daily slot (HH:MM local time) at or before `now`.
function latestSlot(hhmm, now) {
  const [h, m] = hhmm.split(':').map(Number);
  const slot = new Date(now); slot.setHours(h, m, 0, 0);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return slot;
}

function isDue(s, lastIso, now = new Date()) {
  if (s.frequency === 'off') return false;
  const last = lastIso ? new Date(lastIso) : null;
  if (s.frequency === 'hourly') return !last || now - last >= HOUR;
  if (s.frequency === 'every_6_hours') return !last || now - last >= 6 * HOUR;
  const slot = latestSlot(s.dailyTime, now);   // daily: also runs late if the server was down at the slot
  return !last || last < slot;
}

function nextRun(s, lastIso, now = new Date()) {
  if (s.frequency === 'off') return null;
  const last = lastIso ? new Date(lastIso) : null;
  if (s.frequency === 'hourly') return new Date(Math.max(now, last ? +last + HOUR : +now)).toISOString();
  if (s.frequency === 'every_6_hours') return new Date(Math.max(now, last ? +last + 6 * HOUR : +now)).toISOString();
  if (isDue(s, lastIso, now)) return now.toISOString();
  const slot = latestSlot(s.dailyTime, now); slot.setDate(slot.getDate() + 1);
  return slot.toISOString();
}

let running = false;

async function runSearchJob(db, { now = new Date(), providerList = providers.all, actor = 'scheduler' } = {}) {
  if ((await jobsStore.getMode(db)) === 'demo') return { skipped: true, reason: 'Demo mode shows sample data only; no real search was run.' };
  if (running) return { skipped: true, reason: 'A search is already running.' };
  running = true;
  try {
    const s = await settings.getSearch(db); const profile = await profileSvc.getProfile(db); const prefs = await settings.getNotify(db);
    await setState(db, { last_search_at: now.toISOString() });
    const titles = [...new Set(s.titles.length ? s.titles : searchTitles(profile))];
    const res = await runSearch(db, { categories: titles, cities: s.cities.length ? s.cities : profile.preferences.cities, includeRemote: s.includeRemote, arabic: s.arabic, markets: s.markets, maxQueries: s.maxQueries, relevance: (j) => isRelevant(profile, j) }, providerList);

    const found = await Promise.all(res.newIds.map((id) => jobsStore.getJob(db, id)));
    const candidates = found.filter((j) => j && !settings.isExcluded(j, s) && settings.qualifies(j, s))
      .map((job) => ({ job, score: matchJob(profile, job).score, method: 'heuristic' }));

    // Optional AI screening of the best few candidates, only with the user's consent and a configured key.
    if (s.aiScreening && ai.isConfigured() && (await privacy.getConsent(db)).ai) {
      const { analyzeJob } = require('./assistant');
      const top = candidates.filter((c) => c.score != null && c.score >= s.minMatchScore - 15).sort((a, b) => b.score - a.score).slice(0, 10);
      for (const c of top) {
        try { const a = await analyzeJob(profile, c.job); await jobsStore.saveAnalysis(db, c.job.id, a.score, a.data); c.score = a.score; c.method = 'ai'; } catch { /* keep heuristic score */ }
      }
    }

    const matches = candidates.filter((c) => c.score != null && c.score >= s.minMatchScore).sort((a, b) => b.score - a.score);
    let notification = null;
    if (prefs.newMatches && matches.length) {
      const lines = matches.slice(0, 8).map((m) => `• ${m.job.title}${m.job.company ? ' at ' + m.job.company : ''}${m.job.city ? ' (' + m.job.city + ')' : ''}: ${m.score}%`);
      notification = await notify(db, { kind: 'new_matches', dedupeKey: `search:${now.toISOString()}`, title: `${matches.length} new job${matches.length === 1 ? '' : 's'} match at least ${s.minMatchScore}%`,
        body: `${lines.join('\n')}${matches.length > 8 ? `\n…and ${matches.length - 8} more` : ''}\n\nThese are suggestions only. Nothing has been applied to.`, jobId: matches[0].job.id, payload: { job_ids: matches.map((m) => m.job.id) } });
    }
    const errors = res.providers.flatMap((p) => p.errors.map((e) => `${p.id}: ${e}`));
    const result = { at: now.toISOString(), queries: res.queries, fetched: res.fetched, filtered_out: res.filtered_out, added: res.added, matches: matches.length, errors: errors.slice(0, 5), sources_enabled: res.providers.filter((p) => p.enabled).length };
    await setState(db, { last_search_result: result });
    await audit(db, 'search_run', { actor, detail: { added: res.added, matches: matches.length, errors: errors.length } });
    return result;
  } finally { running = false; }
}

const TERMINAL = ['offer', 'rejected', 'withdrawn', 'listing_expired'];
const EARLY = ['saved', 'shortlisted', 'cv_ready', 'awaiting_approval', 'ready_to_apply'];

// Follow-ups, interviews and closing listings. Each event notifies once (dedupe keys).
async function runReminders(db, now = new Date()) {
  const prefs = await settings.getNotify(db); let created = 0;
  const push = async (n) => { if (await notify(db, n)) created++; };
  const today = localDate(now);
  const apps = await db.prepare(`SELECT a.*, j.title, j.company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.source != 'demo'`).all();
  const label = (a) => `${a.title}${a.company ? ' at ' + a.company : ''}`;

  for (const a of apps) {
    if (prefs.followUps && !TERMINAL.includes(a.status)) {
      if (a.follow_up_date && a.follow_up_date <= today) {
        await push({ kind: 'follow_up', jobId: a.job_id, dedupeKey: `followup:${a.job_id}:${a.follow_up_date}`, title: `Follow up: ${label(a)}`, body: `Your follow-up date (${a.follow_up_date}) has arrived.` });
      } else if (!a.follow_up_date && a.status === 'applied' && a.applied_at && now - new Date(a.applied_at) >= prefs.followUpDays * 24 * HOUR) {
        await push({ kind: 'follow_up', jobId: a.job_id, dedupeKey: `followup-auto:${a.job_id}`, title: `Follow up: ${label(a)}`, body: `It has been ${prefs.followUpDays}+ days since you applied and there is no update.` });
      }
    }
    if (prefs.interviews) {
      for (const d of JSON.parse(a.interview_dates || '[]')) {
        const start = new Date(d.length === 10 ? `${d}T09:00` : d);
        const diff = start - now;
        if (!isNaN(diff) && diff <= 24 * HOUR && diff > -2 * HOUR) {
          await push({ kind: 'interview', jobId: a.job_id, dedupeKey: `interview:${a.job_id}:${d}`, title: `Interview soon: ${label(a)}`, body: `Scheduled for ${d.replace('T', ' ')}.` });
        }
      }
    }
  }
  if (prefs.expiring) {
    const rows = await db.prepare(`SELECT j.id, j.title, j.company, j.expires_at, a.status FROM jobs j JOIN applications a ON a.job_id = j.id WHERE j.expires_at IS NOT NULL AND j.source != 'demo'`).all();
    for (const j of rows) {
      const left = new Date(j.expires_at) - now;
      if (EARLY.includes(j.status) && left > 0 && left <= 3 * 24 * HOUR) {
        await push({ kind: 'expiring', jobId: j.id, dedupeKey: `expiring:${j.id}:${j.expires_at.slice(0, 10)}`, title: `Closing soon: ${j.title}${j.company ? ' at ' + j.company : ''}`, body: `The listing closes on ${j.expires_at.slice(0, 10)} and you have not applied yet.` });
      }
    }
  }
  return created;
}

async function tick(db, now = new Date(), opts = {}) {
  const out = { reminders: 0, search: null };
  try { out.reminders = await runReminders(db, now); } catch (e) { await audit(db, 'reminders_failed', { actor: 'scheduler', detail: { error: e.message } }); }
  const s = await settings.getSearch(db);
  if (isDue(s, (await getState(db)).last_search_at, now)) {
    try { out.search = await runSearchJob(db, { now, providerList: opts.providerList }); } catch (e) { await audit(db, 'search_failed', { actor: 'scheduler', detail: { error: e.message } }); }
  }
  return out;
}

let timer = null;
function start(db, { intervalMs = 60_000 } = {}) {
  if (timer) return;
  const run = () => tick(db).catch(() => {});
  timer = setInterval(run, intervalMs); timer.unref();
  setTimeout(run, 10_000).unref();               // catch up shortly after boot
}
const stop = () => { clearInterval(timer); timer = null; };
const isRunning = () => !!timer;

const status = async (db, now = new Date()) => { const s = await settings.getSearch(db); const st = await getState(db); return { frequency: s.frequency, dailyTime: s.dailyTime, last_search_at: st.last_search_at || null, last_result: st.last_search_result || null, next_run_at: nextRun(s, st.last_search_at, now), running }; };

module.exports = { isRunning, isDue, nextRun, runSearchJob, runReminders, tick, start, stop, status };
