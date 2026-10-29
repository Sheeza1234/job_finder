import { useState } from 'react';
import { api, fmtDate, LABEL, RELOC, SPONSOR } from '../lib/api';
import { askConfirm, toast } from '../lib/bus';
import { useApp, useLoad, type JobFilters } from '../lib/app';
import type { Job, JobDetailData, Rec } from '../lib/types';
import { ActionLink, AreaField, Btn, Card, Check, EmptyState, Grid, LinkBtn, Meta, Meter, Pill, Row, SelectField, TextField, Warn, cx, toneOf } from '../components/ui';
import { Loaded } from '../components/Load';
import { JobActions } from '../components/JobActions';
import { ApplyPanel } from '../components/ApplyPanel';
import { CvPanel, LetterPanel } from '../components/CvPanel';

export function Jobs() {
  const [importing, setImporting] = useState(false);
  if (importing) return <ImportJob done={() => setImporting(false)} />;
  return <JobsList onImport={() => setImporting(true)} />;
}

function JobsList({ onImport }: { onImport: () => void }) {
  const app = useApp();
  const { filters: f, setFilters, status, meta, selected, setSelected } = app;
  const [draft, setDraft] = useState<JobFilters>(f);               // edits apply on Search, like the old form
  const facets = useLoad(() => api<{ cities: string[]; industries: string[] }>('/api/jobs/facets').catch(() => ({ cities: [], industries: [] })));
  const list = useLoad(async () => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (k !== 'fit' && v != null && v !== '') qs.set(k, String(v));
    qs.set('limit', '100');
    if (f.fit !== false) { qs.set('min_score', '50'); qs.set('fit', '1'); }   // default: only jobs that fit this person
    return api<{ total: number; hidden: number; jobs: Job[] }>(`/api/jobs?${qs}`);
  }, [f]);
  const set = (k: string) => (v: string) => setDraft((d) => { const n = { ...d }; if (v) n[k] = v; else delete n[k]; return n; });
  const apply = () => setFilters({ ...draft });
  const cities = [...new Set([...meta.cities, ...(facets.data?.cities ?? [])])];
  const saudiSource = status.providers.some((p) => ['jooble', 'jsearch'].includes(p.id) && p.enabled);
  const activeFilters = Object.keys(f).filter((k) => k !== 'sort' && k !== 'fit').length;

  const fetchNew = async () => {
    if (status.mode === 'demo') return toast('Demo mode shows sample jobs only. Leave demo mode in Settings to search for real jobs.', true);
    if (!status.providers.some((p) => p.enabled)) return toast('No online job source is set up yet. You can still add jobs you find with “Add a job I found”.', true);
    const r = await api('/api/jobs/search', { method: 'POST', body: { includeRemote: true, cities: f.city ? [f.city as string] : [] } });
    const errs: string[] = (r.providers as Rec[]).flatMap((p) => (p.errors as string[]).map((e) => `${p.id}: ${e}`));
    toast(`Fetched ${r.fetched}, kept ${r.kept} relevant, ${r.added} new.${errs.length ? ' Some queries failed: ' + errs[0] : ''}`, !!errs.length && !r.fetched);
    list.reload();
  };

  return <>
    {!saudiSource && <Warn><b>You are only seeing remote jobs. </b>Jobs in Saudi and Pakistani cities need a job source. It takes a minute and Jooble is free.{' '}
      <Btn onClick={() => app.go('settings')}>Connect job sources</Btn></Warn>}
    <Card>
      <Row className="items-end max-sm:[&>*]:basis-full">
        <div className="min-w-[200px] flex-1"><TextField label="Search jobs" placeholder="Job title or keyword, e.g. designer" value={(draft.q as string) || ''} onChange={(e) => set('q')(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} /></div>
        <SelectField label="City" className="min-w-[180px] max-sm:min-w-0" value={(draft.city as string) || ''} onChange={set('city')} options={cities} any="Anywhere in Saudi Arabia" />
        <Btn variant="primary" onClick={apply}>Search</Btn>
      </Row>
      <Check className="mt-2" checked={f.fit !== false} onChange={(v) => setFilters({ ...f, fit: v })}>Only show jobs that fit me</Check>
      <Row className="my-1.5">
        <Btn busyLabel="Searching…" onAction={fetchNew}>Find new jobs online</Btn>
        <Btn onClick={onImport}>Add a job I found</Btn>
        <Btn busyLabel="Checking…" onAction={async () => {
          const { count } = await api<{ count: number }>('/api/jobs/cleanup', { method: 'POST', body: { dryRun: true } });
          if (!count) return toast('Nothing to remove: every saved job fits your profile or is one you added or are tracking.');
          if (!(await askConfirm({ title: `Remove ${count} job${count === 1 ? '' : 's'} that don’t fit?`, body: 'These jobs do not match your profile or job titles. Jobs you added yourself or saved to My applications are never removed. You can find them again with “Find new jobs online”.', confirmLabel: `Remove ${count}`, danger: true }))) return;
          await api('/api/jobs/cleanup', { method: 'POST', body: {} });
          toast(`Removed ${count} job${count === 1 ? '' : 's'} that did not fit.`); list.reload();
        }}>Remove jobs that don’t fit</Btn>
        <Btn onClick={() => { setDraft({}); setFilters({}); }}>Clear</Btn>
      </Row>
      <OtherSites city={(draft.city as string) || ''} onImport={onImport} />
      <details className="my-1.5">
        <summary>More filters</summary>
        <Grid className="my-1.5">
          <SelectField label="Sort by" value={(draft.sort as string) || 'score'} onChange={set('sort')} options={[['score', 'Best match first'], ['posted', 'Newest first']]} />
          <SelectField label="Posted" value={(draft.posted_within_days as string) || ''} onChange={set('posted_within_days')} options={[['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days']]} any="Any time" />
          <SelectField label="Job type" value={(draft.employment_type as string) || ''} onChange={set('employment_type')} options={['full_time', 'part_time', 'contract', 'internship'].map((k): [string, string] => [k, LABEL[k]])} any="Any" />
          <SelectField label="Where you work" value={(draft.work_mode as string) || ''} onChange={set('work_mode')} options={[['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']]} any="Any" />
          <SelectField label="Level" value={(draft.experience_level as string) || ''} onChange={set('experience_level')} options={[['entry', 'Entry'], ['mid', 'Mid'], ['senior', 'Senior'], ['lead', 'Lead']]} any="Any" />
          <SelectField label="Visa sponsorship" value={(draft.sponsorship as string) || ''} onChange={set('sponsorship')} options={[['yes', 'Offered (stated in the job)'], ['no', 'Not offered'], ['not_specified', 'Not mentioned']]} any="Any" />
          <SelectField label="Relocation help" value={(draft.relocation as string) || ''} onChange={set('relocation')} options={[['yes', 'Offered (stated in the job)'], ['not_specified', 'Not mentioned']]} any="Any" />
          <TextField label="Lowest salary" type="number" placeholder="e.g. 8000" value={(draft.salary_min as string) || ''} onChange={(e) => set('salary_min')(e.target.value.trim())} />
          <TextField label="Highest salary" type="number" placeholder="e.g. 20000" value={(draft.salary_max as string) || ''} onChange={(e) => set('salary_max')(e.target.value.trim())} />
          <SelectField label="Industry" value={(draft.industry as string) || ''} onChange={set('industry')} options={facets.data?.industries ?? []} any="Any" />
          <TextField label="Skills the job needs (commas)" placeholder="figma, seo" value={(draft.skills as string) || ''} onChange={(e) => set('skills')(e.target.value.trim())} />
          <TextField label="Company" placeholder="company name" value={(draft.company as string) || ''} onChange={(e) => set('company')(e.target.value.trim())} />
        </Grid>
        <Btn variant="primary" onClick={apply}>Search with these filters</Btn>
      </details>
    </Card>

    <div className="split mt-1.5 grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-4 max-[900px]:grid-cols-1">
      <div>
        <Loaded q={list}>{({ total, hidden, jobs }) => <>
          <Meta className="my-1.5">{`${total} job${total === 1 ? '' : 's'}${f.fit !== false ? ' that fit you' : ''}`}
            {hidden ? <>{' · '}{`${hidden} weaker match${hidden === 1 ? '' : 'es'} hidden. `}<ActionLink onClick={() => setFilters({ ...f, fit: false })}>Show them</ActionLink></> : null}</Meta>
          {jobs.length ? jobs.map((j) => <JobCard key={j.id} job={j} selected={selected === j.id} onSelect={() => setSelected(j.id)} />)
            : <EmptyState title={activeFilters ? 'No jobs match these filters' : 'No jobs yet'} body={activeFilters ? 'Try removing a filter.' : 'Fetch from a configured source, or add a posting by URL or pasted text. Nothing is shown until it is real.'} />}
        </>}</Loaded>
      </div>
      <div>{selected ? <JobDetail key={selected} id={selected} onChanged={list.reload} /> : <Card className="p-6 text-center text-mute">Pick a job on the left to see what it needs and how well you fit.</Card>}</div>
    </div>
  </>;
}

