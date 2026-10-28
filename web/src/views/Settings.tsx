import { useState } from 'react';
import { api, downloadFile, fmtWhen } from '../lib/api';
import { askText, toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import type { Profile, Rec } from '../lib/types';
import { Btn, Card, Check, Good, Grid, Meta, Row, SelectField, TextField, Warn, cx } from '../components/ui';
import { Loaded } from '../components/Load';
import { switchMode } from '../App';

const STATE_CHIP: Record<string, [string, string, string]> = { ok: ['✓', 'Working', 'ok'], configured: ['●', 'Configured', 'cfg'], failing: ['✕', 'Failing', 'bad'], not_configured: ['○', 'Not configured', 'off'], unavailable: ['–', 'Unavailable', 'off'] };
const CHIP_CLS: Record<string, string> = { ok: 'bg-goodbg text-good border-transparent', cfg: 'text-accent border-line', bad: 'text-bad border-bad', off: 'text-mute border-line' };
const Chip2 = ({ cls, children }: { cls: string; children: React.ReactNode }) => <span className={cx('inline-block rounded-full border px-2.5 py-px text-xs font-semibold', CHIP_CLS[cls])}>{children}</span>;

export function Settings() {
  const q = useLoad(async () => {
    const [em, pv, audit, integ, ready, srcs] = await Promise.all([api('/api/settings/email'), api('/api/privacy'), api<Rec[]>('/api/audit?limit=40'), api<Rec[]>('/api/integrations'), api('/api/readiness'), api<Rec[]>('/api/settings/job-sources')]);
    return { em, pv, audit, integ, ready, srcs };
  });
  return <Loaded q={q}>{(d) => <SettingsBody d={d} reload={q.reload} />}</Loaded>;
}

function SourceCard({ src, primary, reload }: { src: Rec; primary: boolean; reload: () => void }) {
  const app = useApp();
  const [key, setKey] = useState('');
  return <div className={primary ? '' : 'my-1.5'}>
    <Row spread><h3>{src.label}</h3><Chip2 cls={src.hasKey ? 'ok' : 'off'}>{src.hasKey ? `✓ Connected${src.from === 'env' ? ' (from .env)' : ''}` : '○ Not connected'}</Chip2></Row>
    <Meta className="my-1.5">{src.help}{' '}<a href={src.signup} target="_blank" rel="noopener noreferrer">Get a key ↗</a></Meta>
    <Row>
      <div className="min-w-[200px] flex-1"><input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={src.hasKey ? '•••••••• saved (type a new key to replace)' : 'Paste your key here'} aria-label={`${src.label} API key`} /></div>
      <Btn variant="primary" busyLabel="Saving…" onAction={async () => { if (!key.trim()) throw new Error('Paste the key first'); await api(`/api/settings/job-sources/${src.id}`, { method: 'PUT', body: { key: key.trim() } }); await app.refreshStatus(); toast(`${src.label} saved`); reload(); }}>Save key</Btn>
      {src.hasKey && <Btn busyLabel="Testing…" onAction={async () => { try { const r = await api(`/api/integrations/${src.id}/test`, { method: 'POST' }); toast(r.detail); } catch (x) { toast(`${src.label}: ${(x as Error).message}`, true); } }}>Test</Btn>}
      {src.hasKey && src.from === 'app' && <Btn variant="danger" onAction={async () => { await api(`/api/settings/job-sources/${src.id}`, { method: 'PUT', body: { key: '' } }); await app.refreshStatus(); reload(); }}>Remove</Btn>}
    </Row>
  </div>;
}

function SettingsBody({ d, reload }: { d: { em: Rec; pv: Rec; audit: Rec[]; integ: Rec[]; ready: Rec; srcs: Rec[] }; reload: () => void }) {
  const app = useApp();
  const { em, pv, audit, integ, ready, srcs } = d;
  const [f, setF] = useState({ provider: em.provider as string, from: em.from as string, to: em.to as string, resendApiKey: '', host: (em.smtp?.host || '') as string, port: (em.smtp?.port || 587) as number, secure: !!em.smtp?.secure, user: (em.smtp?.user || '') as string, password: '' });
  const [consent, setConsent] = useState<boolean>(pv.consent.ai);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((c) => ({ ...c, [k]: v }));
  const emailBody = () => {
    const base = { provider: f.provider, from: f.from, to: f.to };
    if (f.provider === 'resend') return { ...base, ...(f.resendApiKey ? { resendApiKey: f.resendApiKey } : {}) };
    if (f.provider === 'smtp') return { ...base, smtp: { host: f.host, port: f.port, secure: f.secure, user: f.user, ...(f.password ? { password: f.password } : {}) } };
    return base;
  };
  const jooble = srcs.find((x) => x.id === 'jooble')!; const joobleP = srcs.find((x) => x.id === 'jooble_pk')!; const jsearch = srcs.find((x) => x.id === 'jsearch')!;
  const joobleHasPk = joobleP.hasKey;
  const saudiOn = jooble.hasKey || joobleHasPk || jsearch.hasKey;
  const demo = app.status.mode === 'demo';

  return <div className="grid gap-3">
    <Card><h2>Find jobs in Saudi Arabia and Pakistan</h2>
      {saudiOn ? <Good>{[jooble.hasKey && 'Saudi Arabia', joobleHasPk && 'Pakistan'].filter(Boolean).join(' and ')} {jooble.hasKey && joobleHasPk ? 'are' : 'is'} connected. “Find new jobs online” searches every connected country at the same time and shows the results together.</Good>
        : <Warn><b>Job sources for Saudi Arabia and Pakistan are not connected yet. </b>Right now only Remotive is on, which lists remote jobs from around the world. Add a free Jooble key for each country below.</Warn>}
      <Meta className="my-1.5">Jooble gives a separate key for each country, so add one for Saudi Arabia and one for Pakistan. You can add either or both; each key only works for its own country.</Meta>
      <SourceCard src={jooble} primary reload={reload} />
      <div className="mt-3"><SourceCard src={joobleP} primary={false} reload={reload} /></div>
      <details className="my-1.5"><summary>Another source (optional)</summary><SourceCard src={jsearch} primary={false} reload={reload} /></details>
      <Meta>Keys are stored encrypted and are never shown again. Searching sends only search words and city names, never your CV.</Meta>
    </Card>

    <Card><h2>Email me</h2>
      {!em.secretsEnabled && <Warn>Set APP_SECRET (16+ characters) in the server environment before saving email credentials. They are stored encrypted with it.</Warn>}
      <Grid two>
        <SelectField label="Provider" value={f.provider} onChange={(v) => set('provider', v)} options={[['none', 'None'], ['resend', 'Resend'], ['smtp', 'SMTP server']]} />
        <TextField label="From address" placeholder="Jobs <jobs@yourdomain.com>" value={f.from} onChange={(e) => set('from', e.target.value)} />
        <TextField label="Send to (default: your profile email)" type="email" value={f.to} onChange={(e) => set('to', e.target.value)} />
      </Grid>
      {f.provider === 'resend' && <div className="mt-2"><TextField label={em.hasResendKey ? 'Resend API key (leave empty to keep the stored key)' : 'Resend API key'} type="password" placeholder={em.hasResendKey ? '•••••••• stored' : 're_…'} value={f.resendApiKey} onChange={(e) => set('resendApiKey', e.target.value)} /></div>}
      {f.provider === 'smtp' && <Grid two className="mt-2">
        <TextField label="SMTP host" value={f.host} onChange={(e) => set('host', e.target.value)} />
        <TextField label="Port" type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} />
        <TextField label="Username" value={f.user} onChange={(e) => set('user', e.target.value)} />
        <TextField label={em.smtp?.hasPassword ? 'Password (leave empty to keep)' : 'Password'} type="password" placeholder={em.smtp?.hasPassword ? '•••••••• stored' : ''} value={f.password} onChange={(e) => set('password', e.target.value)} />
        <Check checked={f.secure} onChange={(v) => set('secure', v)}>Use TLS (port 465)</Check></Grid>}
      <Row className="my-2">
        <Btn variant="primary" busyLabel="Saving…" onAction={async () => { await api('/api/settings/email', { method: 'PUT', body: emailBody() }); toast('Email settings saved'); reload(); }}>Save</Btn>
        <Btn busyLabel="Sending…" onAction={async () => { await api('/api/settings/email/test', { method: 'POST' }); toast('Test email sent'); }}>Send test email</Btn></Row>
      <Meta>Keys and passwords are write-only: they are never shown again. Emails contain job titles and links, never CV content.</Meta>
    </Card>

    <Card><h2>Privacy and my data</h2>
      <Check checked={consent} onChange={async (v) => { try { await api('/api/privacy/consent', { method: 'POST', body: { ai: v } }); setConsent(v); await app.refreshPrivacy(); toast(v ? 'AI use allowed' : 'AI use disabled'); } catch (e) { toast((e as Error).message, true); } }}>
        {`Allow sending my profile and job text to ${app.status.ai_target?.name || 'the AI provider'} when I use AI features`}</Check>
      <ul className="my-2 list-disc pl-5 text-[13px] text-mute">{['ai', 'jobSources', 'employers', 'email'].map((k) => <li key={k}>{pv.disclosure[k]}</li>)}</ul>
      <Row>
        <Btn busyLabel="Preparing…" onAction={() => downloadFile('/api/privacy/export')}>Download all my data</Btn>
        <Btn variant="danger" onAction={async () => {
          const t = await askText({ title: 'Delete all my data?', body: 'This permanently deletes your profile, CVs, uploaded files, jobs, applications, notifications, settings and saved credentials. It cannot be undone. Consider downloading your data first.', label: 'Type DELETE MY DATA to confirm', match: 'DELETE MY DATA', confirmLabel: 'Delete everything', danger: true });
          if (t !== 'DELETE MY DATA') return toast('Cancelled. Nothing was deleted.');
          try { const r = await api('/api/privacy/data', { method: 'DELETE', body: { confirm: t } }); toast(`Deleted ${r.deleted_files} file(s) and all stored data.`); app.setProfile(await api<Profile>('/api/profile')); app.go('dashboard'); } catch (e) { toast((e as Error).message, true); }
        }}>Delete all my data</Btn></Row>
    </Card>

    <details className="optional rounded-xl border border-line bg-card px-4 py-3"><summary>Advanced: demo mode, connection status, technical checks, activity log</summary>
      <div className="mt-2 grid gap-3">
        <Card><h2>Data mode</h2>
          <p>{demo ? <span><strong>Demo mode is ON.</strong> You see clearly labelled sample jobs only. Real searching, notifications and applying are paused.</span> : <span><strong>Production mode.</strong> Everything shown comes from your own data and the sources you configured.</span>}</p>
          <Meta className="my-1.5">Demo mode loads clearly labelled sample listings so you can try the interface. They are never mixed with real data and are deleted when you switch back.</Meta>
          <Btn onClick={() => switchMode(demo ? 'production' : 'demo', app)}>{demo ? 'Switch to production' : 'Try demo mode'}</Btn></Card>

        <Card><h2>Integration status</h2>
          <Meta className="mb-1.5">Based on real outcomes, not just configuration. “Test” sends no personal data.</Meta>
          {[...new Set(integ.map((i) => i.group as string))].map((g) => <div key={g} className="my-1.5"><h3>{g}</h3>
            <div className="overflow-x-auto"><table className="min-w-[560px]"><tbody>{integ.filter((i) => i.group === g).map((i) => { const [icon, text, cls] = STATE_CHIP[i.state] || STATE_CHIP.unavailable;
              return <tr key={i.id}><td><b>{i.label}</b></td><td><Chip2 cls={cls}>{`${icon} ${text}`}</Chip2></td><td className="text-[13px] text-mute">{i.detail}</td>
                <td>{i.testable && i.state !== 'not_configured' ? <Btn busyLabel="Testing…" onAction={async () => { try { const r = await api(`/api/integrations/${i.id}/test`, { method: 'POST' }); toast(r.detail); } catch (x) { toast(`${i.label}: ${(x as Error).message}`, true); } reload(); }}>Test</Btn> : null}</td></tr>; })}</tbody></table></div></div>)}
          <Meta>Official APIs only. LinkedIn, Bayt, Indeed, GulfTalent and similar sites forbid scraping, so use “Add job (URL / paste)” for postings found there.</Meta></Card>

        <Card><h2>Production readiness</h2>
          <ul className="my-2 list-none p-0">{(ready.items as Rec[]).map((i, n) => <li key={n} className={cx('py-0.5', i.level === 'ok' ? 'text-good' : i.level === 'warn' ? 'text-warn' : 'text-bad')}>{`${i.level === 'ok' ? '✓' : i.level === 'warn' ? '⚠' : '✕'} ${i.label}`}<Meta>{i.detail}</Meta></li>)}</ul>
          {ready.ready ? <Good>No blocking problems found.</Good> : <Warn>Fix the ✕ items before exposing this app to a network.</Warn>}</Card>

        <Card><h2>Activity log</h2>
          <Meta className="mb-1.5">Recent actions (what happened and when; never CV text or credentials).</Meta>
          <div className="overflow-x-auto"><table className="min-w-[560px]"><tbody>{audit.map((a, i) => <tr key={i}><td className="text-[13px] text-mute">{fmtWhen(a.at)}</td><td>{a.actor}</td><td>{a.action}</td><td className="text-[13px] text-mute">{a.entity ? `${a.entity} #${a.entity_id}` : ''}</td></tr>)}</tbody></table></div></Card>
      </div></details>
  </div>;
}
