import { useState } from 'react';
import { api, ApiError, fmtDate } from '../lib/api';
import { askConfirm, askText, toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import { uiFor } from '../lib/jobui';
import type { Application, Job, JobDetailData, Rec } from '../lib/types';
import { AreaField, Btn, Card, Check, Grid, LinkBtn, Meta, Pill, Row, Select, SelectField, Sub, Tabs, TextField, Warn, Good, cx } from './ui';
import { DlButton } from './CvPanel';
import { Loaded } from './Load';

/** PUT with a friendly duplicate-application confirmation. */
export async function putApp(jobId: number, body: Rec) {
  try { return await api(`/api/applications/${jobId}`, { method: 'PUT', body }); } catch (e) {
    if (e instanceof ApiError && e.duplicates && await askConfirm({ title: 'Possible duplicate application', body: e.message, confirmLabel: 'Apply anyway', danger: true }))
      return api(`/api/applications/${jobId}`, { method: 'PUT', body: { ...body, allow_duplicate: true } });
    throw e;
  }
}

async function markSubmittedFlow(jobId: number): Promise<boolean> {
  const confirmation = await askText({ title: 'Record this application as submitted?', body: 'Only continue if you have actually submitted it on the employer’s site. It will be recorded as self-reported, since the site has not confirmed it to this tool.', label: 'Confirmation number or reference shown by the site (optional)', optional: true, confirmLabel: 'Record as applied' });
  if (confirmation === null) return false;
  const body = { confirmation: confirmation.trim() || undefined };
  try { await api(`/api/applications/${jobId}/mark-submitted`, { method: 'POST', body }); } catch (e) {
    if (!(e instanceof ApiError && e.duplicates && await askConfirm({ title: 'Possible duplicate application', body: e.message, confirmLabel: 'Record anyway', danger: true }))) throw e;
    await api(`/api/applications/${jobId}/mark-submitted`, { method: 'POST', body: { ...body, allow_duplicate: true } });
  }
  toast('Recorded as applied (self-reported: not verified by the site).');
  return true;
}

const SubmittedButton = ({ jobId, reload }: { jobId: number; reload: () => void }) =>
  <Btn variant="primary" busyLabel="Saving…" onAction={async () => { if (await markSubmittedFlow(jobId)) reload(); }}>I have applied</Btn>;

interface PanelProps { job: Job; d: JobDetailData; reload: () => void }

export function ApplyPanel({ job, d, reload }: PanelProps) {
  const app = useApp();
  const a = d.application;
  const ui = uiFor(job.id);
  const [mode, setModeState] = useState(ui.mode);
  const setMode = (m: typeof mode) => { ui.mode = m; setModeState(m); };
  const dups = useLoad(() => api<Rec[]>(`/api/applications/${job.id}/duplicates`).catch(() => []), [job.id]);
  const statusLabel = (k: string) => app.meta.statuses.find(([v]) => v === k)?.[1] ?? k;
  const approvedCv = d.cv_versions.filter((v) => v.status === 'approved');
  const approvedLetters = d.letters.filter((l) => l.status === 'approved');
  const link = (key: 'cv_version_id' | 'letter_version_id') => async (v: string) => {
    try { await putApp(job.id, { [key]: v ? Number(v) : null }); toast('Updated'); } catch (e) { toast((e as Error).message, true); }
    reload();
  };
  return <Card className="my-1.5">
    <h3>Apply for this job</h3>
    <Row className="my-1.5">
      <label className="mb-0" htmlFor="app-status">Status</label>
      <Select id="app-status" className="!w-auto" value={a?.status || ''} options={app.meta.statuses} any={a ? null : 'Not tracked yet'}
        onChange={async (v) => { try { await putApp(job.id, { status: v }); toast(`Status: ${statusLabel(v)}`); } catch (e) { toast((e as Error).message, true); } reload(); }} />
      {a?.applied_at && <Pill tone={a.submission_source === 'site_confirmed' ? 'yes' : 'default'}>{`Applied ${fmtDate(a.applied_at)} · ${a.submission_source === 'site_confirmed' ? 'confirmed by the site' : 'self-reported'}`}</Pill>}
    </Row>
    {dups.data?.[0] && <Warn>{`Possible duplicate: ${dups.data[0].reason} (${dups.data[0].title}${dups.data[0].company ? ' at ' + dups.data[0].company : ''}).`}</Warn>}
    <Grid two className="my-1.5">
      <SelectField label="CV I am sending" value={a?.cv_version_id ? String(a.cv_version_id) : ''} onChange={link('cv_version_id')} options={approvedCv.map((v): [string, string] => [String(v.id), `v${v.version_no} (approved)`])} any={approvedCv.length ? 'None selected' : 'Approve a CV version first'} />
      <SelectField label="Cover letter I am sending" value={a?.letter_version_id ? String(a.letter_version_id) : ''} onChange={link('letter_version_id')} options={approvedLetters.map((l): [string, string] => [String(l.id), `v${l.version_no} (approved)`])} any="None / not required" />
    </Grid>
    <Tabs tabs={[['A', 'I will apply myself'], ['B', 'Help me fill the form'], ['C', 'Apply automatically']]} value={mode} onChange={setMode} />
    <Sub>{mode === 'A' ? <ModeA job={job} app={a} reload={reload} /> : mode === 'B' ? <ModeB job={job} reload={reload} /> : <ModeC job={job} reload={reload} />}</Sub>
    <TrackingForm job={job} a={a} reload={reload} />
  </Card>;
}

// ---- Mode A: manual assistance
function ModeA({ job, app, reload }: { job: Job; app: Application | null; reload: () => void }) {
  const q = useLoad(() => api<Rec[]>(`/api/applications/${job.id}/checklist`), [job.id]);
  const cv = app?.cv_version; const letter = app?.letter_version;
  return <Loaded q={q}>{(items) => <div>
    <Meta className="mb-1.5">You apply yourself: open the listing, attach your approved documents, answer the questions, and submit on the employer’s site.</Meta>
    <Row>
      {job.url ? <LinkBtn variant="primary" href={job.url} target="_blank" rel="noopener noreferrer">Open the job page ↗</LinkBtn> : <Pill tone="no">No URL saved</Pill>}
      {cv ? <><DlButton label={`CV v${cv.version_no} (PDF)`} url={`/api/cv-versions/${cv.id}/download?format=pdf`} /><DlButton label="CV (DOCX)" url={`/api/cv-versions/${cv.id}/download?format=docx`} /></> : <Pill>No approved CV linked</Pill>}
      {letter && <><DlButton label={`Letter v${letter.version_no} (PDF)`} url={`/api/letters/${letter.id}/download?format=pdf`} /><DlButton label="Letter (DOCX)" url={`/api/letters/${letter.id}/download?format=docx`} /></>}
    </Row>
    <h3 className="mt-2">Before you apply</h3>
    <Checklist jobId={job.id} items={items} />
    <Row className="my-1.5"><SubmittedButton jobId={job.id} reload={reload} /><Meta>Recorded as self-reported. This tool never claims a submission the site hasn’t confirmed.</Meta></Row>
  </div>}</Loaded>;
}
function Checklist({ jobId, items }: { jobId: number; items: Rec[] }) {
  const [done, setDone] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((i): [string, boolean] => [i.key as string, !!i.done])));
  return <div>{items.map((i) => <label key={i.key} className="my-1.5 flex items-start gap-2 text-sm text-ink">
    <input type="checkbox" data-key={i.key} className="mt-1" checked={done[i.key]} disabled={i.auto} onChange={async (e) => {
      const next: Record<string, boolean> = { ...done, [i.key as string]: e.target.checked }; setDone(next);
      const checklist = Object.fromEntries(items.filter((x) => !x.auto).map((x): [string, boolean] => [x.key as string, next[x.key as string]]));
      try { await putApp(jobId, { checklist }); } catch (err) { toast((err as Error).message, true); }
    }} />
    <span>{i.label}{i.auto && !i.done && <Pill tone="no" className="ml-1.5">not yet</Pill>}{i.hint && <Meta>{i.hint}</Meta>}</span></label>)}</div>;
}

