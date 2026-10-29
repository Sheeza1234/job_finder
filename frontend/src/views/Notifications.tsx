import { api, fmtWhen } from '../lib/api';
import { useApp, useLoad } from '../lib/app';
import type { Rec } from '../lib/types';
import { Btn, Card, Empty, Meta, Row, cx } from '../components/ui';
import { Loaded } from '../components/Load';

export function Notifications() {
  const app = useApp();
  const q = useLoad(() => api<{ items: Rec[]; unread: number }>('/api/notifications?limit=100'));
  const done = () => { app.refreshBell(); q.reload(); };
  return <Loaded q={q}>{({ items, unread }) => <Card>
    <Row spread><h2 className="mb-0">{`Notifications${unread ? ` (${unread} unread)` : ''}`}</h2><Btn onAction={async () => { await api('/api/notifications/read-all', { method: 'POST' }); done(); }}>Mark all read</Btn></Row>
    {items.length ? items.map((n) => <div key={n.id} className={cx('border-b border-line px-1 py-2.5', !n.read_at && 'border-l-[3px] border-l-accent bg-goodbg pl-2.5')}>
      <Row spread><b dir="auto">{n.title}</b><Meta>{fmtWhen(n.created_at)}</Meta></Row>
      <div dir="auto" className="my-1 whitespace-pre-wrap text-mute">{n.body}</div>
      {n.email_error && <Meta>{`Email not sent: ${n.email_error}`}</Meta>}
      <Row>
        {n.job_id && <Btn onAction={async () => { await api(`/api/notifications/${n.id}/read`, { method: 'POST' }); app.refreshBell(); app.openJob(n.job_id); }}>View job</Btn>}
        {!n.read_at && <Btn onAction={async () => { await api(`/api/notifications/${n.id}/read`, { method: 'POST' }); done(); }}>Mark read</Btn>}
        <Btn variant="danger" onAction={async () => { await api(`/api/notifications/${n.id}`, { method: 'DELETE' }); done(); }}>Delete</Btn>
      </Row></div>) : <Empty>No notifications yet.</Empty>}
  </Card>}</Loaded>;
}
