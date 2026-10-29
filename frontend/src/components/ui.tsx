import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { dialogStore, toast, toastStore, type DialogReq } from '../lib/bus';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- buttons ----------
type Variant = 'default' | 'primary' | 'danger' | 'ghost';
const BTN: Record<Variant, string> = {
  default: 'border-line bg-card text-ink hover:border-accent',
  primary: 'border-accent bg-accent text-accent-ink hover:brightness-110',
  danger: 'border-line bg-card text-bad hover:border-bad',
  ghost: 'border-transparent bg-transparent text-ink hover:bg-goodbg',
};
export const btnClass = (v: Variant = 'default', extra?: string) =>
  cx('inline-flex min-h-9 items-center justify-center rounded-lg border px-3 py-1.5 text-center transition disabled:cursor-wait disabled:opacity-50 max-sm:min-h-10', v === 'danger' && 'danger', BTN[v], extra);

interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  variant?: Variant;
  /** Async action: the button disables itself, shows `busyLabel`, and failures become a toast. */
  onAction?: () => Promise<unknown>;
  busyLabel?: string;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
}
export function Btn({ variant = 'default', onAction, busyLabel = '…', onClick, className, children, disabled, ...rest }: BtnProps) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const click: BtnProps['onClick'] = async (e) => {
    if (onClick) onClick(e);
    if (!onAction) return;
    setBusy(true);
    try { await onAction(); } catch (err) { toast((err as Error).message, true); } finally { if (mounted.current) setBusy(false); }
  };
  return <button type="button" {...rest} disabled={disabled || busy} onClick={click} className={btnClass(variant, className)}>{busy ? busyLabel : children}</button>;
}

export function LinkBtn({ variant = 'default', className, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return <a {...rest} className={btnClass(variant, cx('no-underline', variant === 'primary' ? 'text-accent-ink' : 'text-ink', className))} />;
}
/** Text link that runs an action instead of navigating. */
export function ActionLink({ onClick, children, className }: { onClick: () => void; children: ReactNode; className?: string }) {
  return <a href="#" className={className} onClick={(e) => { e.preventDefault(); onClick(); }}>{children}</a>;
}

// ---------- layout ----------
export const Card = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div {...p} className={cx('card min-w-0 rounded-xl border border-line bg-card p-3.5 shadow-sm max-[420px]:p-3', className)} />;
export const Row = ({ className, spread, ...p }: React.HTMLAttributes<HTMLDivElement> & { spread?: boolean }) => <div {...p} className={cx('flex flex-wrap items-center gap-2', spread && 'justify-between max-sm:justify-start', className)} />;
export const Meta = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div {...p} className={cx('text-[13px] text-mute', className)} />;
export const Grid = ({ className, two, ...p }: React.HTMLAttributes<HTMLDivElement> & { two?: boolean }) =>
  <div {...p} className={cx('grid gap-3', two ? 'grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(min(180px,100%),1fr))]', className)} />;
export const Sub = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div {...p} className={cx('my-2.5 border-l-[3px] border-line pl-2.5', className)} />;

const PILL = { default: 'border-line text-mute', yes: 'border-transparent bg-goodbg text-good', no: 'border-line text-bad' };
export const Pill = ({ tone = 'default', className, ...p }: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof PILL }) =>
  <span {...p} className={cx('pill inline-block rounded-full border px-2 py-px text-xs', PILL[tone], className)} />;
/** Maps the server's tri-state ('yes' / 'no' / other) to a pill tone. */
export const toneOf = (v?: string): keyof typeof PILL => (v === 'yes' ? 'yes' : v === 'no' ? 'no' : 'default');

export const Warn = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div {...p} className={cx('warn my-2 rounded-lg bg-warnbg px-3 py-2 text-warn', className)} />;
export const Good = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div {...p} className={cx('good my-2 rounded-lg bg-goodbg px-3 py-2 text-good', className)} />;
export const Empty = ({ children }: { children: ReactNode }) => <div className="p-6 text-center text-mute">{children}</div>;
export const List = ({ items, className, dir }: { items: ReactNode[]; className?: string; dir?: 'auto' }) => <ul dir={dir} className={cx('my-1 list-disc pl-5', className)}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
/** Wide tables scroll inside their own box instead of widening the page. */
export const TableWrap = ({ children }: { children: ReactNode }) => <div className="overflow-x-auto"><div className="min-w-[720px] max-[420px]:min-w-[640px]">{children}</div></div>;

