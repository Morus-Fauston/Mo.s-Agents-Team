import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { worktreeRecordSchema } from '../src/contracts/worktrees';
import { request } from './request';
import styles from './workbench.module.css';
const labels = {
  reserved: '已登记，待创建',
  creating: '官方创建进行中',
  ready: '创建已核定',
  unknown: '结果待核定',
  missing: '目录不可用',
  retained: '现场已保留',
  removing: '明确清理进行中',
  removed: '检出已清理，原记录保留',
};
export function WorktreeDetails({ base, id }: { base: string; id: string }) {
  const [open, setOpen] = useState(false),
    q = useQuery({
      queryKey: ['worktree', base, id],
      enabled: open,
      refetchInterval: 3000,
      queryFn: async () =>
        z
          .object({ record: worktreeRecordSchema, history: z.array(z.unknown()) })
          .parse(await request(base + `/worktrees/${id}`)),
    }),
    v = q.data?.record;
  return (
    <section>
      <button type="button" className={styles.textButton} onClick={() => setOpen(!open)}>
        {open ? '收起' : '查看'}工作树依据与关联
      </button>
      {open && (
        <>
          {q.isPending && <p role="status">正在读取原工作树…</p>}
          {q.isError && <p role="alert">{q.error.message}</p>}
          {v && (
            <>
              <h5>{labels[v.status]}</h5>
              <dl className={styles.facts}>
                <dt>记录</dt>
                <dd>
                  {v.id} · 修订 {v.revision}
                </dd>
                <dt>明确依据</dt>
                <dd>{v.basis}</dd>
                <dt>创建来源仓库</dt>
                <dd>{v.source.repository}</dd>
                <dt>原创建基线</dt>
                <dd>{v.source.commit}</dd>
                <dt>检出目录</dt>
                <dd>{v.path ?? '尚未核定'}</dd>
                <dt>分支</dt>
                <dd>{v.branch ?? v.name}</dd>
                <dt>原创建实际会话</dt>
                <dd>{v.creatorSessionId}</dd>
                <dt>原创建目录接纳</dt>
                <dd>{v.directoryPublication === 'confirmed' ? '已确认持久接纳' : '尚未核定'}</dd>
                <dt>主管原目录恢复</dt>
                <dd>
                  {v.restore.required
                    ? v.restore.confirmed
                      ? '已确认'
                      : '尚未核定'
                    : '原主自用，不迁移已有进程'}
                </dd>
              </dl>
              {v.error && <p role="alert">{v.error}</p>}
              {v.cleanup && (
                <>
                  <h5>明确清理的实际结果</h5>
                  <dl className={styles.facts}>
                    <dt>原安排</dt>
                    <dd>{v.cleanup.operationId}</dd>
                    <dt>实际主管</dt>
                    <dd>{v.cleanup.actor.sessionId}</dd>
                    <dt>明确依据</dt>
                    <dd>{v.cleanup.basis}</dd>
                    <dt>结果</dt>
                    <dd>
                      {
                        {
                          running: '原生清理进行中',
                          unknown: '结果待核定，不重复删除',
                          failed: '本次未清理，现场完整保留',
                          removed: '已独立核定检出移除',
                        }[v.cleanup.state]
                      }
                    </dd>
                    <dt>分支与固定原件</dt>
                    <dd>
                      {v.cleanup.proof?.branchRetained && v.cleanup.proof.retainedEvidence
                        ? '已核对保留'
                        : '尚未核定'}
                    </dd>
                    <dt>受管进程范围</dt>
                    <dd>
                      {v.cleanup.process?.rangeGone ||
                      (v.cleanup.ranges.length > 0 &&
                        v.cleanup.ranges.every((r) => r.state === 'gone'))
                        ? '已确认消失'
                        : '尚未核定'}
                    </dd>
                  </dl>
                  {v.cleanup.error && <p role="status">{v.cleanup.error}</p>}
                </>
              )}
              <h5>实际派工关联</h5>
              {v.associations.length ? (
                <div className={styles.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th>票据</th>
                        <th>执行</th>
                        <th>当时实际 HEAD</th>
                        <th>固定基线版本</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.associations.map((a) => (
                        <tr key={a.executionId}>
                          <td>{a.ticketId}</td>
                          <td>{a.executionId}</td>
                          <td>{a.head}</td>
                          <td>{a.baselineVersionId ?? '尚未关联'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>尚无正式派工关联。准备工作树不等于主执行已启动。</p>
              )}
              <details>
                <summary>创建时原工作区差异目录</summary>
                <p>这些修改留在原树；创建从明确本地 commit 检出。</p>
                <ul>
                  {v.source.changes.map((f, i) => (
                    <li key={i}>
                      {f.x}
                      {f.y} · {f.path}
                    </li>
                  ))}
                </ul>
              </details>
              <details>
                <summary>原生阶段与操作历史</summary>
                <pre className={styles.filePreview}>
                  {JSON.stringify(
                    { phases: v.phases, ranges: v.ranges, history: q.data?.history },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <p>
                默认保留现场。票据、Log、独审和材料仍归固定宿主项目；目录独立不代表设备或进程隔离。
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
export function WorktreeDirectory({ base }: { base: string }) {
  const q = useQuery({
    queryKey: ['worktrees', base],
    refetchInterval: 3000,
    queryFn: async () => z.array(worktreeRecordSchema).parse(await request(base + '/worktrees')),
  });
  return (
    <section aria-label="项目工作树">
      <h3>工作树</h3>
      <p className={styles.description}>
        按独立执行需要准备，由主管明确关联本票或续用；执行结束后默认保留。
      </p>
      {q.isPending && <p role="status">正在读取工作树…</p>}
      {q.isError && <p role="alert">{q.error.message}</p>}
      {q.data?.length === 0 && <p>尚无已登记工作树。</p>}
      {q.data?.map((v) => (
        <article className={styles.recordRow} key={v.id}>
          <h4>
            {v.name} · {labels[v.status]}
          </h4>
          <p>{v.path ?? '创建目录尚未核定'}</p>
          <WorktreeDetails base={base} id={v.id} />
        </article>
      ))}
    </section>
  );
}
