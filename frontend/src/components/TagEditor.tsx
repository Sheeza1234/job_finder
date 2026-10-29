import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/app';
import type { Profile, Rec } from '../lib/types';
import { Btn, Card, Chip, Meta, Pill, Row } from './ui';

/** "Jobs I'm looking for": editable tags, suggested from keywords in the CV; the user can remove or add any. */
export function TagEditor({ profile, onChange }: { profile: Profile; onChange: (titles: string[]) => void }) {
  const app = useApp();
  const titles = profile.preferredTitles;
  const [text, setText] = useState('');
  const [sugg, setSugg] = useState<Rec | null>(null);
  const has = (t: string) => titles.some((x) => x.toLowerCase() === t.toLowerCase());
  const add = (t: string) => { const v = t.trim(); if (!v || has(v)) return false; onChange([...titles, v]); return true; };
  const submit = () => { if (add(text)) setText(''); };

  return <Card className="my-1.5">
    <h3>Jobs I’m looking for</h3>
    <Meta className="my-1.5">These titles are used to find and rank jobs. We suggest them from the keywords in your CV; remove any you do not want and add your own. A title here does not claim you qualify: every job is still compared with your real profile.</Meta>
    <div role="list" aria-label="Job titles I am looking for" className="my-2 flex flex-wrap gap-2">
      {titles.length ? titles.map((t) => <span key={t} role="listitem" className="tag inline-flex items-center gap-1.5 rounded-full border border-transparent bg-goodbg py-1 pl-3.5 pr-1.5 font-semibold text-accent">
        <span dir="auto">{t}</span>
        <button type="button" aria-label={`Remove ${t}`} title="Remove" className="rounded-full border-0 bg-transparent px-2 text-lg leading-none hover:bg-black/10" onClick={() => onChange(titles.filter((x) => x !== t))}>×</button></span>)
        : <Meta>No job titles yet. Upload your CV and we will suggest some, or add your own below.</Meta>}
    </div>
    <Row className="my-1.5">
      <input className="flex-1 basis-48" placeholder="Type a job title, e.g. Graphic Designer" aria-label="Add a job title" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
      <Btn onClick={submit}>Add</Btn>
    </Row>
    {profile.cvKeywords?.length ? <div className="my-1.5"><Meta>Keywords we found in your CV:</Meta><Row>{profile.cvKeywords.map((k) => <Pill key={k}>{k}</Pill>)}</Row></div> : null}
    <Row className="my-1.5"><Btn busyLabel="Reading your CV…" onAction={async () => {
      let r: Rec;
      try { r = await api('/api/profile/suggest-titles', { method: 'POST', body: {} }); } catch (x) {
        if (x instanceof ApiError && /^Cancelled/.test(x.message)) r = await api('/api/profile/suggest-titles', { method: 'POST', body: { useAi: false } }); else throw x;
      }
      setSugg(r);
    }}>Suggest job titles from my CV</Btn></Row>
    {sugg && <div className="my-1.5">
      {sugg.suggestions.length ? <div><Meta>Suggested from your CV (click to add):</Meta>
        <Row className="my-1.5">{(sugg.suggestions as Rec[]).map((s) => <Chip key={s.title} data-title={s.title} title={s.reason} disabled={has(s.title)} className="sugg disabled:opacity-45" onClick={() => add(s.title)}>{`+ ${s.title}`}</Chip>)}</Row>
        <ul className="my-1 list-disc pl-5 text-[13px] text-mute">{(sugg.suggestions as Rec[]).map((s) => <li key={s.title}><b>{s.title}</b>{` — ${s.reason}`}</li>)}</ul></div>
        : <Meta>No suggestions yet: your CV did not mention enough skills. Add titles by hand.</Meta>}
      {sugg.ai?.note && <Meta>{sugg.ai.note}</Meta>}
    </div>}
    <details className="my-1.5"><summary>Pick from common titles</summary>
      <Row className="my-1.5">{app.meta.categories.map((c) => <Chip key={c} onClick={() => add(c)}>{`+ ${c}`}</Chip>)}</Row></details>
  </Card>;
}
