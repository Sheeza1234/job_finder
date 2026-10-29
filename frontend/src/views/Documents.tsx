import { useRef, useState } from 'react';
import { api, fmtDate } from '../lib/api';
import { askConfirm, toast } from '../lib/bus';
import { useApp, useLoad } from '../lib/app';
import type { DocRow } from '../lib/types';
import { ActionLink, Btn, Card, Empty, Grid, Meta, Pill, Row, SelectField, Field } from '../components/ui';
import { Loaded } from '../components/Load';
import { autoFillFromCv } from '../components/CvUpload';

export function Documents() {
  const app = useApp();
  const q = useLoad(() => api<DocRow[]>('/api/documents'));
  const [kind, setKind] = useState('cv');
  const file = useRef<HTMLInputElement>(null);
  return <Loaded q={q}>{(docs) => <Card>
    <h2>Documents</h2>
    <Meta className="mb-2">Upload your CV (PDF/DOCX), portfolio PDF, certificates and project write-ups. Text is extracted so it can be used to pre-fill your profile. Portfolio and LinkedIn URLs go in Profile.</Meta>
    <Grid two>
      <SelectField label="Type" value={kind} onChange={setKind} options={[['cv', 'CV / Resume'], ['portfolio', 'Portfolio (PDF)'], ['certificate', 'Certificate'], ['project', 'Project description'], ['other', 'Other']]} />
      <Field label="File">{(id) => <input id={id} ref={file} type="file" accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg" />}</Field>
    </Grid>
    <Row className="my-2"><Btn variant="primary" busyLabel="Uploading…" onAction={async () => {
      const f = file.current?.files?.[0]; if (!f) throw new Error('Choose a file first');
      const fd = new FormData(); fd.append('kind', kind); fd.append('file', f);
      const r = await api('/api/documents', { method: 'POST', body: fd });
      toast(r.text_chars ? `Uploaded (${r.text_chars} characters extracted)` : 'Uploaded (no text could be extracted; scanned/image files are stored only)');
      if (kind === 'cv' && r.text_chars) await autoFillFromCv(app, r.id);
      app.reload();
    }}>Upload</Btn></Row>
    {docs.length ? <div className="overflow-x-auto"><table className="min-w-[640px]"><thead><tr>{['File', 'Type', 'Text', 'Uploaded', ''].map((x) => <th key={x}>{x}</th>)}</tr></thead>
      <tbody>{docs.map((d) => <tr key={d.id}>
        <td><ActionLink onClick={async () => { try { const { url } = await api<{ url: string }>(`/api/documents/${d.id}/link`, { method: 'POST' }); window.location.href = url; } catch (x) { toast((x as Error).message, true); } }}>{d.filename}</ActionLink>{d.is_master && <Pill tone="yes" className="ml-1.5">Master</Pill>}</td>
        <td>{d.kind}</td><td>{d.text_chars ? `${d.text_chars} chars` : '–'}</td><td className="text-[13px] text-mute">{fmtDate(d.created_at)}</td>
        <td><Btn variant="danger" onClick={async () => { if (await askConfirm({ title: `Delete ${d.filename}?`, body: 'The file and its extracted text are removed.', confirmLabel: 'Delete file', danger: true })) { await api(`/api/documents/${d.id}`, { method: 'DELETE' }); q.reload(); } }}>Delete</Btn></td></tr>)}</tbody></table></div>
      : <Empty>No documents yet.</Empty>}
  </Card>}</Loaded>;
}
