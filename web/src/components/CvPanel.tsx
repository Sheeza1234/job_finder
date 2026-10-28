import { useEffect, useState } from 'react';
import { api, csv, downloadFile, fmtDate, lines } from '../lib/api';
import { askConfirm, toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import { uiFor } from '../lib/jobui';
import type { CvVersionRow, Job, JobDetailData, LetterRow, Rec } from '../lib/types';
import { AreaField, Btn, Card, Chip, Meta, Pill, Row, Select, SelectField, Tabs, TextField, Warn, List, cx } from './ui';
import { Loaded } from './Load';

export const DlButton = ({ label, url }: { label: string; url: string }) => <Btn busyLabel="Preparing…" onAction={() => downloadFile(url)}>{label}</Btn>;

export function WarningsBlock({ list }: { list?: string[] }) {
  if (!list?.length) return null;
  return <Warn><b>{list.length} accuracy warning{list.length === 1 ? '' : 's'}: check each against your real history</b><List items={list} /></Warn>;
}

function VersionChips<T extends { id: number; status: string }>({ items, selectedId, onPick, labelOf }: { items: T[]; selectedId: number; onPick: (id: number) => void; labelOf: (v: T) => string }) {
  return <Row className="my-1.5">{items.map((v) => <Chip key={v.id} on={v.id === selectedId} approved={v.status === 'approved'} onClick={() => onPick(v.id)}>{labelOf(v)}</Chip>)}</Row>;
}

function CvModel({ m }: { m: Rec }) {
  const Sec = ({ title, children }: { title: string; children: React.ReactNode }) => <div className="mt-2.5"><div className="mb-1 border-b border-line text-xs font-bold uppercase tracking-wider">{title}</div>{children}</div>;
  return <div dir="auto" className="max-h-[520px] overflow-auto rounded-lg border border-line bg-bg p-4">
    <div className="text-xl font-bold">{m.name || '(add your name in Profile)'}</div>
    {m.headline && <div>{m.headline}</div>}
    <Meta>{(m.contact as string[]).join('  |  ')}</Meta>
    {m.summary && <Sec title="Summary"><p>{m.summary}</p></Sec>}
    {m.skills.length > 0 && <Sec title="Skills"><p>{(m.skills as string[]).join(', ')}</p></Sec>}
    {m.experience.length > 0 && <Sec title="Experience">{(m.experience as Rec[]).map((e, i) => <div key={i} className="my-1.5"><b>{[e.title, e.company].filter(Boolean).join(', ')}</b>{e.dates && <span className="text-[13px] text-mute">{`  (${e.dates})`}</span>}<List items={e.bullets} /></div>)}</Sec>}
    {m.projects.length > 0 && <Sec title="Projects">{(m.projects as Rec[]).map((p, i) => <div key={i} className="my-1.5"><b>{p.name}</b>{p.description && <div>{p.description}</div>}</div>)}</Sec>}
    {m.education.length > 0 && <Sec title="Education">{(m.education as Rec[]).map((e, i) => <div key={i}>{e.line}</div>)}</Sec>}
    {m.certifications.length > 0 && <Sec title="Certifications"><List items={m.certifications} /></Sec>}
  </div>;
}

export function CvPanel({ job, d, reload }: { job: Job; d: JobDetailData; reload: () => void }) {
  const app = useApp();
  const ui = uiFor(job.id);
  const versions = d.cv_versions;
  const sel: CvVersionRow | undefined = versions.find((v) => v.id === ui.cvId) || versions.find((v) => v.status === 'approved') || versions[0];
  return <Card className="my-1.5">
    <Row spread><h3>My CV for this job</h3>
      <Btn variant="primary" busyLabel="Writing your CV…" onAction={async () => { const v = await api(`/api/jobs/${job.id}/tailor`, { method: 'POST' }); ui.cvId = v.id; ui.cvTab = 'preview'; toast(`Version ${v.version_no} created as a draft. Review it, then approve.`); reload(); }}>Make a CV for this job</Btn></Row>
    <Meta className="my-1.5">This is a copy of your CV rewritten for this job, using only facts from your profile. Your original CV never changes. Read it, fix anything, then press “Use this CV” when you are happy.</Meta>
    {!sel ? <Meta>{app.status.ai ? 'No version yet.' : 'Set ANTHROPIC_API_KEY to enable tailoring.'}</Meta> : <>
      <VersionChips items={versions} selectedId={sel.id} onPick={(id) => { ui.cvId = id; reload(); }} labelOf={(v) => `v${v.version_no}${v.origin.includes('edit') ? ' ✎' : ''} · ${v.status}${v.warnings ? ` · ⚠${v.warnings}` : ''}`} />
      <CvVersion id={sel.id} versions={versions} ui={ui} reload={reload} />
    </>}
  </Card>;
}

function CvVersion({ id, versions, ui, reload }: { id: number; versions: CvVersionRow[]; ui: ReturnType<typeof uiFor>; reload: () => void }) {
  const q = useLoad(() => api(`/api/cv-versions/${id}`), [id]);
  const [tab, setTabState] = useState(ui.cvTab);
  const setTab = (t: typeof tab) => { ui.cvTab = t; setTabState(t); };
  return <Loaded q={q}>{(v) => <div>
    <Row className="my-1.5">
      {v.status === 'approved'
        ? <><Pill tone="yes">Ready to use ({fmtDate(v.approved_at)})</Pill><Btn onAction={async () => { await api(`/api/cv-versions/${v.id}/revoke`, { method: 'POST' }); reload(); }}>Stop using it</Btn></>
        : <Btn variant="primary" busyLabel="Approving…" onAction={async () => {
          let acknowledge = false;
          if (v.warnings.length) {
            if (!(await askConfirm({ title: 'Approve with accuracy warnings?', body: `This version has ${v.warnings.length} accuracy warning(s). Approve only if you have checked that every claim is true.`, items: v.warnings, confirmLabel: 'Approve anyway', danger: true }))) return;
            acknowledge = true;
          }
          await api(`/api/cv-versions/${v.id}/approve`, { method: 'POST', body: { acknowledge } }); toast('Approved. It is now linked to this application.'); reload();
        }}>Use this CV</Btn>}
      <DlButton label="Download as PDF" url={`/api/cv-versions/${v.id}/download?format=pdf`} />
      <DlButton label="Download as Word" url={`/api/cv-versions/${v.id}/download?format=docx`} />
      <Btn variant="danger" onAction={async () => {
        if (!(await askConfirm({ title: `Delete version ${v.version_no}?`, body: 'This version and its history will be removed. Your profile and original CV are not affected.', confirmLabel: 'Delete version', danger: true }))) return;
        await api(`/api/cv-versions/${v.id}`, { method: 'DELETE' }); ui.cvId = null; reload();
      }}>Delete</Btn>
    </Row>
    <WarningsBlock list={v.warnings} />
    <Tabs tabs={[['preview', 'Read it'], ['edit', 'Edit it'], ['compare', 'Compare with my original'], ['why', 'What changed and why']]} value={tab} onChange={setTab} />
    {tab === 'preview' && <CvModel m={v.model} />}
    {tab === 'edit' && <CvEdit ver={v} ui={ui} reload={reload} />}
    {tab === 'compare' && <CvCompare ver={v} versions={versions} ui={ui} />}
    {tab === 'why' && <CvWhy ver={v} />}
  </div>}</Loaded>;
}

function CvEdit({ ver, ui, reload }: { ver: Rec; ui: ReturnType<typeof uiFor>; reload: () => void }) {
  const c = ver.content;
  const [f, setF] = useState({ headline: c.headline as string, summary: c.summary as string, skills: [...c.skills] as string[], experience: (c.experience as Rec[]).map((e) => ({ id: e.id, bullets: [...e.bullets] as string[] })), projects: (c.projects as Rec[]).map((p) => ({ ...p })) });
  const expTitle = (id: string) => { const e = (ver.model.experience as Rec[]).find((x) => x.id === id); return e ? `${e.title}, ${e.company}` : id; };
  return <div>
    <Meta className="mb-2">Employers, titles, dates and education come from your profile and can’t be changed here (edit your Profile instead). Skills must exist in your profile. Saving re-checks every claim.</Meta>
    <div className="grid gap-2.5">
      <TextField label="Headline" value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} />
      <AreaField label="Summary" rows={4} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
      <AreaField label="Skills (comma separated, most relevant first)" rows={2} defaultValue={f.skills.join(', ')} onChange={(e) => setF({ ...f, skills: csv(e.target.value) })} />
      {f.experience.map((e, i) => <AreaField key={e.id} label={`${expTitle(e.id)} — one bullet per line`} rows={5} defaultValue={e.bullets.join('\n')}
        onChange={(ev) => setF({ ...f, experience: f.experience.map((x, j) => (j === i ? { ...x, bullets: lines(ev.target.value) } : x)) })} />)}
      {f.projects.map((p, i) => <AreaField key={p.id} label={`Project: ${(ver.model.projects as Rec[]).find((m) => m.id === p.id)?.name || p.id}`} rows={3} value={p.description}
        onChange={(ev) => setF({ ...f, projects: f.projects.map((x, j) => (j === i ? { ...x, description: ev.target.value } : x)) })} />)}
    </div>
    <Row className="mt-2"><Btn variant="primary" busyLabel="Saving…" onAction={async () => {
      const r = await api(`/api/cv-versions/${ver.id}`, { method: 'PUT', body: f });
      if (r.id !== ver.id) { ui.cvId = r.id; toast(`Saved as new draft v${r.version_no} (the approved version is untouched).`); } else toast('Saved');
      ui.cvTab = 'preview'; reload();
    }}>Save my changes</Btn></Row>
  </div>;
}

