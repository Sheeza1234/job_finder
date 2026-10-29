import { useEffect, useState } from 'react';
import { api, downloadFile, fmtDate } from '../lib/api';
import { toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import type { Rec } from '../lib/types';
import { ActionLink, Btn, Card, Check, Grid, Meta, Meter, Pill, Row, Select, SelectField, TextField, cx } from '../components/ui';
import { Loaded } from '../components/Load';
import { putApp } from '../components/ApplyPanel';

const today = () => new Date().toISOString().slice(0, 10);

export function Applications() {
  const app = useApp();
  const t = app.tracker;
  const query = () => {
    const p = new URLSearchParams();
    for (const k of ['q', 'status', 'employer', 'city', 'sort', 'dir'] as const) if (t[k]) p.set(k, t[k]);
    if (t.followup) p.set('followup_due', 'true');
    return p.toString();
  };
  const q = useLoad(() => api<Rec[]>(`/api/applications?${query()}`), [t.status, t.sort, t.dir, t.followup, t.q, t.employer, t.city]);
  const statusLabel = (k: string) => app.meta.statuses.find(([v]) => v === k)?.[1] ?? k;
  const moveTo = async (jobId: number, status: string) => {
    try { await putApp(jobId, { status }); toast(`Moved to ${statusLabel(status)}`); } catch (e) { toast((e as Error).message, true); }
    q.reload();
  };
  // Text filters apply on blur/Enter (like the old onchange), so typing doesn't refetch on every key.
  const text = (key: 'q' | 'employer' | 'city', label: string, ph: string) => <TextFilter label={label} placeholder={ph} value={t[key]} onCommit={(v) => app.setTracker({ [key]: v })} />;

  return <div className="grid gap-3">
    <Card>
      <Row spread><h2 className="mb-0">Applications</h2><Meta>{q.data ? `${q.data.length} application${q.data.length === 1 ? '' : 's'}` : ''}</Meta></Row>
      <Grid className="my-2">
        {text('q', 'Search', 'title, employer, notes, recruiter')}{text('employer', 'Employer', 'employer')}
        <SelectField label="Status" value={t.status} onChange={(v) => app.setTracker({ status: v })} options={app.meta.statuses} any="All statuses" />
        {text('city', 'City', 'e.g. Riyadh')}
        <SelectField label="Sort by" value={t.sort} onChange={(v) => app.setTracker({ sort: v })} options={[['updated_at', 'Last updated'], ['applied_at', 'Date applied'], ['discovered_at', 'Date discovered'], ['match_score', 'Match score'], ['follow_up_date', 'Follow-up date'], ['title', 'Job title'], ['employer', 'Employer'], ['status', 'Status']]} />
        <SelectField label="Order" value={t.dir} onChange={(v) => app.setTracker({ dir: v })} options={[['desc', 'Descending'], ['asc', 'Ascending']]} />
      </Grid>
      <Row>
        <div role="tablist" className="flex gap-1 border-b border-line">{(['board', 'table'] as const).map((k) => <button key={k} role="tab" aria-selected={t.mode === k} type="button" onClick={() => app.setTracker({ mode: k })}
          className={cx('border-b-2 px-3 py-1.5', t.mode === k ? 'border-accent font-semibold text-accent' : 'border-transparent')}>{k === 'board' ? 'Board' : 'Table'}</button>)}</div>
        <Check checked={t.followup} onChange={(v) => app.setTracker({ followup: v })}>Follow-ups due</Check>
        <Btn busyLabel="Exporting…" onAction={() => downloadFile(`/api/applications/export.csv?${query()}`)}>Export CSV</Btn>
      </Row>
    </Card>
    <Loaded q={q}>{(rows) => t.mode === 'board' ? <Board rows={rows} moveTo={moveTo} /> : <Table rows={rows} moveTo={moveTo} />}</Loaded>
  </div>;
}

function TextFilter({ label, placeholder, value, onCommit }: { label: string; placeholder: string; value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() !== value) onCommit(v.trim()); };
  return <TextField label={label} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

const score = (r: Rec) => (r.match_score == null ? null : <Meter score={r.match_score} method="ai" />);

function Board({ rows, moveTo }: { rows: Rec[]; moveTo: (id: number, s: string) => void }) {
  const app = useApp();
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const by: Record<string, Rec[]> = {};
  for (const r of rows) (by[r.status] ||= []).push(r);
  return <div className="flex items-start gap-2.5 overflow-x-auto pb-3">
    {app.meta.statuses.map(([key, label]) => <div key={key} data-status={key}
      onDragOver={(e) => { e.preventDefault(); setOver(key); }} onDragLeave={() => setOver(null)}
      onDrop={(e) => { e.preventDefault(); setOver(null); const id = Number(e.dataTransfer.getData('text/plain')); if (id && !(by[key] || []).some((r) => r.job_id === id)) moveTo(id, key); }}
      className={cx('col min-h-[120px] flex-[0_0_240px] rounded-xl border bg-card p-2 max-sm:flex-[0_0_78vw]', over === key ? 'border-accent bg-goodbg' : 'border-line')}>
      <div className="px-1 pb-2 pt-1 text-[13px] font-bold">{label}<span className="text-[13px] font-normal text-mute">{` ${(by[key] || []).length}`}</span></div>
      {(by[key] || []).map((r) => {
        const overdue = !!r.follow_up_date && r.follow_up_date <= today();
        return <div key={r.job_id} draggable data-id={r.job_id} onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(r.job_id)); e.dataTransfer.effectAllowed = 'move'; setDragging(r.job_id); }} onDragEnd={() => setDragging(null)}
          className={cx('kcard mb-2 flex cursor-grab flex-col gap-1 rounded-[10px] border border-line bg-bg p-2', dragging === r.job_id && 'opacity-40')}>
          <ActionLink className="font-semibold text-ink no-underline" onClick={() => app.openJob(r.job_id)}><span dir="auto">{r.title}</span></ActionLink>
          <Meta><span dir="auto">{[r.employer, r.location].filter(Boolean).join(' · ')}</span></Meta>
          <Row>{score(r)}{r.cv_version && <Pill>{`CV ${r.cv_version}`}</Pill>}{r.applied_at && <Meta>{`applied ${fmtDate(r.applied_at)}${r.submission_source === 'site_confirmed' ? ' ✓' : ''}`}</Meta>}</Row>
          {r.follow_up_date && (overdue ? <Pill tone="no">{`Follow up ${r.follow_up_date}`}</Pill> : <Meta>{`Follow up ${r.follow_up_date}`}</Meta>)}
          {r.interview_dates.length ? <Meta>{`Interview ${String(r.interview_dates[0]).replace('T', ' ')}`}</Meta> : null}
          <Select label={`Move ${r.title} to…`} className="!px-1.5 !py-0.5 text-xs" value={key} options={app.meta.statuses} onChange={(v) => moveTo(r.job_id, v)} />
        </div>;
      })}
    </div>)}
  </div>;
}