/** Sites with no public jobs API whose terms forbid automated collection. Instead of scraping them, each button opens a
 *  search limited to that site in the user's own browser; the job can then be added with "Add a job I found". */
const OTHER_SITES: Record<'SA' | 'PK', [string, string][]> = {
  SA: [['Bayt', 'bayt.com'], ['GulfTalent', 'gulftalent.com'], ['NaukriGulf', 'naukrigulf.com'], ['Sabbar', 'sabbar.com']],
  PK: [['Rozee.pk', 'rozee.pk'], ['Mustakbil', 'mustakbil.com'], ['Indeed Pakistan', 'pk.indeed.com']],
};
export const siteSearchUrl = (domain: string, title: string, place: string) =>
  `https://www.google.com/search?q=${encodeURIComponent(`site:${domain} ${title} jobs ${place}`)}`;

function OtherSites({ city, onImport }: { city: string; onImport: () => void }) {
  const { profile, meta } = useApp();
  const titles = [...new Set([...profile.preferredTitles, ...profile.categories])];
  const [title, setTitle] = useState('');
  const cityMarket = meta.markets.find((m) => m.cities.includes(city))?.code;
  const [picked, setPicked] = useState<'SA' | 'PK' | ''>('');
  const market = (picked || cityMarket || 'SA') as 'SA' | 'PK';
  const country = meta.markets.find((m) => m.code === market)?.country ?? 'Saudi Arabia';
  const place = city && cityMarket === market ? `${city} ${country}` : country;
  const chosen = title || titles[0] || profile.headline.split(/[·|,]/)[0]?.trim() || '';
  const names = OTHER_SITES[market].map(([n]) => n);
  return <details className="my-1.5"><summary>{`Also search ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}</summary>
    <Meta className="my-1.5">These sites do not allow apps to collect their jobs automatically, so we do not. Each button opens that site’s results in a new tab for the title below in {place}. When you find a job, copy its link or text and press “Add a job I found”: it is then scored against your CV like any other.</Meta>
    <Row className="my-1.5 items-end">
      <div className="min-w-[160px]"><SelectField label="Country" value={market} onChange={(v) => setPicked(v as 'SA' | 'PK')} options={meta.markets.map((m): [string, string] => [m.code, m.country])} /></div>
      {titles.length > 0 && <div className="min-w-[220px] flex-1"><SelectField label="Job title to search for" value={chosen} onChange={setTitle} options={titles} /></div>}
      {OTHER_SITES[market].map(([name, domain]) => <LinkBtn key={domain} href={siteSearchUrl(domain, chosen, place)} target="_blank" rel="noopener noreferrer">{`${name} ↗`}</LinkBtn>)}
      <Btn onClick={onImport}>Add a job I found</Btn>
    </Row>
    <Meta>Opening a button sends the job title and place to Google (to search that site). Nothing from your CV is sent.</Meta>
  </details>;
}

function JobCard({ job, selected, onSelect }: { job: Job; selected: boolean; onSelect: () => void }) {
  const app = useApp();
  const statusLabel = (k: string) => app.meta.statuses.find(([v]) => v === k)?.[1] ?? k;
  const isNew = job.posted_at && Date.now() - new Date(job.posted_at).getTime() <= 864e5;
  return <Card tabIndex={0} role="button" onClick={onSelect} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onSelect(); }}
    className={cx('jobcard mb-2 flex cursor-pointer flex-col', selected && 'border-accent ring-1 ring-accent')}>
    <Row spread><h3 dir="auto" className="min-w-0">{job.title}</h3><Meter score={job.match_score} method={job.match_method} /></Row>
    <Meta><span dir="auto">{[job.company, job.city || job.location_text].filter(Boolean).join(' · ')}</span></Meta>
    <Row className="my-1.5">
      <Pill>{LABEL[job.work_mode]}</Pill><Pill>{LABEL[job.employment_type]}</Pill>
      {job.experience_level !== 'unknown' && <Pill>{LABEL[job.experience_level]}</Pill>}
      <Pill tone={toneOf(job.sponsorship)}>{SPONSOR[job.sponsorship]}</Pill>
      {job.app_status && <Pill tone="yes">{statusLabel(job.app_status)}</Pill>}
      {job.posted_at && <span className="text-[13px] text-mute">{fmtDate(job.posted_at)}</span>}
      {isNew && <Pill tone="yes">New</Pill>}
    </Row>
    <JobActions job={job} />
  </Card>;
}

function ListBlock({ title, items }: { title: string; items?: string[] }) {
  return items?.length ? <div className="my-1.5"><b>{title}</b><ul dir="auto" className="my-1 list-disc pl-5">{items.map((i, n) => <li key={n}>{i}</li>)}</ul></div> : null;
}

function JobDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const app = useApp();
  const q = useLoad(() => api<JobDetailData>(`/api/jobs/${id}`), [id]);
  const reload = () => { q.reload(); onChanged(); };
  return <Loaded q={q}>{(d) => {
    const { job, analysis, heuristic } = d;
    const score = analysis?.score ?? heuristic.score;
    return <div className="grid gap-1.5">
      <Card>
        <Row spread><h2 dir="auto" className="mb-0 min-w-0">{job.title}</h2><Meter score={score} method={analysis ? 'ai' : 'heuristic'} /></Row>
        <Meta><span dir="auto">{[job.company, job.location_text, `via ${job.source}`].filter(Boolean).join(' · ')}</span></Meta>
        <Row className="my-1.5">
          <Pill tone={toneOf(job.sponsorship)}>{SPONSOR[job.sponsorship]}</Pill><Pill tone={toneOf(job.relocation)}>{RELOC[job.relocation]}</Pill>
          {job.work_mode === 'remote' && <Pill>{`Remote eligibility: ${job.remote_eligibility || 'unknown'}`}</Pill>}
          {job.salary_min ? <Pill>{`${Math.round(job.salary_min)}${job.salary_max && job.salary_max !== job.salary_min ? '–' + Math.round(job.salary_max) : ''} ${job.salary_currency || ''}`}</Pill> : null}
        </Row>
        {job.sponsorship === 'not_specified' && <Meta>The posting does not say whether visa sponsorship is offered. Ask the employer; do not assume.</Meta>}
        {job.url && <p className="my-2"><LinkBtn variant="primary" href={job.url} target="_blank" rel="noopener noreferrer">Open the original job page ↗</LinkBtn></p>}
        <div dir="auto" className="max-h-[340px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-2.5">{job.description || '(no description)'}</div>
      </Card>
      {!analysis && heuristic.score != null && <Card><h3>Quick check: skills you have vs. skills the job mentions</h3>
        <Meta>{'Skills you have: ' + ((heuristic.matchedSkills as string[]).join(', ') || 'none')}</Meta>
        <Meta>{'Skills the job mentions that are not in your profile: ' + ((heuristic.missingSkills as string[]).join(', ') || 'none')}</Meta></Card>}
      <Card>
        <Row spread><h3>How well do I fit this job?</h3>
          <Btn busyLabel="Checking…" onAction={async () => { await api(`/api/jobs/${id}/analyze`, { method: 'POST' }); reload(); }}>{analysis ? 'Check again' : 'Check my fit'}</Btn></Row>
        {analysis ? <>
          <p dir="auto" className="my-2">{`${analysis.verdict?.replace('_', ' ') || ''} — ${analysis.summary || ''}`}</p>
          {analysis.requirements?.length ? <table><tbody>{(analysis.requirements as Rec[]).map((r, i) => <tr key={i}><td dir="auto">{r.requirement}</td><td><Pill tone={r.status === 'met' ? 'yes' : r.status === 'gap' ? 'no' : 'default'}>{r.status}</Pill></td><td dir="auto" className="text-[13px] text-mute">{r.evidence || ''}</td></tr>)}</tbody></table> : null}
          <ListBlock title="Where you are strong" items={analysis.strengths} /><ListBlock title="What the job wants that your profile does not show" items={analysis.gaps} />
          <ListBlock title="Things to watch out for" items={analysis.red_flags} /><ListBlock title="Keywords from the job that you really have" items={analysis.keywords} /><ListBlock title="Suggestions" items={analysis.advice} />
          <Meta>{`Sponsorship per posting: ${analysis.sponsorship_note || 'Not specified'} · Recommendation: ${analysis.recommendation || '-'}`}</Meta>
        </> : <Meta className="mt-1.5">{app.status.ai ? 'Not checked yet. Press “Check my fit”.' : 'AI is not set up, so this check is not available.'}</Meta>}
      </Card>
      <CvPanel job={job} d={d} reload={reload} />
      <LetterPanel job={job} d={d} reload={reload} />
      <ApplyPanel job={job} d={d} reload={reload} />
    </div>;
  }}</Loaded>;
}

function ImportJob({ done }: { done: () => void }) {
  const app = useApp();
  const [f, setF] = useState({ url: '', title: '', company: '', location: '', text: '' });
  const bind = (k: keyof typeof f) => ({ value: f[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value }) });
  return <Card>
    <h2>Add a job</h2>
    <Meta className="mb-2">Paste a posting you found on LinkedIn, Bayt, a company site, etc. Pages are only fetched when you supply the URL.</Meta>
    <Grid two>
      <TextField label="URL" placeholder="https://… job page URL (optional if you paste text)" {...bind('url')} />
      <TextField label="Title" placeholder="Job title (optional if AI is enabled)" {...bind('title')} />
      <TextField label="Company" placeholder="Company (optional)" {...bind('company')} />
      <TextField label="Location" placeholder="Location, e.g. Riyadh, Saudi Arabia" {...bind('location')} />
    </Grid>
    <AreaField className="mt-2" label="Description" placeholder="Or paste the full job description here…" {...bind('text')} />
    <Row className="mt-2">
      <Btn variant="primary" busyLabel="Importing…" onAction={async () => {
        const t = (s: string) => s.trim() || undefined;
        const r = await api('/api/jobs/import', { method: 'POST', body: { url: t(f.url), title: t(f.title), company: t(f.company), location: t(f.location), text: t(f.text) } });
        app.setSelected(r.id); toast('Job added'); done();
      }}>Import</Btn>
      <Btn onClick={done}>Cancel</Btn>
    </Row>
  </Card>;
}