const DIFF: Record<string, string> = { add: 'bg-goodbg text-good', del: 'bg-warnbg text-bad line-through', same: '' };
function CvCompare({ ver, versions, ui }: { ver: Rec; versions: CvVersionRow[]; ui: ReturnType<typeof uiFor> }) {
  const [cmp, setCmp] = useState(ui.cmp || 'original');
  const q = useLoad(() => api(`/api/cv-versions/${ver.id}/compare?to=${encodeURIComponent(cmp)}`), [cmp]);
  useEffect(() => { ui.cmp = cmp; }, [cmp, ui]);
  const others = versions.filter((x) => x.id !== ver.id);
  return <div>
    <SelectField label="Compare with" value={cmp} onChange={setCmp} options={[['original', 'Original profile CV (unchanged)'], ...others.map((o): [string, string] => [String(o.id), `Version ${o.version_no}`])]} />
    <Loaded q={q}>{(r) => <>
      <Meta className="my-1.5">{`Left: ${r.left_label}  →  Right: ${r.right_label}. Red = removed or moved, green = added or reworded.`}</Meta>
      {(r.diff as Rec[]).map((s, i) => <div key={i} className="mt-2.5"><div className="mb-1 border-b border-line text-xs font-bold uppercase tracking-wider">{s.section}</div>
        {s.lines.length ? (s.lines as Rec[]).map((l, j) => <div key={j} dir="auto" className={cx('whitespace-pre-wrap rounded px-1.5 py-px font-mono text-[13px]', DIFF[l.type])}>{`${l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}${l.text}`}</div>) : <Meta>—</Meta>}</div>)}
    </>}</Loaded>
  </div>;
}

