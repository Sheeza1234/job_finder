import { useRef } from 'react';
import { api } from '../lib/api';
import { askConfirm, toast } from '../lib/bus';
import { useApp } from '../lib/app';
import type { Profile, Rec } from '../lib/types';
import { Btn, Row } from './ui';

type App = ReturnType<typeof useApp>;

/** After a CV is uploaded: read it and fill the profile (only empty fields), then say what was filled and what is missing.
 *  If AI consent is declined, contact details are still read locally. */
export async function autoFillFromCv(app: App, documentId: number): Promise<boolean> {
  let r: Rec;
  try { r = await api('/api/profile/auto-fill', { method: 'POST', body: { documentId } }); } catch (e) {
    if (!/^Cancelled/.test((e as Error).message)) { toast((e as Error).message, true); return false; }
    try { r = await api('/api/profile/auto-fill', { method: 'POST', body: { documentId, useAi: false } }); } catch (x) { toast((x as Error).message, true); return false; }
  }
  app.setProfile(r.profile as Profile);
  // The AI could not read the CV (even after an automatic retry): say so plainly instead of pretending it worked.
  if (r.ai?.failed && await askConfirm({ title: 'Could not read your experience and skills', body: `${r.ai.note}\n\nOnly your name and contact details were filled in.`, confirmLabel: 'Try again', cancelLabel: 'Fill in by hand' })) return autoFillFromCv(app, documentId);
  const missing: string[] = r.missing.map((m: Rec) => m.label);
  const items = [...(r.filled as string[]).map((f) => `✓ ${f}`), ...(missing.length ? [`Still missing: ${missing.join(', ')}`] : [])];
  const review = await askConfirm({
    title: r.filled.length ? 'Your profile was filled from your CV' : 'Nothing new to fill from this CV',
    body: `${r.ai?.note ? r.ai.note + ' ' : ''}Automatic reading can make mistakes, so please check the details. ${missing.length ? 'You only need to add what is missing; everything can be edited by hand.' : 'Everything essential is filled in.'}`,
    items, confirmLabel: missing.length ? 'Review & add missing' : 'Review my profile', cancelLabel: 'Close' });
  if (review) app.go('profile');
  return true;
}

/** File picker + button: uploads a CV and fetches its details into the profile in one step. */
export function CvUpload({ label = 'Upload CV & fetch my details' }: { label?: string }) {
  const app = useApp();
  const input = useRef<HTMLInputElement>(null);
  return <Row>
    <input ref={input} type="file" accept=".pdf,.docx,.txt,.md" aria-label="Choose your CV (PDF or DOCX)" className="max-sm:flex-auto" />
    <Btn variant="primary" busyLabel="Uploading…" className="max-sm:w-full" onAction={async () => {
      const file = input.current?.files?.[0];
      if (!file) throw new Error('Choose your CV file first');
      const fd = new FormData(); fd.append('kind', 'cv'); fd.append('file', file);
      const r = await api<Rec>('/api/documents', { method: 'POST', body: fd });
      if (!r.text_chars) { toast('Uploaded, but no text could be read (scanned file?). Please fill in your profile manually.', true); return app.go(app.view); }
      await autoFillFromCv(app, r.id);
      app.reload();
    }}>{label}</Btn>
  </Row>;
}
