import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import ReactMarkdown from 'react-markdown';
import { researchQuestionSchema, researchAnswerSchema } from '../src/contracts/workbench';
import { deliveryVersionSchema } from '../src/contracts/versions';
import { versionReports } from '../src/services/version-reports';
import type { ResearchQuestion, ResearchAnswer } from '../src/contracts/workbench';
import { request } from './request';
import { WorkbenchForm, text, lines } from './workbench-form';
import type { WorkbenchCommand } from './workbench-form';
import styles from './workbench.module.css';
const coverageLabels = {
  unanswered: '尚无回答',
  current: '回答对应当前定义',
  outdated: '定义已变，回答待重新核对',
};
const answerLabels = { answered: '已记录回答', unconfirmed: '无法确认', gap: '仍有缺口' };
function Answer({ answer }: { answer: ResearchAnswer | null }) {
  return answer ? (
    <section aria-label="研究回答">
      <p>
        {answerLabels[answer.status]} · 回答修订 {answer.revision} · 对应问题定义{' '}
        {answer.questionRevision}
      </p>
      <p>
        {answer.author.address ?? '用户'} · {answer.createdAt}
      </p>
      <div className={styles.markdown}>
        <ReactMarkdown>{answer.content}</ReactMarkdown>
      </div>
      <p>未确认边界：{answer.unconfirmed || '未另列'}</p>
      <ul>
        {answer.evidence.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </section>
  ) : (
    <p>尚无正式回答。缺口保留，不自动勾选Checklist。</p>
  );
}
function QuestionFields({ question }: { question?: ResearchQuestion }) {
  return (
    <>
      <label>
        问题标题
        <input
          name="title"
          aria-label="问题标题"
          defaultValue={question?.title}
          required
          maxLength={160}
        />
      </label>
      <label>
        问题说明
        <textarea
          name="question"
          aria-label="问题说明"
          defaultValue={question?.question}
          required
          maxLength={16000}
        />
      </label>
      <label>
        需要证明什么
        <textarea
          name="condition"
          aria-label="需要证明什么"
          defaultValue={question?.condition}
          required
          maxLength={16000}
        />
      </label>
      <label>
        来源线索（每行一项）
        <textarea
          name="sources"
          aria-label="来源线索"
          defaultValue={question?.sources.join('\n')}
        />
      </label>
      <label>
        显示顺序
        <input
          name="order"
          aria-label="显示顺序"
          type="number"
          min={0}
          step={1}
          defaultValue={question?.order}
        />
      </label>
    </>
  );
}
export function ResearchDetails({
  projectId,
  ticketId,
  run,
}: {
  projectId: string;
  ticketId: string;
  run: WorkbenchCommand;
}) {
  const [selected, setSelected] = useState(''),
    base = `/api/projects/${projectId}/tickets/${ticketId}/research`;
  const query = useQuery({
    queryKey: ['research', projectId, ticketId],
    queryFn: async () =>
      z
        .object({
          body: z.string(),
          entries: z.array(
            z.object({
              question: researchQuestionSchema,
              answer: researchAnswerSchema.nullable(),
              coverage: z.enum(['unanswered', 'current', 'outdated']),
            }),
          ),
        })
        .parse(await request(base)),
  });
  const current =
    query.data?.entries.find((e) => e.question.id === selected) ?? query.data?.entries[0];
  const history = useQuery({
    queryKey: [
      'research-history',
      projectId,
      ticketId,
      current?.question.id,
      current?.question.revision,
      current?.answer?.revision,
    ],
    enabled: !!current,
    queryFn: () => request(base + '/' + current!.question.id + '/history'),
  });
  if (query.isPending) return <p role="status">正在读取研究问题…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  const fields = (data: FormData) => ({
    title: text(data, 'title'),
    question: text(data, 'question'),
    condition: text(data, 'condition'),
    sources: lines(text(data, 'sources')),
    ...(text(data, 'order') ? { order: Number(text(data, 'order')) } : {}),
  });
  return (
    <section aria-label="研究问题与回答">
      <h4>研究问题与回答</h4>
      <p>问题、回答、报告交付、独审和建议采纳分别记录。无法确认时保留证据和边界。</p>
      <div className={styles.markdown}>
        <ReactMarkdown>{query.data.body}</ReactMarkdown>
      </div>
      <WorkbenchForm
        title="新增研究问题"
        trigger="新增问题"
        description="软件分配稳定QXX。此处维护问题定义，不代替调查执行记录回答。"
        onSubmit={(data) => run(base, fields(data))}
      >
        <QuestionFields />
      </WorkbenchForm>
      {query.data.entries.length === 0 ? (
        <p>尚未登记研究问题。</p>
      ) : (
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>问题</th>
                <th>定义修订</th>
                <th>回答关系</th>
              </tr>
            </thead>
            <tbody>
              {query.data.entries.map((e) => (
                <tr key={e.question.id}>
                  <td>
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => setSelected(e.question.id)}
                    >
                      {e.question.id} · {e.question.title}
                    </button>
                  </td>
                  <td>{e.question.definitionRevision}</td>
                  <td>{coverageLabels[e.coverage]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {current && (
        <section aria-label="研究问题详情">
          <h5>
            {current.question.id} · {current.question.title}
          </h5>
          <p>{coverageLabels[current.coverage]}</p>
          <div className={styles.markdown}>
            <ReactMarkdown>{current.question.question}</ReactMarkdown>
          </div>
          <p>需要证明：{current.question.condition}</p>
          <ul>
            {current.question.sources.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
          <Answer answer={current.answer} />
          <WorkbenchForm
            key={current.question.id + ':' + current.question.revision}
            title={`维护 ${current.question.id}`}
            trigger={`维护 ${current.question.id}`}
            description="定义变化会保留旧回答并标出版本差异；排序不会改变问题编号。"
            onSubmit={(data) =>
              run(
                base + '/' + current.question.id,
                {
                  ...fields(data),
                  expectedRevision: current.question.revision,
                  reason: text(data, 'reason'),
                },
                'PATCH',
              )
            }
          >
            <QuestionFields question={current.question} />
            <label>
              修改原因
              <textarea name="reason" aria-label="修改原因" required />
            </label>
          </WorkbenchForm>
          <details>
            <summary>定义与回答修订历史</summary>
            {history.isError ? (
              <p role="alert">{history.error.message}</p>
            ) : (
              <pre>{history.data ? JSON.stringify(history.data, null, 2) : '正在读取…'}</pre>
            )}
          </details>
        </section>
      )}
    </section>
  );
}
export function ResearchVersion({
  projectId,
  executionId,
  versionId,
}: {
  projectId: string;
  executionId: string;
  versionId: string;
}) {
  const [selected, setSelected] = useState<{
      versionId: string;
      root: number;
      path: string;
    } | null>(null),
    base = `/api/projects/${projectId}/executions/${executionId}/versions`;
  const query = useQuery({
    queryKey: ['research-version', projectId, executionId, versionId],
    queryFn: async () => deliveryVersionSchema.parse(await request(base + '/' + versionId)),
  });
  const file = useQuery({
    queryKey: ['research-report', projectId, selected],
    enabled: selected?.versionId === versionId,
    queryFn: async () => {
      const r = await fetch(
        base +
          '/' +
          selected!.versionId +
          '/file?root=' +
          selected!.root +
          '&path=' +
          encodeURIComponent(selected!.path),
      );
      if (!r.ok) throw new Error('固定报告原件无法读取');
      return r.text();
    },
  });
  if (query.isPending) return <p role="status">正在读取固定研究交付…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  const v = query.data;
  if (v.ticket.kind !== 'research' || !v.ticket.research) return null;
  const reports = versionReports(v);
  return (
    <section aria-label="固定研究报告">
      <h4>固定研究报告与回答</h4>
      <p>以下原件和回答属于所选版本；不读取后来覆盖的当前文件，不代表建议已采纳。</p>
      <ul>
        {reports.map((report) => (
          <li key={report.absolute}>
            {report.absolute}
            {report.available ? (
              <>
                <a
                  href={
                    base +
                    '/' +
                    v.id +
                    '/file?root=' +
                    report.rootIndex +
                    '&path=' +
                    encodeURIComponent(report.path)
                  }
                  download
                >
                  下载此版本原件
                </a>
                {/\.(md|txt)$/i.test(report.path) && (
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() =>
                      setSelected({ versionId: v.id, root: report.rootIndex, path: report.path })
                    }
                  >
                    查看报告
                  </button>
                )}
              </>
            ) : (
              <span>此版本原件缺件</span>
            )}
          </li>
        ))}
      </ul>
      {file.isError && <p role="alert">{file.error.message}</p>}
      {selected?.versionId === versionId && file.data !== undefined && (
        <div className={styles.markdown}>
          <ReactMarkdown>{file.data}</ReactMarkdown>
        </div>
      )}
      {v.ticket.research.questions.map((q) => (
        <details key={q.id}>
          <summary>
            {q.id} · {q.title} · 定义 {q.definitionRevision}
          </summary>
          <p>{q.question}</p>
          <p>需要证明：{q.condition}</p>
          <Answer answer={v.researchAnswers.find((a) => a.questionId === q.id) ?? null} />
          {v.researchAnswers.some(
            (a) => a.questionId === q.id && a.questionRevision !== q.definitionRevision,
          ) && <p>该固定回答对应较早定义，覆盖缺口未消除。</p>}
        </details>
      ))}
    </section>
  );
}