function CvWhy({ ver }: { ver: Rec }) {
  return <div>
    {ver.changes.length ? <div><b>Changes and the reason for each</b><ul dir="auto" className="my-1 list-disc pl-5">{(ver.changes as Rec[]).map((c, i) => <li key={i}><b>{c.section ? `${c.section}: ` : ''}</b>{c.change}{c.reason && <span className="text-[13px] text-mute">{` — because ${c.reason}`}</span>}</li>)}</ul></div> : <Meta>No change notes were recorded.</Meta>}
    {ver.keywords.length > 0 && <div className="my-1.5"><b>Job keywords used (each is backed by your profile)</b><ul className="my-1 list-disc pl-5">{(ver.keywords as Rec[]).map((k, i) => <li key={i}>{k.keyword}{k.supported_by && <span className="text-[13px] text-mute">{` ← ${k.supported_by}`}</span>}</li>)}</ul></div>}
    {ver.gaps.length ? <div className="my-1.5"><b>Gaps: job requirements your profile does not show (not added to the CV)</b><ul dir="auto" className="my-1 list-disc pl-5">{(ver.gaps as Rec[]).map((g, i) => <li key={i}>{g.requirement}{g.note && <span className="text-[13px] text-mute">{` — ${g.note}`}</span>}</li>)}</ul></div> : <Meta className="my-1.5">No gaps detected.</Meta>}
  </div>;
}

