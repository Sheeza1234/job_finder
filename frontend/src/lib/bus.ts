// Tiny external stores for the toast and the dialog stack, so any module (including api()) can use them without props.
import { useSyncExternalStore } from 'react';

export interface ToastMsg { id: number; text: string; bad: boolean }
export interface DialogReq {
  id: number; title: string; body?: string; items?: string[]; danger?: boolean; confirmLabel: string; cancelLabel: string;
  input?: { label: string; match?: string; optional?: boolean; placeholder?: string; multiline?: boolean };
  resolve: (v: string | boolean | null) => void;
}
export type ConfirmOpts = { title: string; body?: string; items?: string[]; danger?: boolean; confirmLabel?: string; cancelLabel?: string };
export type TextOpts = ConfirmOpts & { label: string; match?: string; optional?: boolean; placeholder?: string; multiline?: boolean };

function store<T>(initial: T) {
  let value = initial; const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => { value = v; subs.forEach((f) => f()); },
    use: () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => value),
  };
}

export const toastStore = store<ToastMsg | null>(null);
export const dialogStore = store<DialogReq[]>([]);

let seq = 0, toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, bad = false) {
  const id = ++seq; toastStore.set({ id, text, bad });
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { if (toastStore.get()?.id === id) toastStore.set(null); }, bad ? 7000 : 3000);
}

const open = (o: Omit<DialogReq, 'id' | 'resolve' | 'confirmLabel' | 'cancelLabel'> & { confirmLabel?: string; cancelLabel?: string }) =>
  new Promise<string | boolean | null>((resolve) => {
    const req: DialogReq = { ...o, id: ++seq, confirmLabel: o.confirmLabel ?? 'Confirm', cancelLabel: o.cancelLabel ?? 'Cancel', resolve: (v) => { dialogStore.set(dialogStore.get().filter((d) => d !== req)); resolve(v); } };
    dialogStore.set([...dialogStore.get(), req]);
  });

export const askConfirm = async (o: ConfirmOpts): Promise<boolean> => (await open(o)) === true;
/** Resolves with the typed text, or null when cancelled. */
export const askText = async (o: TextOpts): Promise<string | null> => {
  const { label, match, optional, placeholder, multiline, ...rest } = o;
  const r = await open({ ...rest, input: { label, match, optional, placeholder, multiline } });
  return typeof r === 'string' ? r : null;
};
