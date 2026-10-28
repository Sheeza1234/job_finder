import { useRef, useState } from 'react';
import { api, downloadFile, fmtDate, fmtWhen } from '../lib/api';
import { toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import { uiFor } from '../lib/jobui';
import type { Job, JobDetailData, Rec } from '../lib/types';
import { ActionLink, Btn, Card, Empty, Meta, Pill, Row, Select, cx } from '../components/ui';
import { Loaded } from '../components/Load';
import { autoFillFromCv } from '../components/CvUpload';
import { CvPanel } from '../components/CvPanel';

// Remembered while the app is open, like the old Studio filters.
const prefs = { openId: null as number | null, filter: '', status: '', jobId: '' };

export function Studio() {
  const app = useApp();
  const q = useLoad(async () => {
    const [st, jobs] = await Promise.all([api('/api/cv-studio'), api<{ jobs: Job[] }>('/api/jobs?limit=300&sort=score')]);
    return { st, jobs: jobs.jobs };
  });
  const [, bump] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const [jobId, setJobId] = useState(prefs.jobId);
  const [filter, setFilter] = useState(prefs.filter);
  const [status, setStatus] = useState(prefs.status);
  const [openId, setOpenIdState] = useState(prefs.openId);
  const setOpenId = (id: number | null) => { prefs.openId = id; setOpenIdState(id); };

  return <Loaded q={q}>{({ st, jobs }) => {
    const master = st.master as Rec | null;
    const versions = st.versions as Rec[];
    const rows = versions.filter((v) => (!status || v.status === status) && (!filter || `${v.job_title} ${v.company}`.toLowerCase().includes(filter.toLowerCase())));
    const open = versions.find((v) => v.id === openId);
    return <div className="grid gap-3">
      <Card>
        <h2>Step 1: upload your CV</h2>
        <Meta className="mb-2">Upload your CV (PDF or DOCX) and your profile is filled in from it automatically. You only add what is missing, and you can edit everything by hand. No job is needed for this step. Your CV file is never modified.</Meta>
        {master && <Row className="my-1.5"><Pill tone="yes">Master</Pill><b>{master.filename}</b>
          <Meta>{`uploaded ${fmtDate(master.created_at)} · ${master.text_chars ? master.text_chars + ' characters read' : 'no text extracted'}`}</Meta>
          <Btn onAction={async () => { const { url } = await api<{ url: string }>(`/api/documents/${master.id}/link`, { method: 'POST' }); window.location.href = url; }}>Download</Btn>
          <Btn onClick={() => app.go('profile')}>Pre-fill / edit profile from it</Btn></Row>}
        {st.documents.length > 1 && <Row className="my-1.5"><label className="mb-0">Use another uploaded CV as master:</label>
          <Select label="Master CV" className="!w-auto" value={master ? String(master.id) : ''} onChange={async (v) => { await api(`/api/documents/${v}/master`, { method: 'POST' }); q.reload(); }}
            options={(st.documents as Rec[]).map((d): [string, string] => [String(d.id), `${d.filename} (${fmtDate(d.created_at)})`])} /></Row>}
        <Meta className="my-1.5">Certificates, a portfolio PDF or other files? <ActionLink onClick={() => app.go('documents')}>Manage my other files</ActionLink>.</Meta>
        <Row className="my-1.5">
          <input ref={file} type="file" accept=".pdf,.docx,.txt,.md" aria-label="Choose a CV file to upload" />
          <Btn variant="primary" busyLabel="Uploading…" onAction={async () => {
            const f = file.current?.files?.[0]; if (!f) throw new Error('Choose a file first');
            const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', f);
            const r = await api('/api/documents', { method: 'POST', body: fd });
            toast(r.text_chars ? 'CV uploaded' : 'Uploaded, but no text could be read (scanned file?). Please fill in your profile manually.');
            if (r.text_chars) await autoFillFromCv(app, r.id);
            app.reload();
          }}>Upload CV & fill my profile</Btn></Row>
      </Card>

      {!jobs.length ? <Meta>Later: once you save a job (Jobs → Add job), you can tailor a CV for it here.</Meta>
        : <Card><h2>Step 2 (later): tailor a CV for a job</h2>
          <Meta className="mb-2">A tailored CV is a copy of your CV rewritten for one specific job: it reorders and rewords your real experience to match the posting, lists what the job asks for that you do not have, and never changes your original CV.</Meta>
          <Row><div className="min-w-[220px] flex-1"><Select label="Job to tailor a CV for" value={jobId} any="Choose a job…" onChange={(v) => { prefs.jobId = v; setJobId(v); }}
            options={jobs.map((j): [string, string] => [String(j.id), `${j.title}${j.company ? ' — ' + j.company : ''}${j.match_score != null ? ` (${j.match_score}%)` : ''}`])} /></div>
            <Btn variant="primary" busyLabel="Tailoring…" onAction={async () => {
              if (!jobId) throw new Error('Choose a job from the list first');
              const v = await api(`/api/jobs/${jobId}/tailor`, { method: 'POST' });
              setOpenId(v.id); Object.assign(uiFor(Number(jobId)), { cvId: v.id, cvTab: 'preview' }); toast(`Version ${v.version_no} created as a draft`); q.reload();
            }}>Tailor CV</Btn></Row></Card>}

      {versions.length > 0 && <Card>
        <Row spread><h2 className="mb-0">{`Tailored versions (${rows.length})`}</h2>
          <Row><input placeholder="Filter by job or employer" aria-label="Filter versions by job or employer" className="min-w-[180px] flex-1" value={filter} onChange={(e) => { prefs.filter = e.target.value; setFilter(e.target.value); }} />
            <Select label="Filter by status" className="!w-auto" value={status} any="All statuses" onChange={(v) => { prefs.status = v; setStatus(v); }} options={[['draft', 'Drafts'], ['approved', 'Approved']]} /></Row></Row>
        {rows.length ? <div className="overflow-x-auto"><table className="min-w-[720px]"><thead><tr>{['Job', 'Version', 'Status', 'Warnings', 'Created', 'Used in', ''].map((x) => <th key={x}>{x}</th>)}</tr></thead>
          <tbody>{rows.map((v) => <tr key={v.id} className={cx(v.id === openId && '[&>td]:bg-goodbg')}>
            <td dir="auto">{v.job_title}<Meta>{v.company || ''}</Meta></td><td>{`v${v.version_no}${v.origin.includes('edit') ? ' ✎' : ''}`}</td>
            <td><Pill tone={v.status === 'approved' ? 'yes' : 'default'}>{v.status}</Pill></td><td>{v.warnings ? <Pill tone="no">{`⚠ ${v.warnings}`}</Pill> : '–'}</td>
            <td className="text-[13px] text-mute">{fmtDate(v.created_at)}</td><td>{v.used_count ? `${v.used_count} application${v.used_count === 1 ? '' : 's'}` : '–'}</td>
            <td><Row><Btn onClick={() => { setOpenId(v.id); uiFor(v.job_id).cvId = v.id; bump((n) => n + 1); }}>Open</Btn>
              <Btn busyLabel="…" onAction={() => downloadFile(`/api/cv-versions/${v.id}/download?format=pdf`)}>PDF</Btn>
              <Btn busyLabel="…" onAction={() => downloadFile(`/api/cv-versions/${v.id}/download?format=docx`)}>DOCX</Btn></Row></td></tr>)}</tbody></table></div>
          : <Empty>No tailored versions yet.</Empty>}
      </Card>}
      {open && <VersionEditor key={`${open.id}`} v={open} reload={q.reload} />}
    </div>;
  }}</Loaded>;
}

function VersionEditor({ v, reload }: { v: Rec; reload: () => void }) {
  const app = useApp();
  const q = useLoad(async () => { const [d, hist] = await Promise.all([api<JobDetailData>(`/api/jobs/${v.job_id}`), api(`/api/cv-versions/${v.id}/history`)]); return { d, hist }; }, [v.id]);
  return <div className="grid gap-2">
    <Loaded q={q}>{({ d, hist }) => <>
      <Row spread><h2 dir="auto" className="mb-0">{`${d.job.title}${d.job.company ? ' — ' + d.job.company : ''}`}</h2><Btn onClick={() => app.openJob(v.job_id)}>Open job</Btn></Row>
      <CvPanel job={d.job} d={d} reload={reload} />
      <Card><h3>{`History of v${hist.version_no}`}</h3>
        <ul className="my-1 list-disc pl-5">{(hist.events as Rec[]).map((e, i) => <li key={i}><span className="text-[13px] text-mute">{`${fmtWhen(e.at)} · `}</span>{e.event}</li>)}</ul>
        {hist.changes.length > 0 && <><b>What the tailoring changed</b><ul dir="auto" className="my-1 list-disc pl-5">{(hist.changes as Rec[]).map((c, i) => <li key={i}><b>{c.section ? `${c.section}: ` : ''}</b>{c.change}{c.reason && <span className="text-[13px] text-mute">{` — ${c.reason}`}</span>}</li>)}</ul></>}
      </Card></>}</Loaded>
  </div>;
}
