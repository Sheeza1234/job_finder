import { useState } from 'react';
import { api, fmtWhen, lines } from '../lib/api';
import { toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import type { Rec } from '../lib/types';
import { AreaField, Btn, Card, Check, CheckPills, Grid, Meta, SelectField, TextField, Warn, cx } from '../components/ui';
import { Loaded } from '../components/Load';

export function SearchSettings() {
  const q = useLoad(async () => {
    const [s, n, sch] = await Promise.all([api('/api/settings/search'), api('/api/settings/notifications'), api('/api/scheduler')]);
    return { s, n, sch };
  });
  return <Loaded q={q}>{({ s, n, sch }) => <Form s0={s} n0={n} sch={sch} />}</Loaded>;
}

function Form({ s0, n0, sch }: { s0: Rec; n0: Rec; sch: Rec }) {
  const app = useApp();
  const [s, setS] = useState<Rec>(s0);
  const [n, setN] = useState<Rec>(n0);
  const [dirty, setDirty] = useState(false);
  const setSv = (k: string, v: unknown) => { setS((c) => ({ ...c, [k]: v })); setDirty(true); };
  const setNv = (k: string, v: unknown) => { setN((c) => ({ ...c, [k]: v })); setDirty(true); };
  const flag = (obj: Rec, set: (k: string, v: unknown) => void, k: string, label: string) => <Check checked={!!obj[k]} onChange={(v) => set(k, v)}>{label}</Check>;
  const area = (k: string, label: string, ph?: string) => <AreaField label={label} placeholder={ph} defaultValue={(s[k] as string[]).join('\n')} onChange={(e) => setSv(k, lines(e.target.value))} />;

  // Match strength in words instead of a percentage box.
  const strengths: [number, string][] = [[75, 'Only strong matches (75% and up)'], [60, 'Good matches too (60% and up)'], [40, 'Show me almost everything (40% and up)']];
  if (!strengths.some(([v]) => v === s.minMatchScore)) strengths.push([s.minMatchScore, `Custom (${s.minMatchScore}%)`]);

  return <div className="grid gap-3">
    <Card><h2>What jobs do you want?</h2>
      <Meta className="mb-2">The job titles we look for come from “Jobs I’m looking for” on your profile. Looking for jobs only sends search words and city names to job websites; your CV is never sent to them, and nothing is ever applied to for you.</Meta>
      <Btn onClick={() => app.go('profile')}>Change my job titles</Btn>
      <div className="my-2"><label>Which countries do you want jobs in?</label>
        <CheckPills options={app.meta.markets.map((m): [string, string] => [m.code, m.country])} value={s.markets}
          onChange={(v) => { if (v.length) setS((c) => ({ ...c, markets: v, cities: (c.cities as string[]).filter((city) => app.meta.markets.some((m) => v.includes(m.code) && m.cities.includes(city))) })); if (v.length) setDirty(true); else toast('Keep at least one country selected.', true); }} /></div>
      {app.meta.markets.filter((m) => s.markets.includes(m.code)).map((m) => <div key={m.code} className="my-2"><label>{`Cities in ${m.country} (leave all unticked for anywhere in ${m.country})`}</label>
        <CheckPills options={m.cities.map((c): [string, string] => [c, c])} value={(s.cities as string[]).filter((c) => m.cities.includes(c))}
          onChange={(v) => setSv('cities', [...(s.cities as string[]).filter((c) => !m.cities.includes(c)), ...v])} /></div>)}
      <SelectField label="Tell me about jobs that are…" value={String(s.minMatchScore)} onChange={(v) => setSv('minMatchScore', Number(v))} options={strengths.map(([v, l]): [string, string] => [String(v), l])} />
    </Card>

    <Card><h2>Look for new jobs for me</h2>
      <Meta className="mb-2">Runs by itself in the background, even when this page is closed.</Meta>
      <Grid two>
        <SelectField label="How often?" value={s.frequency} onChange={(v) => setSv('frequency', v)} options={[['off', 'Never (I will press the button myself)'], ['daily', 'Every day'], ['every_6_hours', 'Every 6 hours'], ['hourly', 'Every hour']]} />
        <TextField label="Time of day (for “Every day”)" type="time" value={s.dailyTime || ''} onChange={(e) => setSv('dailyTime', e.target.value)} />
      </Grid>
      <Meta className="my-2">{`Last looked: ${fmtWhen(sch.last_search_at)}${sch.last_result ? ` · found ${sch.last_result.added} new, ${sch.last_result.matches} that fit` : ''}. Next: ${fmtWhen(sch.next_run_at)}.`}</Meta>
      {sch.last_result?.errors?.length ? <Warn>{`Last time there was a problem: ${(sch.last_result.errors as string[]).join('; ')}`}</Warn> : null}
      <Btn busyLabel="Looking…" onAction={async () => { const r = await api('/api/scheduler/run', { method: 'POST' }); toast(r.skipped ? r.reason : `Found ${r.added} new job(s), ${r.matches} that fit you.`); app.reload(); }}>Look for jobs now</Btn>
    </Card>

    <Card><h2>Tell me when…</h2>
      {flag(n, setNv, 'newMatches', 'new jobs fit me well')}{flag(n, setNv, 'followUps', 'it is time to follow up on an application')}{flag(n, setNv, 'interviews', 'an interview is coming up')}{flag(n, setNv, 'expiring', 'a saved job is about to close')}
      <div className="mt-2"><label>How?</label>{flag(n, setNv, 'inApp', 'Inside this app (the bell at the top)')}{flag(n, setNv, 'email', 'By email (set up in Settings first)')}</div>
    </Card>

    <details className="optional rounded-xl border border-line bg-card px-4 py-3"><summary>More options (salary, job type, companies to avoid…)</summary>
      <Grid two className="my-2">
        <TextField label="Lowest salary I would accept (jobs with no listed salary are still shown)" type="number" min={0} value={s.minSalary ?? ''} onChange={(e) => setSv('minSalary', e.target.value === '' ? null : Number(e.target.value))} />
        <TextField label="Remind me to follow up this many days after applying" type="number" min={1} max={60} value={n.followUpDays} onChange={(e) => setNv('followUpDays', Number(e.target.value))} />
      </Grid>
      <div className="my-2"><label>Level</label><CheckPills options={[['entry', 'Entry'], ['mid', 'Mid'], ['senior', 'Senior'], ['lead', 'Lead']]} value={s.experienceLevels} onChange={(v) => setSv('experienceLevels', v)} /></div>
      <div className="my-2"><label>Job type</label><CheckPills options={[['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Contract'], ['internship', 'Internship']]} value={s.employmentTypes} onChange={(v) => setSv('employmentTypes', v)} /></div>
      <div className="my-2"><label>Where you work</label><CheckPills options={[['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']]} value={s.workModes} onChange={(v) => setSv('workModes', v)} /></div>
      <Grid two className="my-2">{area('excludedCompanies', 'Companies to avoid (one per line)')}{area('excludedKeywords', 'Words to avoid in a job (one per line)')}</Grid>
      {area('titles', 'Search these titles instead of my profile titles (one per line; leave empty to use my profile)', 'Graphic Designer\nUI/UX Designer')}
      {flag(s, setSv, 'includeRemote', 'Also show remote jobs that someone in Pakistan, or moving to Saudi Arabia, can apply for')}
      {flag(s, setSv, 'arabic', 'Also search Arabic job titles')}
      {flag(s, setSv, 'aiScreening', 'Use AI to double-check the best new jobs (sends your profile and the job text to the AI provider; asks for your permission first)')}
    </details>

    <div className={cx('savebar sticky bottom-0 flex flex-wrap items-center justify-end gap-3 rounded-xl border bg-card px-3.5 py-2.5 shadow-[0_-2px_8px_rgba(16,24,40,.08)] max-sm:[&>*]:flex-auto', dirty ? 'dirty border-accent' : 'border-line')}>
      <Meta>Your choices are saved only when you press Save.</Meta>
      <Btn variant="primary" busyLabel="Saving…" onAction={async () => { await api('/api/settings/search', { method: 'PUT', body: s }); await api('/api/settings/notifications', { method: 'PUT', body: n }); toast('Saved'); app.reload(); }}>Save my preferences</Btn>
    </div>
  </div>;
}