// ---- Mode B: browser-assisted
function ReportView({ r }: { r: Rec }) {
  const Section = ({ title, rows, render }: { title: string; rows?: Rec[]; render: (x: Rec) => React.ReactNode }) => rows?.length ? <div className="my-1.5"><b>{title}</b><ul className="my-1 list-disc pl-5">{rows.map((x, i) => <li key={i}>{render(x)}</li>)}</ul></div> : null;
  return <div>
    {r.blockers?.length ? <Warn>{r.blockers.includes('captcha') ? 'A CAPTCHA is present. Solve it yourself in the browser window; this tool never attempts it. ' : ''}{r.blockers.includes('mfa') ? 'The page asks for a verification code. Enter it yourself. ' : ''}{r.message || ''}</Warn> : null}
    <Section title="Filled from your profile / saved answers" rows={r.filled} render={(x) => <><b>{x.label}</b>{`: ${x.value} `}<span className="text-[13px] text-mute">({x.source})</span></>} />
    <Section title="Files attached" rows={r.uploaded} render={(x) => <><b>{x.label}</b>{`: ${x.file}`}</>} />
    <Section title="Needs YOUR input (not guessed)" rows={r.needs_input} render={(x) => <><b>{x.label}</b>{x.required ? ' *' : ''}<Meta>{x.reason}</Meta></>} />
    <Section title="Left as is" rows={r.skipped} render={(x) => <><b>{x.label}</b>{`: ${x.reason}`}</>} />
  </div>;
}

