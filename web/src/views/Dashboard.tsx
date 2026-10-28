import { api, fmtDate, fmtWhen, LABEL } from '../lib/api';
import { toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import type { Rec } from '../lib/types';
import { ActionLink, Btn, Card, EmptyState, Meta, Meter, Pill, Row, cx } from '../components/ui';
import { Loaded } from '../components/Load';
import { CvUpload } from '../components/CvUpload';
import { JobActions } from '../components/JobActions';

const PLAIN: Record<string, [string, string]> = {
  cv: ['Step 1: upload your CV', 'We will read it and fill in your details for you. You only add what is missing.'],
  profile: ['Step 2: check your details', 'Make sure your name, contact details, skills and experience are right.'],
  preferences: ['Step 3: tell us what jobs you want', 'Choose your cities and how strong a match you want before we alert you.'],
  source: ['Step 4: add a job you like', 'Paste the link or text of a job you found, or let us look for jobs online.'],
};

export function Dashboard() {
  const app = useApp();
  const q = useLoad(async () => { const [d, ob] = await Promise.all([api('/api/dashboard'), api('/api/onboarding')]); return { d, ob }; });
  return <Loaded q={q}>{({ d, ob }) => {
    const o = d.overview as Rec; const s = d.search as Rec;
    const toApps = (status: string, extra: Partial<typeof app.tracker> = {}) => () => { app.setTracker({ status, followup: false, q: '', employer: '', city: '', ...extra }); app.go('applications'); };
    const toJobs = (f: Record<string, string> = {}) => () => { app.setFilters(f); app.go('jobs'); };
    const searchLine = s.frequency === 'off' ? 'Automatic search is off.' : `Automatic search ${String(s.frequency).replace('_', ' ')}${s.frequency === 'daily' ? ' at ' + s.dailyTime : ''}. Last run: ${fmtWhen(s.last_search_at)}. Next: ${fmtWhen(s.next_run_at)}.`;
    const req = (ob.steps as Rec[]).filter((x) => x.required); const doneN = req.filter((x) => x.done).length;
    const next = req.find((x) => !x.done);
    const recs = d.recommended as Rec[];
    const Tile = ({ label, value, hint, onClick }: { label: string; value: number; hint?: string | null; onClick: () => void }) =>
      <button type="button" onClick={onClick} className="flex min-w-0 flex-col items-start gap-0.5 rounded-xl border border-line bg-card p-3.5 text-left hover:border-accent">
        <div className="text-[30px] font-bold leading-tight tabular-nums max-sm:text-2xl">{String(value)}</div><div className="text-[13px] text-mute">{label}</div>{hint && <Meta>{hint}</Meta>}</button>;

    return <div className="grid gap-3">
      {ob.show && next && <section aria-labelledby="obh" className="onboard rounded-xl border border-l-4 border-line border-l-accent bg-card p-3.5 shadow-sm">
        <Row spread><h2 id="obh" className="mb-0 text-[22px] max-sm:text-xl">{PLAIN[next.key]?.[0] || next.label}</h2><Meta>{`${doneN} of ${req.length} done`}</Meta></Row>
        <p className="my-2">{PLAIN[next.key]?.[1] || next.detail}</p>
        {next.key === 'cv'
          ? <div className="my-1.5"><CvUpload /><p className="mt-2 text-[13px] text-mute">Prefer to type everything yourself? <ActionLink onClick={() => app.go('profile')}>Fill in my profile by hand</ActionLink>.</p></div>
          : <Btn variant="primary" className="px-5 py-2.5 text-base" onClick={() => app.go(next.view)}>Continue</Btn>}
        <details className="my-1.5"><summary>See all steps</summary>
          <ol className="my-2 grid list-none gap-2 p-0">{(ob.steps as Rec[]).map((x) => <li key={x.key} className={cx('flex items-start gap-2.5 rounded-[10px] bg-bg p-2', x.done && 'opacity-70')}>
            <span aria-hidden="true" className="w-[18px] text-center font-bold text-accent">{x.done ? '✓' : '○'}</span>
            <div className="min-w-0 flex-1"><b>{x.label}{!x.required && <span className="text-[13px] font-normal text-mute"> (optional)</span>}</b><Meta>{x.detail}</Meta>{x.done && <span className="sr-only">Completed</span>}</div>
            {!x.done && <Btn onClick={() => app.go(x.view)}>Go</Btn>}</li>)}</ol></details>
        <Row><Btn onClick={async () => { await api('/api/onboarding/dismiss', { method: 'POST' }); app.reload(); }}>Hide this guide</Btn></Row>
      </section>}

      <Row spread><h2 className="mb-0">Your job search at a glance</h2>
        <Row><Meta>{searchLine}</Meta>
          <Btn busyLabel="Searching…" onAction={async () => {
            const r = await api('/api/scheduler/run', { method: 'POST' });
            toast(r.skipped ? r.reason : `Found ${r.added} new job${r.added === 1 ? '' : 's'}, ${r.matches} match${r.matches === 1 ? '' : 'es'} your threshold.${r.sources_enabled ? '' : ' (No job sources enabled; see Settings.)'}`); app.reload();
          }}>Look for new jobs</Btn></Row></Row>

      <div className="stats grid grid-cols-[repeat(auto-fit,minmax(min(150px,100%),1fr))] gap-3">
        <Tile label="Jobs found" value={o.total_jobs} hint={`${o.new_24h} new today`} onClick={toJobs()} />
        <Tile label="Best matches" value={o.high_match} hint={`${d.min_match_score}%+ match`} onClick={toJobs({ sort: 'score' })} />
        <Tile label="Saved for later" value={o.shortlisted} onClick={toApps('shortlisted')} />
        <Tile label="Applied" value={o.submitted} onClick={toApps('applied')} />
        <Tile label="Interviews" value={o.interviews} onClick={toApps('interview')} />
        <Tile label="To follow up" value={o.pending_followups} onClick={toApps('', { followup: true })} />
      </div>

      {(d.upcoming_interviews.length || d.due_followups.length) ? <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-3">
        <Card><h3>Your interviews</h3>{d.upcoming_interviews.length ? <ul className="my-1 list-disc pl-5">{(d.upcoming_interviews as Rec[]).map((i, n) => <li key={n}><ActionLink onClick={() => app.openJob(i.job_id)}>{i.title}</ActionLink>{` ${i.company || ''} · ${String(i.at).replace('T', ' ')}`}</li>)}</ul> : <Meta>None in the next 14 days.</Meta>}</Card>
        <Card><h3>Time to follow up</h3>{d.due_followups.length ? <ul className="my-1 list-disc pl-5">{(d.due_followups as Rec[]).map((f, n) => <li key={n}><ActionLink onClick={() => app.openJob(f.job_id)}>{f.title}</ActionLink>{` ${f.company || ''} · due ${f.due}`}</li>)}</ul> : <Meta>Nothing due.</Meta>}</Card>
      </div> : null}

      <h2 className="mb-0">Jobs that fit you</h2>
      <Meta>These are suggestions. We never apply for you. A score with ~ is a quick estimate; press “Check my fit” for a proper check.</Meta>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-3">
        {recs.length ? recs.map((c) => <RecCard key={c.id} c={c} />)
          : o.total_jobs === 0
            ? <EmptyState title="No jobs yet" body="Real jobs appear here after you fetch from a job source or add a posting by URL or pasted text. Nothing is made up: until you add data, this stays empty."><Btn variant="primary" onClick={() => app.go('jobs')}>Add or fetch jobs</Btn><Btn onClick={() => app.go('settings')}>Check job sources</Btn></EmptyState>
            : <EmptyState title="No recommendations meet your threshold" body={`${o.total_jobs} job${o.total_jobs === 1 ? ' is' : 's are'} saved, but none score near ${d.min_match_score}% for your profile yet. Complete your profile, or lower the minimum match score.`}><Btn onClick={() => app.go('profile')}>Improve profile</Btn><Btn onClick={() => app.go('searchsettings')}>Adjust threshold</Btn></EmptyState>}
      </div>
    </div>;
  }}</Loaded>;
}

function RecCard({ c }: { c: Rec }) {
  return <Card className="flex flex-col">
    <Row spread><h3 dir="auto" className="min-w-0">{c.title}</h3>{c.match_score != null && <Meter score={c.match_score} method={c.match_method} />}</Row>
    <Meta><span dir="auto">{[c.company, c.location].filter(Boolean).join(' · ')}</span></Meta>
    <Row className="my-1.5">
      {c.salary && <Pill>{`💰 ${c.salary}`}</Pill>}
      {c.work_mode !== 'unknown' && <Pill>{LABEL[c.work_mode]}</Pill>}
      {c.employment_type !== 'unknown' && <Pill>{LABEL[c.employment_type]}</Pill>}
      {c.sponsorship === 'yes' && <Pill tone="yes">Sponsorship stated in posting</Pill>}
      {c.sponsorship === 'no' && <Pill tone="no">Sponsorship not offered</Pill>}
      {c.posted_at && <Meta>{`Posted ${fmtDate(c.posted_at)}`}</Meta>}{c.is_new && <Pill tone="yes">New</Pill>}
    </Row>
    {c.top_skills.length > 0 && <div className="my-1.5"><Meta>Top matching skills</Meta><Row>{(c.top_skills as string[]).map((s) => <Pill key={s} tone="yes">{s}</Pill>)}</Row></div>}
    {c.missing.length > 0 && <div className="my-1.5"><Meta>Missing requirements</Meta><Row>{(c.missing as string[]).map((s) => <Pill key={s} tone="no">{s}</Pill>)}</Row></div>}
    <JobActions job={{ id: c.id, app_status: c.app_status }} />
  </Card>;
}