export function EmptyState({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return <Card className="col-span-full px-4 py-7 text-center"><h3 className="mb-1 text-[17px]">{title}</h3>{body && <Meta>{body}</Meta>}{children && <Row className="mt-3 justify-center">{children}</Row>}</Card>;
}
export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return <Card role="alert" className="border-l-4 border-l-bad"><h2>Something went wrong</h2><p>{error.message || 'The request failed.'}</p><Meta className="mb-2">Your data is unchanged. Check that the server is running, then try again.</Meta>{retry && <Btn variant="primary" onClick={retry}>Try again</Btn>}</Card>;
}
export function Skeleton() {
  return <div role="status" aria-label="Loading" className="grid gap-3.5">
    <div className="sk h-[26px] w-[200px] rounded-[10px]" />
    <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">{[1, 2, 3].map((i) => <div key={i} className="sk h-[84px] rounded-[10px]" />)}</div>
    <div className="sk h-[120px] rounded-[10px]" /><div className="sk h-[120px] rounded-[10px]" />
  </div>;
}

// ---------- form controls ----------
export function Field({ label, children, className, missing }: { label: ReactNode; children: (id: string) => ReactNode; className?: string; missing?: boolean }) {
  const id = useId();
  return <div className={cx('min-w-0', missing && 'needs [&>input]:border-warn [&>input]:bg-warnbg [&>textarea]:border-warn [&>textarea]:bg-warnbg', className)}>
    <label htmlFor={id}>{label}{missing && <Pill tone="no" className="ml-2 text-[11px]">Missing</Pill>}</label>{children(id)}
  </div>;
}
export const TextField = ({ label, missing, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; missing?: boolean }) =>
  <Field label={label} missing={missing} className={className}>{(id) => <input id={id} {...p} />}</Field>;
export const AreaField = ({ label, missing, className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; missing?: boolean }) =>
  <Field label={label} missing={missing} className={className}>{(id) => <textarea id={id} {...p} />}</Field>;

export type Opt = string | [string, string];
export function Select({ options, value, onChange, any, label, className, ...p }: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & { options: Opt[]; value?: string | number | null; onChange: (v: string) => void; any?: string | null; label?: string }) {
  return <select {...p} aria-label={label ?? p['aria-label']} className={className} value={value == null ? '' : String(value)} onChange={(e) => onChange(e.target.value)}>
    {any != null && <option value="">{any}</option>}
    {options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return <option key={v} value={v}>{l}</option>; })}
  </select>;
}
export const SelectField = ({ label, className, ...p }: Parameters<typeof Select>[0] & { label: string }) =>
  <Field label={label} className={className}>{(id) => <Select id={id} {...p} label={undefined} />}</Field>;

export function Check({ checked, onChange, children, className }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; className?: string }) {
  return <label className={cx('my-1.5 flex items-start gap-2 text-sm text-ink', className)}><input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span>{children}</span></label>;
}
/** Pill-shaped checkbox group for fixed choices. */
export function CheckPills({ options, value, onChange }: { options: [string, string][]; value: string[]; onChange: (v: string[]) => void }) {
  return <Row>{options.map(([v, l]) => <label key={v} className="mb-0 inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-px text-xs text-mute">
    <input type="checkbox" checked={value.includes(v)} onChange={(e) => onChange(e.target.checked ? [...value, v] : value.filter((x) => x !== v))} />{l}</label>)}</Row>;
}

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: [K, string][]; value: K; onChange: (k: K) => void }) {
  return <div role="tablist" className="my-2 flex gap-1 overflow-x-auto border-b border-line">
    {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={k === value} type="button" onClick={() => onChange(k)}
      className={cx('whitespace-nowrap border-b-2 px-3 py-1.5', k === value ? 'border-accent font-semibold text-accent' : 'border-transparent')}>{l}</button>)}
  </div>;
}
export const Chip = ({ on, approved, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean; approved?: boolean }) =>
  <button type="button" {...p} className={cx('rounded-full border px-3 py-0.5 text-[13px]', on ? 'border-accent bg-goodbg font-semibold text-accent' : 'border-line bg-card', approved && "before:content-['✓_']", className)} />;