function ModeB({ job, reload }: { job: Job; reload: () => void }) {
  const ui = uiFor(job.id);
  const q = useLoad(() => api(`/api/applications/${job.id}/modes`), [job.id]);
  const [fmt, setFmt] = useState('pdf');
  const [session, setSession] = useState<Rec | null>(ui.session ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<Rec | null>(null);
  const setS = (s: Rec | null) => { ui.session = s; setSession(s); };
  return <Loaded q={q}>{(modes) => !modes.assisted.available
    ? <><Warn>{modes.assisted.reason}</Warn><Meta>Use Mode A (Manual) for this listing.</Meta></>
    : <div>
      <Meta className="mb-1.5">Opens the application page in a Chrome window on this computer, fills ordinary fields from your profile, and attaches your approved documents. It stops before submitting. It never solves CAPTCHAs, logs in, ticks consent boxes, or guesses sensitive answers (salary, notice period, work authorization, visa, relocation).</Meta>
      <Row className="items-end"><SelectField label="Attach as" value={fmt} onChange={setFmt} options={[['pdf', 'PDF'], ['docx', 'DOCX']]} />
        <Btn variant="primary" busyLabel="Opening browser…" onAction={async () => {
          const r = await api(`/api/applications/${job.id}/assist/start`, { method: 'POST', body: { format: fmt } });
          if (!r.started) { setNotice(r.message || 'Not available for this site.'); return; }
          setNotice(null); setS(r);
        }}>{session ? 'Start again' : 'Open the form and fill what I can'}</Btn></Row>
      {notice && <><Warn>{notice}</Warn><Meta>Use Mode A (Manual) instead.</Meta></>}
      {session && <>
        <Warn>Nothing has been submitted. A browser window is open: review it, complete the items below, and press submit there yourself.</Warn>
        <ReportView r={session.report} />
        <Row className="my-1.5">
          <Btn busyLabel="Scanning…" onAction={async () => setS({ ...session, report: (await api(`/api/assist/${session.sessionId}/rescan`, { method: 'POST' })).report })}>Re-scan & fill</Btn>
          <Btn busyLabel="Reading…" onAction={async () => setSummary(await api(`/api/assist/${session.sessionId}/summary`))}>Show what will be submitted</Btn>
          <Btn onAction={async () => { try { await api(`/api/assist/${session.sessionId}`, { method: 'DELETE' }); } catch (e) { toast((e as Error).message, true); } setS(null); setSummary(null); }}>Close browser</Btn>
          <SubmittedButton jobId={job.id} reload={reload} />
        </Row></>}
      {session && summary && <div><h3>What will be submitted (read live from the page)</h3>
        <table><tbody>{(summary.fields as Rec[]).map((f, i) => <tr key={i}><td>{f.label || '(unlabelled)'}{f.required ? ' *' : ''}</td><td dir="auto">{f.value || <span className={f.required ? 'rounded-full border border-line px-2 text-xs text-bad' : 'text-[13px] text-mute'}>empty</span>}</td><td>{f.sensitive && <Pill>sensitive</Pill>}</td></tr>)}</tbody></table>
        <Meta>{summary.note}</Meta></div>}
    </div>}</Loaded>;
}

// ---- Mode C: approved automatic submission
function ModeC({ job, reload }: { job: Job; reload: () => void }) {
  const q = useLoad(() => api(`/api/applications/${job.id}/modes`), [job.id]);
  const [fmt, setFmt] = useState('pdf');
  const [prep, setPrep] = useState<Rec | null>(null);
  const [outcome, setOutcome] = useState<Rec | null>(null);
  const [ok, setOk] = useState(false);
  return <Loaded q={q}>{(modes) => !modes.automatic.available
    ? <><Warn>{modes.automatic.reason}</Warn><Meta>Automatic submission is only offered for sites/workflows that explicitly permit it. For everything else, control stays with you: use Mode A or B.</Meta></>
    : <div>
      <Meta className="mb-1.5">{`Adapter: ${modes.automatic.adapter}. Before anything is sent, the listing is re-verified, the employer/title must match, your approved CV/letter are checked, and required fields must come from your profile or saved answers. “Applied” is recorded only if the site confirms receipt.`}</Meta>
      <Row className="items-end"><SelectField label="Attach as" value={fmt} onChange={setFmt} options={[['pdf', 'PDF'], ['docx', 'DOCX']]} />
        <Btn variant="primary" busyLabel="Checking…" onAction={async () => { setOutcome(null); setOk(false); setPrep(await api(`/api/applications/${job.id}/auto-submit/prepare`, { method: 'POST', body: { format: fmt } })); }}>Run pre-submission checks</Btn></Row>
      {prep && !prep.permitted && <Warn>{prep.message}</Warn>}
      {prep?.permitted && <div>
        <ul className="my-2 list-none p-0">{(prep.checks as Rec[]).map((c, i) => <li key={i} className={cx('py-0.5', c.ok ? 'text-good' : 'text-bad')}>{`${c.ok ? '✓' : '✗'} ${c.label}`}{c.detail && <Meta>{c.detail}</Meta>}</li>)}</ul>
        {prep.summary && <div><h3>Summary of what will be submitted</h3>
          <Meta>{`${prep.summary.adapter} · ${prep.summary.job.title}${prep.summary.job.company ? ' at ' + prep.summary.job.company : ''} · CV ${prep.summary.cv_version || '—'}${prep.summary.letter_version ? ' · Letter ' + prep.summary.letter_version : ''} · ${String(prep.summary.format).toUpperCase()}`}</Meta>
          <table><tbody>{(prep.summary.fields as Rec[]).map((f, i) => <tr key={i}><td>{f.label}</td><td dir="auto">{f.value || <Pill tone="no">missing</Pill>}</td><td>{f.sensitive && <Pill>saved answer</Pill>}</td></tr>)}
            {(prep.summary.attachments as Rec[]).map((x, i) => <tr key={`a${i}`}><td>{x.kind === 'cv' ? 'CV file' : 'Cover letter file'}</td><td>{`${x.filename} (${Math.round(x.bytes / 1024)} KB)`}</td><td /></tr>)}</tbody></table></div>}
        {prep.ready ? <Row className="my-1.5">
          {!prep.preapproved && <Check checked={ok} onChange={setOk}>I have reviewed this summary and approve submitting this application.</Check>}
          <Btn variant="primary" disabled={!prep.preapproved && !ok} busyLabel="Submitting…" onAction={async () => {
            const r = await api(`/api/applications/${job.id}/auto-submit/confirm`, { method: 'POST', body: { approvalToken: prep.approvalToken, format: fmt } });
            setOutcome(r); if (r.confirmed) reload();
          }}>{prep.preapproved ? 'Submit now (pre-approved workflow)' : 'Approve & submit'}</Btn></Row>
          : <Warn>Not ready: fix the items marked ✗ (or apply manually).</Warn>}
      </div>}
      {outcome && (() => { const Box = outcome.confirmed ? Good : Warn; return <Box><b>{outcome.confirmed ? `Confirmed by the site${outcome.confirmation ? ': ' + outcome.confirmation : ''}` : outcome.submitted === false && !outcome.status ? 'Not submitted' : 'Not confirmed'}</b><div>{outcome.message || ''}</div></Box>; })()}
    </div>}</Loaded>;
}

// ---- tracking fields
function TrackingForm({ job, a, reload }: { job: Job; a: Application | null; reload: () => void }) {
  const app = useApp();
  const x: Rec = a || {};
  const [f, setF] = useState({ follow_up_date: (x.follow_up_date || '') as string, interview_dates: [...(x.interview_dates || [])] as string[], recruiter: { ...(x.recruiter || {}) } as Rec, confirmation: (x.confirmation || '') as string, allow_duplicate: !!x.allow_duplicate, notes: (x.notes || '') as string });
  const rec = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, recruiter: { ...f.recruiter, [k]: e.target.value } });
  return <details className="my-1.5">
    <summary>Notes, interview dates and follow-up reminders</summary>
    <Grid two className="my-1.5">
      <TextField label="Follow-up date" type="date" value={f.follow_up_date} onChange={(e) => setF({ ...f, follow_up_date: e.target.value })} />
      <TextField label="Submission confirmation / reference" value={f.confirmation} onChange={(e) => setF({ ...f, confirmation: e.target.value })} />
      <TextField label="Recruiter name" value={f.recruiter.name || ''} onChange={rec('name')} />
      <TextField label="Recruiter email" value={f.recruiter.email || ''} onChange={rec('email')} />
      <TextField label="Recruiter phone" value={f.recruiter.phone || ''} onChange={rec('phone')} />
      <TextField label="Recruiter notes" value={f.recruiter.notes || ''} onChange={rec('notes')} />
    </Grid>
    <Meta>Only enter recruiter details they have shared with you.</Meta>
    <div className="my-1.5"><label>Interview dates</label>
      {f.interview_dates.map((v, i) => <Row key={i} className="mb-1"><input type="datetime-local" aria-label={`Interview ${i + 1}`} value={v} className="flex-1 basis-40" onChange={(e) => setF({ ...f, interview_dates: f.interview_dates.map((y, j) => (j === i ? e.target.value : y)) })} />
        <Btn variant="danger" aria-label="Remove interview" onClick={() => setF({ ...f, interview_dates: f.interview_dates.filter((_, j) => j !== i) })}>×</Btn></Row>)}
      <Btn onClick={() => setF({ ...f, interview_dates: [...f.interview_dates, ''] })}>+ Add interview</Btn></div>
    <Check checked={f.allow_duplicate} onChange={(v) => setF({ ...f, allow_duplicate: v })}>Allow a duplicate application to this job (otherwise duplicates are blocked)</Check>
    <AreaField label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
    <Row className="my-1.5">
      <Btn variant="primary" busyLabel="Saving…" onAction={async () => { await putApp(job.id, { ...f, interview_dates: f.interview_dates.filter(Boolean) }); toast('Saved'); reload(); }}>Save</Btn>
      <Btn busyLabel="Checking…" onAction={async () => {
        const r = await api(`/api/jobs/${job.id}/check-listing`, { method: 'POST' });
        const expired = r.state === 'expired' || r.state === 'likely_expired';
        toast(`Listing: ${String(r.state).replace('_', ' ')}. ${r.detail}`, expired);
        if (expired && await askConfirm({ title: 'Mark as “Listing Expired”?', body: 'The listing looks closed. You can change the status back at any time.', confirmLabel: 'Mark expired' })) { await putApp(job.id, { status: 'listing_expired' }); reload(); }
      }}>Check the job is still open</Btn>
      <Btn variant="danger" onAction={async () => {
        if (await askConfirm({ title: 'Delete this job?', body: 'This removes the job and all its CV versions, cover letters and application data. It cannot be undone.', confirmLabel: 'Remove this job', danger: true })) { await api(`/api/jobs/${job.id}`, { method: 'DELETE' }); app.setSelected(null); app.go('jobs'); }
      }}>Remove this job</Btn>
    </Row>
  </details>;
}
