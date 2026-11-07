import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { assistantSchema } from '../src/contracts/collaboration';
import { decisionRequestSchema } from '../src/contracts/decision-requests';
import { materialDomainSchema } from '../src/contracts/workbench';
import { materialReferenceSchema } from '../src/contracts/ticket-deliveries';
import { request } from './request';
import { MaterialPreview, liveMaterialPreview } from './ticket-delivery';
import styles from './workbench.module.css';

const relatedSchema = z.object({
  reviewedDependencies: z.array(
    z.object({
      ticketId: z.uuid(),
      deliveryId: z.string(),
      reviewId: z.string(),
      scope: z.string(),
    }),
  ),
  collaborations: z.array(
    assistantSchema
      .pick({
        id: true,
        executionId: true,
        name: true,
        purpose: true,
        state: true,
        sessionId: true,
        parentSessionId: true,
      })
      .extend({
        material: materialDomainSchema.nullable(),
        results: z.array(
          z.object({
            id: z.uuid(),
            action: z.enum(['complete', 'hangup']),
            content: z.string(),
            progress: z.enum(['saved', 'unknown', 'confirmed']),
            createdAt: z.string(),
            evidence: z.array(materialReferenceSchema),
          }),
        ),
        logs: z.array(z.object({ id: z.string(), title: z.string(), archived: z.boolean() })),
      }),
  ),
  decisions: z.array(decisionRequestSchema.pick({ id: true, subject: true, state: true })),
});
const progressLabels = { saved: '已保存，待核对', unknown: '待核对', confirmed: '已核定' };
const decisionLabels = {
  pending: '待答复',
  'needs-info': '待补充',
  answered: '已答复',
  rejected: '已拒绝',
  withdrawn: '已撤回',
};
const assistantLabels = {
  registered: '已登记',
  creating: '准备中',
  active: '在途',
  reporting: '回传核对中',
  waiting: '等待',
  unknown: '待核对',
  error: '异常',
  terminated: '已终止',
  completed: '已完成',
};

export function TicketRelatedRecords({
  path,
  projectId,
  openLog,
  openMaterial,
  openDelivery,
  openDecision,
}: {
  path: string;
  projectId: string;
  openLog: (id: string) => void;
  openMaterial: (directory: string) => void;
  openDelivery: (ticket: string, version: string) => void;
  openDecision: (id: string) => void;
}) {
  const query = useQuery({
    queryKey: ['ticket-relationships', projectId, path],
    queryFn: async () => relatedSchema.parse(await request(path + '/relationships')),
  });
  const [file, setFile] = useState<string | null>(null);
  if (query.isPending) return <p role="status">正在读取本票关联记录…</p>;
  if (query.isError)
    return (
      <p role="alert" className={styles.error}>
        {query.error.message}
      </p>
    );
  const related = query.data;
  return (
    <section aria-label="本票关联记录">
      <h4>本次派工采用的前置成果</h4>
      {related.reviewedDependencies.length ? (
        <ul>
          {related.reviewedDependencies.map((row) => (
            <li key={row.deliveryId}>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => openDelivery(row.ticketId, row.deliveryId)}
              >
                打开已审前置版本
              </button>
              <p>{row.scope}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p>本票当前执行没有记录采用的前置版本。</p>
      )}
      <h4>辅助与正式回传</h4>
      {related.collaborations.length ? (
        related.collaborations.map((row) => (
          <article className={styles.recordRow} key={row.id}>
            <h5>
              {row.name} · {assistantLabels[row.state]}
            </h5>
            <p>{row.purpose}</p>
            {row.material ? (
              <p>
                {row.material.roleCode} · {row.material.address} ·{' '}
                {row.material.available ? (
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => openMaterial(row.material!.relativePath)}
                  >
                    打开协作材料域
                  </button>
                ) : (
                  row.material.error
                )}
              </p>
            ) : (
              <p>材料域尚未确认。</p>
            )}
            {row.logs.length > 0 && (
              <p>
                协作 Log：
                {row.logs.map((log) => (
                  <button
                    type="button"
                    className={styles.textButton}
                    key={log.id}
                    onClick={() => openLog(log.id)}
                  >
                    {log.id} · {log.title}
                    {log.archived ? '（已归档）' : ''}
                  </button>
                ))}
              </p>
            )}
            {row.results.map((result) => (
              <details key={result.id}>
                <summary>
                  {result.action === 'complete' ? '完成回传' : '挂起回传'} ·{' '}
                  {progressLabels[result.progress]}
                </summary>
                <p>{result.content || '未附正文。'}</p>
                <small>
                  {result.createdAt} · {result.id}
                </small>
                {result.evidence.length > 0 && (
                  <ul>
                    {result.evidence.map((entry, i) => (
                      <li key={i}>
                        {entry.path ? (
                          <button
                            type="button"
                            className={styles.textButton}
                            onClick={() => setFile(entry.path)}
                          >
                            {entry.path} · 当前协作材料
                          </button>
                        ) : (
                          <span>{entry.reference} · 未找到本协作域原件</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            ))}
          </article>
        ))
      ) : (
        <p>本票没有已登记的辅助。</p>
      )}
      {file && <MaterialPreview key={file} selected={liveMaterialPreview(path, file)} />}
      <h4>正式决定请求</h4>
      {related.decisions.length ? (
        <ul>
          {related.decisions.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => openDecision(row.id)}
              >
                {row.subject} · {decisionLabels[row.state]}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>本票暂无可读决定请求。</p>
      )}
    </section>
  );
}
