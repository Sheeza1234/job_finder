import { useRef, useState } from 'react';
import { api, csv, fmtDate, lines } from '../lib/api';
import { askConfirm, toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import type { DocRow, Profile, Rec } from '../lib/types';
import { AreaField, Btn, Card, CheckPills, Good, Grid, Meta, Pill, Row, Select, TextField, Warn, cx } from '../components/ui';
import { Loaded } from '../components/Load';
import { autoFillFromCv, CvUpload } from '../components/CvUpload';
import { TagEditor } from '../components/TagEditor';

type Draft = Profile;
const clone = (p: Profile): Draft => {
  const d = JSON.parse(JSON.stringify(p)) as Draft;
  // Starter-list picks from older versions become ordinary tags.
  d.preferredTitles = [...new Set([...d.preferredTitles, ...d.categories])]; d.categories = [];
  return d;
};

export function ProfileView() {
  const q = useLoad(async () => {
    const [status, docs] = await Promise.all([api<Rec>('/api/profile/status'), api<DocRow[]>('/api/documents')]);
    return { status, cvDocs: docs.filter((d) => d.kind === 'cv' && d.text_chars > 0) };
  });
  return <Loaded q={q}>{(d) => <ProfileForm status={d.status} cvDocs={d.cvDocs} />}</Loaded>;
}

function ProfileForm({ status, cvDocs }: { status: Rec; cvDocs: DocRow[] }) {
  const app = useApp();
  const [p, setP] = useState<Draft>(() => clone(app.profile));
  const [dirty, setDirty] = useState(false);
  const [docId, setDocId] = useState(String(cvDocs[0]?.id ?? ''));
  const missing = new Set<string>((status.missing as Rec[]).map((m) => m.key));
  const basics = useRef<HTMLDivElement>(null);
  const imp = status.import as Rec | null;

  const edit = (fn: (d: Draft) => void) => { setP((cur) => { const next = JSON.parse(JSON.stringify(cur)) as Draft; fn(next); return next; }); setDirty(true); };
  const text = (key: keyof Draft, label: string, type = 'text') => <TextField label={label} type={type} missing={missing.has(key as string)} value={String(p[key] ?? '')} onChange={(e) => edit((d) => { (d as Rec)[key] = e.target.value; })} />;
  const list = (key: 'skills' | 'languages' | 'achievements', label: string, sep: ',' | '\n') =>
    <AreaField label={label} missing={missing.has(key)} defaultValue={p[key].join(sep === ',' ? ', ' : '\n')} onChange={(e) => edit((d) => { d[key] = sep === ',' ? csv(e.target.value) : lines(e.target.value); })} />;

  const choice = <div className="my-1.5 grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-3">
    <div className="choicebox min-w-0 rounded-xl border border-line bg-bg p-3.5"><h3 className="mb-1">Option 1: fetch details from your CV</h3>
      <Meta className="mb-2">Upload your CV (PDF or DOCX). We read it and fill in this page; you only add what is missing.</Meta>
      <CvUpload />
      {cvDocs.length > 0 && <Row className="my-1.5"><Meta>Or re-read one you already uploaded:</Meta>
        <Select label="CV to re-read" className="!w-auto" value={docId} onChange={setDocId} options={cvDocs.map((d): [string, string] => [String(d.id), d.filename])} />
        <Btn busyLabel="Reading CV…" onAction={async () => { await autoFillFromCv(app, Number(docId)); app.reload(); }}>Re-read (fills empty fields only)</Btn></Row>}
    </div>
    <div className="choicebox min-w-0 rounded-xl border border-line bg-bg p-3.5"><h3 className="mb-1">Option 2: add details manually</h3>
      <Meta className="mb-2">Fill in the sections below yourself. You can do this instead of, or after, uploading a CV. Everything stays editable.</Meta>
      <Btn onClick={() => basics.current?.scrollIntoView({ behavior: 'smooth' })}>Go to the form ↓</Btn></div>
  </div>;

  return <div className="grid gap-3">
    <Card>
      <h2>My profile</h2>
      <Meta className="mb-2">Upload your CV and this page fills itself in; you only add what is missing. Everything can also be edited by hand. This is the source of truth for matching, tailoring and cover letters, so keep it accurate.</Meta>
      {imp && <Good>{`Filled automatically from ${imp.filename} on ${fmtDate(imp.at)}. Please check each section; automatic reading can make mistakes.`}
        <Row className="mt-1.5"><Btn variant="danger" onClick={async () => {
          if (await askConfirm({ title: 'Undo the automatic fill?', body: 'Your profile goes back to exactly how it was before the CV was read. Anything you typed since then is lost.', confirmLabel: 'Undo auto-fill', danger: true })) {
            await api('/api/profile/undo-import', { method: 'POST' }); app.setProfile(await api<Profile>('/api/profile')); toast('Restored your previous profile'); app.reload();
          }
        }}>Undo auto-fill</Btn></Row></Good>}
      {status.missing.length
        ? <Warn><b>Still missing: </b>{(status.missing as Rec[]).map((m) => m.label).join(', ')}. Add these below; they are highlighted. Only these are needed to tailor your CV well.</Warn>
        : <Good>All the essentials are filled in.</Good>}
      {cvDocs.length ? <details className="my-1.5"><summary>Upload a different CV, or read my CV again</summary>{choice}</details> : choice}
    </Card>

    <Card><div ref={basics} id="basics" className="scroll-mt-24" />
      <h3>Basics</h3>
      <Grid two className="my-1.5">
        {text('fullName', 'Full name')}{text('email', 'Email', 'email')}{text('phone', 'Phone')}{text('location', 'Current location')}
        {text('headline', 'Headline')}{text('yearsExperience', 'Total years of experience', 'number')}
        {text('linkedinUrl', 'LinkedIn URL (optional)')}{text('websiteUrl', 'Personal website (optional)')}{text('portfolioUrl', 'Portfolio URL')}
      </Grid>
      <AreaField label="Professional summary" missing={missing.has('summary')} value={p.summary} onChange={(e) => edit((d) => { d.summary = e.target.value; })} />
    </Card>

    <TagEditor profile={p} onChange={(titles) => edit((d) => { d.preferredTitles = titles; })} />

    <Card><h3>Skills & languages</h3><Meta className="my-1">Separate with commas. Only list skills you really have.</Meta>
      <div className="grid gap-2">{list('skills', 'Skills', ',')}{list('languages', 'Languages', ',')}</div></Card>

    <Repeater title="Work experience" missing={missing.has('experience')} items={p.experience}
      blank={() => ({ id: '', title: '', company: '', location: '', start: '', end: '', current: false, bullets: [] })}
      onAdd={(b) => edit((d) => { d.experience.push(b); })} onRemove={(i) => edit((d) => { d.experience.splice(i, 1); })}
      render={(e, i) => <div className="grid gap-2">
        <Grid two>{(['title:Job title', 'company:Company', 'location:Location', 'start:Start (YYYY-MM)', 'end:End (YYYY-MM)'] as const).map((s) => { const [k, l] = s.split(':') as [keyof typeof e, string];
          return <TextField key={k} label={l} value={String(e[k] ?? '')} onChange={(ev) => edit((d) => { (d.experience[i] as Rec)[k] = ev.target.value; })} />; })}</Grid>
        <AreaField label="Responsibilities & results (one per line)" defaultValue={e.bullets.join('\n')} onChange={(ev) => edit((d) => { d.experience[i].bullets = lines(ev.target.value); })} /></div>} />

    <Repeater title="Education" missing={missing.has('education')} items={p.education} blank={() => ({ id: '', degree: '', institution: '', year: '', notes: '' })}
      onAdd={(b) => edit((d) => { d.education.push(b); })} onRemove={(i) => edit((d) => { d.education.splice(i, 1); })}
      render={(e, i) => <Grid two>{(['degree:Degree', 'institution:Institution', 'year:Year', 'notes:Notes'] as const).map((s) => { const [k, l] = s.split(':') as [keyof typeof e, string];
        return <TextField key={k} label={l} value={String(e[k] ?? '')} onChange={(ev) => edit((d) => { (d.education[i] as Rec)[k] = ev.target.value; })} />; })}</Grid>} />

    <details className="optional rounded-xl border border-line bg-card px-4 py-3"><summary>More about me (optional): certifications, projects, achievements</summary>
      <div className="mt-2 grid gap-3">
        <Repeater title="Certifications" items={p.certifications} blank={() => ({ id: '', name: '', issuer: '', year: '' })}
          onAdd={(b) => edit((d) => { d.certifications.push(b); })} onRemove={(i) => edit((d) => { d.certifications.splice(i, 1); })}
          render={(e, i) => <Grid two>{(['name:Certification', 'issuer:Issuer', 'year:Year'] as const).map((s) => { const [k, l] = s.split(':') as [keyof typeof e, string];
            return <TextField key={k} label={l} value={String(e[k] ?? '')} onChange={(ev) => edit((d) => { (d.certifications[i] as Rec)[k] = ev.target.value; })} />; })}</Grid>} />
        <Repeater title="Projects" items={p.projects} blank={() => ({ id: '', name: '', description: '', url: '', tech: [] })}
          onAdd={(b) => edit((d) => { d.projects.push(b); })} onRemove={(i) => edit((d) => { d.projects.splice(i, 1); })}
          render={(e, i) => <div className="grid gap-2"><Grid two>
            <TextField label="Project" value={e.name} onChange={(ev) => edit((d) => { d.projects[i].name = ev.target.value; })} />
            <TextField label="URL" value={e.url} onChange={(ev) => edit((d) => { d.projects[i].url = ev.target.value; })} />
            <AreaField label="Tools used (comma)" defaultValue={e.tech.join(', ')} onChange={(ev) => edit((d) => { d.projects[i].tech = csv(ev.target.value); })} /></Grid>
            <AreaField label="Description" value={e.description} onChange={(ev) => edit((d) => { d.projects[i].description = ev.target.value; })} /></div>} />
        {list('achievements', 'Achievements (one per line; include only true ones)', '\n')}
      </div></details>

    <details className="optional rounded-xl border border-line bg-card px-4 py-3"><summary>Answers for application forms (optional)</summary>
      <Card className="mt-2"><h3>Saved application answers</h3>
        <Meta className="my-1.5">Used to fill sensitive application questions. Leave a field empty and the tool will ask you instead of guessing. Never auto-filled from anywhere else.</Meta>
        <Grid two>{([['salaryExpectation', 'Salary expectation (e.g. SAR 12,000/month)'], ['noticePeriod', 'Notice period'], ['expectedStartDate', 'Earliest start date'], ['workAuthorization', 'Work authorization / iqama status'], ['visaStatus', 'Visa status / sponsorship need'], ['relocation', 'Relocation answer']] as const).map(([k, l]) =>
          <TextField key={k} label={l} value={p.answers[k] ?? ''} onChange={(e) => edit((d) => { d.answers[k] = e.target.value; })} />)}</Grid></Card></details>

    <details className="optional rounded-xl border border-line bg-card px-4 py-3"><summary>Where and how I want to work (optional)</summary>
      <Card className="mt-2"><h3>Job preferences</h3>
        <Meta className="mt-1.5">Cities</Meta><CheckPills options={app.meta.cities.map((c): [string, string] => [c, c])} value={p.preferences.cities} onChange={(v) => edit((d) => { d.preferences.cities = v; })} />
        <Meta className="mt-1.5">Employment types</Meta><CheckPills options={[['full_time', 'Full-time'], ['part_time', 'Part-time'], ['contract', 'Contract']]} value={p.preferences.employmentTypes} onChange={(v) => edit((d) => { d.preferences.employmentTypes = v; })} />
        <Meta className="mt-1.5">Work modes</Meta><CheckPills options={[['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']]} value={p.preferences.workModes} onChange={(v) => edit((d) => { d.preferences.workModes = v; })} />
        <Row className="mt-2">{([['needsSponsorship', 'I need visa sponsorship'], ['openToRelocation', 'Open to relocating to Saudi Arabia']] as const).map(([k, l]) =>
          <label key={k} className="mb-0 inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-px text-xs text-mute"><input type="checkbox" checked={!!p.preferences[k]} onChange={(e) => edit((d) => { d.preferences[k] = e.target.checked; })} />{l}</label>)}</Row></Card></details>

    <div className={cx('savebar sticky bottom-0 flex flex-wrap items-center justify-end gap-3 rounded-xl border bg-card px-3.5 py-2.5 shadow-[0_-2px_8px_rgba(16,24,40,.08)] max-sm:[&>*]:flex-auto', dirty ? 'dirty border-accent' : 'border-line')}>
      <Meta>Your changes are saved only when you press Save.</Meta>
      <Btn variant="primary" busyLabel="Saving…" onAction={async () => { app.setProfile(await api<Profile>('/api/profile', { method: 'PUT', body: p })); toast('Saved'); app.reload(); }}>Save profile</Btn>
    </div>
  </div>;
}

/** Rows keep a stable React key (not the array index), so removing one never shows another row's uncontrolled text. */
function Repeater<T>({ title, items, blank, render, onAdd, onRemove, missing }: { title: string; items: T[]; blank: () => T; render: (item: T, i: number) => React.ReactNode; onAdd: (b: T) => void; onRemove: (i: number) => void; missing?: boolean }) {
  const next = useRef(items.length);
  const keys = useRef<number[]>(items.map((_, i) => i));
  return <Card className={cx(missing && 'needs border-l-4 border-l-warn')}>
    <Row spread><h3>{title}{missing && !items.length && <Pill tone="no" className="ml-2 text-[11px]">Missing</Pill>}</h3><Btn onClick={() => { keys.current.push(next.current++); onAdd(blank()); }}>+ Add</Btn></Row>
    {items.map((item, i) => <div key={keys.current[i]} className="my-2.5 grid gap-2 border-l-[3px] border-line pl-2.5">{render(item, i)}<div><Btn variant="danger" onClick={() => { keys.current.splice(i, 1); onRemove(i); }}>Remove</Btn></div></div>)}
  </Card>;
}
