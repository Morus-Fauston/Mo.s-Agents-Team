import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { historyTargetSchema } from '../src/contracts/ticket-deliveries';
import { request } from './request';
import styles from './workbench.module.css';
export type HistoryTarget = z.infer<typeof historyTargetSchema>;
export function HistoryTargets({
  projectId,
  entryId,
  openTarget,
}: {
  projectId: string;
  entryId: string;
  openTarget: (target: HistoryTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['history-targets', projectId, entryId],
    enabled: open,
    queryFn: async () =>
      z
        .array(historyTargetSchema)
        .parse(
          await request(
            `/api/projects/${projectId}/history/${encodeURIComponent(entryId)}/targets`,
          ),
        ),
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>查看原记录与引用</summary>
      {query.isFetching && <p role="status">正在查找原业务记录…</p>}
      {query.isError && (
        <p role="alert" className={styles.error}>
          {query.error.message}
        </p>
      )}
      {query.data && (
        <ul>
          {query.data.map((row) => (
            <li key={row.reference}>
              {row.kind === 'unavailable' ? (
                <span>
                  {row.reference} · {row.label}
                </span>
              ) : (
                <button type="button" className={styles.textButton} onClick={() => openTarget(row)}>
                  {row.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
