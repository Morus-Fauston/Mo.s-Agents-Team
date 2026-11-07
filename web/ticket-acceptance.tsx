import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  acceptanceAssignmentSchema,
  acceptanceRecordSchema,
  ticketAcceptanceSchema,
  supplementSchema,
  escalationSchema,
  acceptanceNoticeSchema,
} from '../src/contracts/acceptance';
import { reviewResultSchema } from '../src/contracts/review-results';
import { request } from './request';
import { WorkbenchForm, text, lines, useWorkbenchCommand } from './workbench-form';
import styles from './workbench.module.css';
const acceptanceViewSchema = z.object({
  ticketId: z.uuid(),
  state: z.string(),
  assignments: z.array(
    z.object({ assignment: acceptanceAssignmentSchema, result: acceptanceRecordSchema.nullable() }),
  ),
  accepted: z.array(ticketAcceptanceSchema),
  supplements: z.array(supplementSchema),
  escalations: z.array(escalationSchema),
  notices: z.array(acceptanceNoticeSchema),
});
export function TicketAcceptance({
  projectId,
  ticketId,
  openVersion,
  recordId,
  showAll,
}: {
  projectId: string;
  ticketId: string;
  openVersion: (id: string) => void;
  recordId: string | null;
  showAll: () => void;
}) {
  const base = `/api/projects/${projectId}`,
    run = useWorkbenchCommand(projectId),
    query = useQuery({
      queryKey: ['acceptance', projectId, ticketId],
      queryFn: async () => ({
        acceptance: acceptanceViewSchema.parse(
          await request(base + `/tickets/${ticketId}/acceptance`),
        ),
        opinions: z
          .array(reviewResultSchema)
          .parse(await request(base + '/review-results'))
          .filter((item) => item.ticketId === ticketId),
      }),
    });
  if (query.isPending) return <p role="status">正在读取正式审阅及验收…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  const { acceptance: a, opinions } = query.data;
  const assignments = recordId
      ? a.assignments.filter(
          ({ assignment, result }) => assignment.id === recordId || result?.id === recordId,
        )
      : a.assignments,
    accepted = recordId ? a.accepted.filter((item) => item.id === recordId) : a.accepted,
    versionId = assignments[0]?.assignment.versionId ?? accepted[0]?.versionId,
    visibleOpinions = recordId ? opinions.filter((item) => item.versionId === versionId) : opinions;
  return (
    <section aria-label="审阅与验收">
      {recordId && (
        <p>
          {versionId ? '已定位原验收记录。' : '该验收记录不属于本票或不可读。'}{' '}
          <button type="button" className={styles.button} onClick={showAll}>
            查看本票全部验收
          </button>
        </p>
      )}
      <h4>正式审阅与办理进展</h4>
      {!visibleOpinions.length && (
        <p>{recordId ? '没有可读的对应版本意见。' : '尚无正式审阅意见。'}</p>
      )}
      {visibleOpinions.map((r) => (
        <article key={r.id} aria-label={r.verdict === 'pass' ? '正式通过意见' : '正式退回意见'}>
          <h5>{r.verdict === 'pass' ? '审阅通过' : '退回原尝试修正'}</h5>
          <dl className={styles.facts}>
            <dt>固定版本</dt>
            <dd>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => openVersion(r.versionId)}
              >
                查看对应固定成果
              </button>{' '}
              · {r.versionId}
            </dd>
            <dt>实际审阅者</dt>
            <dd>{r.author.address ?? r.author.sessionId}</dd>
            <dt>正式意见</dt>
            <dd>{r.id}</dd>
            <dt>前次意见</dt>
            <dd>{r.previousResultId ?? '首次'}</dd>
            <dt>审核收尾</dt>
            <dd>
              {r.reviewCleanup.state} · {r.reviewCleanup.note}
            </dd>
            <dt>原执行办理</dt>
            <dd>
              {r.authorAction.state} · {r.authorAction.note}
            </dd>
            <dt>总进展</dt>
            <dd>
              {r.progress.state} · {r.progress.note}
            </dd>
          </dl>
          <p>范围：{r.scope}</p>
          <p className={styles.markdown}>依据：{r.basis}</p>
          {!!r.issues.length && (
            <ul>
              {r.issues.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
          <p>证据：{r.evidencePaths.join('、') || '未另列'}</p>
          <p>记录时间：{r.createdAt}</p>
          {r.progress.state === 'unknown' && (
            <WorkbenchForm
              title="接续原正式结果"
              trigger="核对后接续原结果"
              description="只办理原结果。存在上级停止时须确认已停稳并填最新控制修订；不替代原尝试，不解除未知或终止。"
              onSubmit={(form) =>
                run(base + `/review-results/${r.id}/retry`, {
                  reason: text(form, 'reason'),
                  ...(text(form, 'controlRevision')
                    ? { expectedControlRevision: Number(text(form, 'controlRevision')) }
                    : {}),
                })
              }
            >
              <label>
                接续依据
                <textarea aria-label="接续依据" name="reason" required />
              </label>
              <label>
                已核实的最新控制修订（无上级停止可留空）
                <input
                  aria-label="已核实的最新控制修订"
                  name="controlRevision"
                  type="number"
                  min="0"
                  step="1"
                />
              </label>
            </WorkbenchForm>
          )}
        </article>
      ))}
      <h4>指定验收</h4>
      <p>
        主管根据对应版本安排责任方。人工项由你记录接受或退回；主管再核对整票并确认完成。需补做已收尾成果时，由主管明确安排关联新尝试。
      </p>
      {!recordId && !assignments.length && <p>尚无指定验收安排。</p>}
      {assignments.map(({ assignment: s, result: r }) => (
        <article key={s.id} aria-label="指定验收事项">
          <h5>
            {s.criterion} · {s.required ? '必需' : '可选'}
            {!s.active ? ' · 已替代' : ''}
          </h5>
          <p>责任方：{s.owner.kind === 'user' ? '用户本人' : s.owner.sessionId}</p>
          <p>固定版本：{s.versionId}</p>
          <p>安排依据：{s.reason}</p>
          {recordId && (
            <p>
              安排 {s.id}
              {r ? ` · 结果 ${r.id}` : ''}
            </p>
          )}
          {r ? (
            <>
              <p>
                {r.decision === 'accept' ? '已接受' : '已退回'} · {r.basis}
              </p>
              <p>
                实际来源：{r.author.kind === 'user' ? '用户本人' : r.author.address} · {r.createdAt}
              </p>
              <p>
                关联 Log：{r.logId ?? '仅记录结果'}；证据：{r.evidencePaths.join('、') || '未另列'}
              </p>
            </>
          ) : (
            <p>尚未取得指定责任方结果。</p>
          )}
          {s.active && !r && s.owner.kind === 'user' && (
            <WorkbenchForm
              title="记录本人验收"
              trigger="办理本人验收"
              description="此操作以当前用户身份保存对应固定版本的不可变验收结果；不会代主管结票。"
              onSubmit={(form) =>
                run(base + '/acceptance-results', {
                  assignmentId: s.id,
                  decision: text(form, 'decision'),
                  basis: text(form, 'basis'),
                  evidencePaths: lines(text(form, 'evidence')),
                  checkCondition: form.get('checkCondition') === 'on',
                })
              }
            >
              <label>
                本人的结论
                <select aria-label="本人的结论" name="decision" defaultValue="return">
                  <option value="return">退回，并说明问题</option>
                  <option value="accept">接受，并说明依据</option>
                </select>
              </label>
              <label>
                验收依据
                <textarea aria-label="验收依据" name="basis" required />
              </label>
              <label>
                验收证据（每行一项）
                <textarea aria-label="验收证据" name="evidence" />
              </label>
              {s.conditionId && (
                <label className={styles.checkboxField}>
                  <input type="checkbox" name="checkCondition" defaultChecked />
                  <span>同次保存验证 Log 并更新本项 Checklist</span>
                </label>
              )}
            </WorkbenchForm>
          )}
        </article>
      ))}
      {accepted.map((r) => (
        <article key={r.id}>
          <h5>主管整体接受</h5>
          {recordId && <p>接受记录 {r.id}</p>}
          <p>{r.basis}</p>
          <p>
            对应版本：{r.versionId} · 实际主管：{r.author.address} · {r.createdAt}
          </p>
        </article>
      ))}
      {!recordId &&
        a.supplements.map((r) => (
          <article key={r.id}>
            <h5>主管退回补做</h5>
            <p>{r.reason}</p>
            <p>
              旧尝试 {r.previousExecutionId} → 新尝试 {r.executionId}
            </p>
            <p>关联意见：{r.resultId}</p>
          </article>
        ))}
      {!recordId &&
        a.escalations.map((r) => (
          <article key={r.id}>
            <h5>显式争议与扩围请求 · {r.kind}</h5>
            <p>{r.basis}</p>
            <p>
              原意见 {r.resultId} · 主管待处理 {r.taskId}
            </p>
          </article>
        ))}
      <details>
        <summary>通知回执</summary>
        <ul>
          {a.notices.map((n) => (
            <li key={n.id}>
              {n.state} · {n.targetSessionId} · {n.error ?? '消息保存或投递不代表业务办结'}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