// ---------- match meter ----------
const TIERS: [number, string, string][] = [[75, 'strong', 'Strong match'], [60, 'good', 'Good match'], [40, 'fair', 'Fair match'], [0, 'weak', 'Weak match']];
const RING: Record<string, string> = { strong: 'stroke-good', good: 'stroke-info', fair: 'stroke-warn', weak: 'stroke-bad' };
const LBL: Record<string, string> = { strong: 'text-good', good: 'text-mute', fair: 'text-warn', weak: 'text-bad' };
/** Ring + number + words: never colour alone. `~` marks a quick keyword estimate, not a full AI assessment. */
export function Meter({ score, method }: { score: number | null | undefined; method?: string }) {
  if (score == null) return <Pill title="Complete your profile to see match scores">No score</Pill>;
  const [, tier, label] = TIERS.find(([min]) => score >= min)!;
  const estimate = method !== 'ai'; const C = 2 * Math.PI * 15;
  return <span role="img" aria-label={`${score} percent, ${label}${estimate ? ', quick keyword estimate' : ', AI assessed'}`} className="meter inline-flex items-center gap-1.5 whitespace-nowrap"
    title={estimate ? 'Quick keyword estimate. Use Analyze Job for a full assessment.' : 'AI assessment'}>
    <svg viewBox="0 0 36 36" width="38" height="38" aria-hidden="true">
      <circle cx="18" cy="18" r="15" fill="none" strokeWidth="4" className="stroke-line" />
      <circle cx="18" cy="18" r="15" fill="none" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(C * score) / 100} ${C}`} transform="rotate(-90 18 18)" className={RING[tier]} />
      <text x="18" y="22" textAnchor="middle" className="fill-ink text-[11px] font-bold">{score}</text>
    </svg>
    <span aria-hidden="true" className={cx('text-xs font-semibold', LBL[tier])}>{label}{estimate && <span className="font-normal"> ~</span>}</span>
  </span>;
}

// ---------- dialogs & toast ----------
function Dialog({ req }: { req: DialogReq }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const id = useId();
  const inp = req.input;
  useEffect(() => { ref.current?.showModal(); }, []);
  const okDisabled = !!inp && (inp.match ? text.trim() !== inp.match : !inp.optional && !text.trim());
  const finish = (v: string | boolean | null) => { ref.current?.close(); req.resolve(v); };
  return <dialog ref={ref} aria-labelledby={`${id}t`} aria-describedby={`${id}b`} onCancel={(e) => { e.preventDefault(); finish(inp ? null : false); }}
    className={cx(req.danger && 'danger', 'w-[calc(100%-2rem)] max-w-[520px] rounded-[14px] border border-line bg-card p-5 text-ink shadow-2xl max-sm:p-4', req.danger && 'border-t-4 border-t-bad')}>
    <h2 id={`${id}t`} className="mb-2">{req.title}</h2>
    <div id={`${id}b`}>
      {req.body && <p className="mb-2 whitespace-pre-wrap">{req.body}</p>}
      {req.items?.length ? <List items={req.items} /> : null}
      {inp && <div className="my-1.5"><label htmlFor={`${id}i`}>{inp.label}</label>
        {inp.multiline ? <textarea id={`${id}i`} autoFocus value={text} placeholder={inp.placeholder} onChange={(e) => setText(e.target.value)} />
          : <input id={`${id}i`} autoFocus autoComplete="off" value={text} placeholder={inp.placeholder} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !okDisabled) { e.preventDefault(); finish(text.trim()); } }} />}</div>}
    </div>
    <div className="mt-4 flex flex-wrap justify-end gap-2 max-sm:flex-col-reverse max-sm:[&>button]:w-full">
      <button type="button" autoFocus={!!req.danger && !inp} className={btnClass()} onClick={() => finish(inp ? null : false)}>{req.cancelLabel}</button>
      <button type="button" disabled={okDisabled} className={cx(btnClass(req.danger ? 'danger' : 'primary'), req.danger && 'border-bad bg-bad text-white hover:border-bad')} onClick={() => finish(inp ? text.trim() : true)}>{req.confirmLabel}</button>
    </div>
  </dialog>;
}
export function DialogHost() { const stack = dialogStore.use(); return <>{stack.map((d) => <Dialog key={d.id} req={d} />)}</>; }

export function ToastHost() {
  const t = toastStore.use();
  return <div id="toast" role={t?.bad ? 'alert' : 'status'} aria-live="polite"
    className={cx('pointer-events-none fixed left-4 right-4 top-[76px] z-40 ml-auto w-fit max-w-[420px] rounded-[10px] px-3.5 py-2.5 shadow-lg max-sm:bottom-3 max-sm:left-3 max-sm:right-3 max-sm:top-auto max-sm:w-auto max-sm:max-w-none', t ? (t.bad ? 'bg-bad text-white' : 'bg-ink text-bg') : 'hidden')}>{t?.text}</div>;
}