function Table({ rows, moveTo }: { rows: Rec[]; moveTo: (id: number, s: string) => void }) {
  const app = useApp();
  const t = app.tracker;
  const dl = (label: string, url: string) => <ActionLink onClick={() => downloadFile(url).catch((x: Error) => toast(x.message, true))}>{label}</ActionLink>;
  if (!rows.length) return <Card className="p-6 text-center text-mute">No applications match. Open a job and tailor a CV or change its status to start tracking.</Card>;
  const Th = ({ label, k }: { label: string; k?: string }) => <th>{k ? <ActionLink onClick={() => app.setTracker({ dir: t.sort === k && t.dir === 'desc' ? 'asc' : 'desc', sort: k })}>{label + (t.sort === k ? (t.dir === 'asc' ? ' ▲' : ' ▼') : '')}</ActionLink> : label}</th>;
  return <Card><div className="overflow-x-auto"><table className="min-w-[1100px] max-[900px]:min-w-[900px]">
    <thead><tr><Th label="Job" k="title" /><Th label="Employer" k="employer" /><Th label="Location" /><Th label="Match" k="match_score" /><Th label="CV / Letter" /><Th label="Discovered" k="discovered_at" /><Th label="Applied" k="applied_at" /><Th label="Status" k="status" /><Th label="Follow-up" k="follow_up_date" /><Th label="Interviews" /><Th label="Recruiter" /><Th label="Confirmation" /></tr></thead>
    <tbody>{rows.map((r) => <tr key={r.job_id}>
      <td><ActionLink onClick={() => app.openJob(r.job_id)}><span dir="auto">{r.title}</span></ActionLink></td>
      <td dir="auto">{r.employer || ''}</td><td dir="auto">{r.location || ''}</td><td>{score(r)}</td>
      <td>{r.cv_version_id ? <>{dl(`CV ${r.cv_version}`, `/api/cv-versions/${r.cv_version_id}/download?format=pdf`)}{' '}</> : null}{r.letter_version_id ? dl(`Letter ${r.letter_version}`, `/api/letters/${r.letter_version_id}/download?format=pdf`) : null}{!r.cv_version_id && !r.letter_version_id ? '–' : null}</td>
      <td className="text-[13px] text-mute">{fmtDate(r.discovered_at)}</td><td className="text-[13px] text-mute">{fmtDate(r.applied_at)}</td>
      <td><Select label={`Status of ${r.title}`} value={r.status} options={app.meta.statuses} onChange={(v) => moveTo(r.job_id, v)} /></td>
      <td>{r.follow_up_date || ''}</td><td className="text-[13px] text-mute">{(r.interview_dates as string[]).map((x) => x.replace('T', ' ')).join('; ')}</td>
      <td className="text-[13px] text-mute">{[r.recruiter.name, r.recruiter.email].filter(Boolean).join(' · ')}</td>
      <td className="text-[13px] text-mute">{r.confirmation ? `${r.confirmation}${r.submission_source === 'site_confirmed' ? ' (site)' : ' (self)'}` : ''}</td></tr>)}</tbody></table></div></Card>;
}