// ---------------- cover letters ----------------
export function LetterPanel({ job, d, reload }: { job: Job; d: JobDetailData; reload: () => void }) {
  const ui = uiFor(job.id);
  const letters = d.letters;
  const sel: LetterRow | undefined = letters.find((l) => l.id === ui.letterId) || letters.find((l) => l.status === 'approved') || letters[0];
  const [lang, setLang] = useState('en');
  return <Card className="my-1.5">
    <Row spread><h3>Cover letter</h3><Row>
      <Select label="Letter language" value={lang} onChange={setLang} options={[['en', 'English'], ['ar', 'Arabic']]} className="!w-auto" />
      <Btn busyLabel="Writing…" onAction={async () => { const l = await api(`/api/jobs/${job.id}/cover-letter`, { method: 'POST', body: { language: lang } }); ui.letterId = l.id; toast('Draft letter created. Review and edit it, then approve.'); reload(); }}>Write a cover letter</Btn></Row></Row>
    {!sel ? <Meta className="mt-1.5">No cover letter yet. Generate one when the application asks for it.</Meta> : <>
      <VersionChips items={letters} selectedId={sel.id} onPick={(id) => { ui.letterId = id; reload(); }} labelOf={(l) => `v${l.version_no} · ${l.language} · ${l.status}${l.warnings ? ` · ⚠${l.warnings}` : ''}`} />
      <LetterBody id={sel.id} ui={ui} reload={reload} />
    </>}
  </Card>;
}

function LetterBody({ id, ui, reload }: { id: number; ui: ReturnType<typeof uiFor>; reload: () => void }) {
  const q = useLoad(() => api(`/api/letters/${id}`), [id]);
  return <Loaded q={q}>{(l) => <LetterEditor key={l.id} l={l} ui={ui} reload={reload} />}</Loaded>;
}
function LetterEditor({ l, ui, reload }: { l: Rec; ui: ReturnType<typeof uiFor>; reload: () => void }) {
  const [text, setText] = useState<string>(l.text);
  return <div>
    <WarningsBlock list={l.warnings} />
    <textarea dir="auto" className="min-h-[300px]" aria-label="Cover letter text" value={text} onChange={(e) => setText(e.target.value)} />
    <Row className="my-1.5">
      <Btn busyLabel="Saving…" onAction={async () => { const r = await api(`/api/letters/${l.id}`, { method: 'PUT', body: { text } }); if (r.id !== l.id) { ui.letterId = r.id; toast('Saved as a new draft (the approved letter is untouched).'); } else toast('Saved'); reload(); }}>Save my changes</Btn>
      {l.status === 'approved'
        ? <><Pill tone="yes">Approved</Pill><Btn onAction={async () => { await api(`/api/letters/${l.id}/revoke`, { method: 'POST' }); reload(); }}>Stop using it</Btn></>
        : <Btn variant="primary" busyLabel="Approving…" onAction={async () => {
          let acknowledge = false;
          if (l.warnings.length) { if (!(await askConfirm({ title: 'Approve with accuracy warnings?', body: 'Approve only if every claim is true.', items: l.warnings, confirmLabel: 'Approve anyway', danger: true }))) return; acknowledge = true; }
          await api(`/api/letters/${l.id}/approve`, { method: 'POST', body: { acknowledge } }); toast('Approved and linked to this application.'); reload();
        }}>Use this letter</Btn>}
      <Btn onAction={() => navigator.clipboard.writeText(text).then(() => toast('Copied'))}>Copy</Btn>
      <DlButton label="PDF" url={`/api/letters/${l.id}/download?format=pdf`} /><DlButton label="DOCX" url={`/api/letters/${l.id}/download?format=docx`} />
      <Btn variant="danger" onAction={async () => { if (!(await askConfirm({ title: 'Delete this cover letter version?', confirmLabel: 'Delete', danger: true }))) return; await api(`/api/letters/${l.id}`, { method: 'DELETE' }); ui.letterId = null; reload(); }}>Delete</Btn>
    </Row>
    <Meta>Always read and edit before sending. Arabic letters export to DOCX only.</Meta>
  </div>;
}
