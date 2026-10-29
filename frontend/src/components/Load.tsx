import type { ReactNode } from 'react';
import { ErrorState, Skeleton } from './ui';

interface Q<T> { data?: T; error?: Error; loading: boolean; reload: () => void }
/** Standard loading / error / content states for a loaded view. Keeps showing stale data while reloading. */
export function Loaded<T>({ q, children }: { q: Q<T>; children: (data: T) => ReactNode }) {
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (q.data === undefined) return <Skeleton />;
  return <>{children(q.data)}</>;
}
