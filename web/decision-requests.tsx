import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import ReactMarkdown from 'react-markdown';
import { decisionRequestSchema, decisionNoticeSchema } from '../src/contracts/decision-requests';
import { request } from './request';
import { WorkbenchForm, text, useWorkbenchCommand } from './workbench-form';
import styles from './workbench.module.css';
const states = {
  pending: '待答复',
  'needs-info': '待提出者补充',
  answered: '已答复',
  rejected: '已拒绝',
  withdrawn: '已撤回',
};
export function DecisionRequests({
  projectId,
  initialRequestId = null,
}: {
  projectId: string;
  initialRequestId?: string | null;
}) {
  const [related, setRelated] = useState(false),
    [selected, setSelected] = useState<string | null>(initialRequestId),
    base = `/api/projects/${projectId}/decision-requests`,
    run = useWorkbenchCommand(projectId);
  const query = useQuery({
    queryKey: ['decision-requests', projectId, related],
    queryFn: async () =>
      z
        .array(decisionRequestSchema)
        .parse(await request(base + '?scope=' + (related ? 'related' : 'mine'))),
    refetchInterval: 1500,
  });
  const detail = useQuery({
    queryKey: ['decision-request', projectId, selected],
    queryFn: async () =>
      z
        .object({ request: decisionRequestSchema, notices: z.array(decisionNoticeSchema) })
        .parse(await request(base + '/' + selected)),
    enabled: selected !== null,
    refetchInterval: 1500,
  });
  const current = detail.data?.request;
  return (
    <section aria-label="决定请求">
      <h4>决定请求</h4>
      <p>默认显示等待本人答复的请求。答复只覆盖本次明确事项；票据要求和暂停控制仍分别办理。</p>
      <label>
        <input type="checkbox" checked={related} onChange={(e) => setRelated(e.target.checked)} />
        显示相关请求及已处理历史
      </label>
      {query.isPending ? (
        <p role="status">正在读取请求…</p>
      ) : query.isError ? (
        <p role="alert">{query.error.message}</p>
      ) : query.data.length === 0 ? (
        <p>当前没有待显示的请求。</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.ticketTable}>
            <thead>
              <tr>
                <th>请求</th>
                <th>提出者</th>
                <th>责任入口</th>
                <th>当前状态</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => setSelected(r.id)}
                    >
                      {r.subject}
                    </button>
                    <div>
                      {r.id} · 修订 {r.revision}
                    </div>
                  </td>
                  <td>{r.requester.address ?? '用户'}</td>
                  <td>{r.assignee.kind === 'user' ? '用户' : r.assignee.sessionId}</td>
                  <td>{states[r.state]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail.isError && <p role="alert">{detail.error.message}</p>}
      {current && (
        <section aria-label="请求详情">
          <h4>{current.subject}</h4>
          <p>
            {states[current.state]} · 修订 {current.revision} · {current.id}
          </p>
          <dl>
            <dt>原票</dt>
            <dd>{current.ticketId}</dd>
            <dt>执行</dt>
            <dd>{current.executionId}</dd>
            <dt>提出者</dt>
            <dd>{current.requester.address ?? '用户'}</dd>
            <dt>影响范围</dt>
            <dd>{current.impact}</dd>
          </dl>
          <div className={styles.markdown}>
            <ReactMarkdown>{current.question}</ReactMarkdown>
          </div>
          {current.references.length > 0 && (
            <details>
              <summary>原请求依据与引用</summary>
              <ul>
                {current.references.map((ref, i) => (
                  <li key={i}>{ref}</li>
                ))}
              </ul>
            </details>
          )}
          {current.reply && (
            <section aria-label="已保存答复">
              <h5>已保存答复</h5>
              <p>
                {current.reply.choice} · {current.reply.author.address ?? '用户'} · 针对修订{' '}
                {current.reply.requestRevision}
              </p>
              <div className={styles.markdown}>
                <ReactMarkdown>{current.reply.answer}</ReactMarkdown>
              </div>
              <p>限制：{current.reply.restrictions || '未另列'}</p>
            </section>
          )}
          {current.state === 'pending' && current.assignee.kind === 'user' && (
            <WorkbenchForm
              key={current.id + ':' + current.revision}
              title="答复原请求"
              trigger="答复此请求"
              description="保存完整答复和限制。接受不等于工作已交付，也不解除已有效的暂停。"
              onSubmit={(data) =>
                run(base + '/' + current.id + '/reply', {
                  expectedRevision: current.revision,
                  choice: text(data, 'choice'),
                  answer: text(data, 'answer'),
                  restrictions: text(data, 'restrictions'),
                })
              }
            >
              <label>
                处理方式
                <select name="choice" aria-label="处理方式" defaultValue="answer">
                  <option value="answer">答复</option>
                  <option value="accept">接受本次事项</option>
                  <option value="reject">拒绝</option>
                  <option value="need-info">要求补充</option>
                </select>
              </label>
              <label>
                完整答复
                <textarea name="answer" aria-label="完整答复" required maxLength={16000} />
              </label>
              <label>
                范围与限制
                <textarea name="restrictions" aria-label="范围与限制" maxLength={16000} />
              </label>
            </WorkbenchForm>
          )}
          <WorkbenchForm
            title="补投原通知"
            trigger="补投原通知"
            description="只按原请求身份核对投递，不新增请求或答复，不恢复暂停入口。"
            onSubmit={() => run(base + '/' + current.id + '/retry-notices', {})}
          >
            <p>对象：{current.id}</p>
          </WorkbenchForm>
          <details>
            <summary>办理与责任历史</summary>
            <ol>
              {current.history.map((h) => (
                <li key={h.revision}>
                  修订 {h.revision} · {h.action} · {h.actor.address ?? '用户'} · {h.at}
                  <pre>{JSON.stringify(h.data, null, 2)}</pre>
                </li>
              ))}
            </ol>
          </details>
          <details>
            <summary>通知投递事实</summary>
            <ul>
              {detail.data!.notices.map((n) => (
                <li key={n.id}>
                  修订 {n.revision} · {n.target.kind === 'user' ? '用户' : n.target.sessionId} ·{' '}
                  {n.delivery}
                  {n.deliveryNote ? ' · ' + n.deliveryNote : ''}
                </li>
              ))}
            </ul>
            <p>保存、持久接纳、已读和业务办理是不同事实。</p>
          </details>
        </section>
      )}
    </section>
  );
}
