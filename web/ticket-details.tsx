import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  ticketSchema,
  logSchema,
  authorSchema,
  materialDomainSchema,
} from '../src/contracts/workbench';
import type { TicketRecord, ChecklistItem, LogRecord } from '../src/contracts/workbench';
import type { WorkbenchSnapshot } from './workbench';
import { stateLabels, logTypeLabels, importanceLabels } from './ticket-state';
import { WorkbenchForm, text, lines, VerificationSelect } from './workbench-form';
import type { WorkbenchCommand } from './workbench-form';
import { request } from './request';
import { ExecutionObservation } from './execution-observation';
import { TicketAcceptance } from './ticket-acceptance';
import styles from './workbench.module.css';
function Markdown({ content }: { content: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className={styles.tableWrap}>
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
function EditTicket({
  ticket,
  data,
  base,
  run,
}: {
  ticket: TicketRecord;
  data: WorkbenchSnapshot;
  base: string;
  run: WorkbenchCommand;
}) {
  return (
    <WorkbenchForm
      title={`维护 ${ticket.code}`}
      trigger="编辑要求"
      onSubmit={(form) =>
        run(
          base + `/tickets/${ticket.id}`,
          {
            expectedRevision: ticket.revision,
            reason: text(form, 'reason'),
            title: text(form, 'title'),
            goal: text(form, 'goal'),
            included: text(form, 'included'),
            excluded: text(form, 'excluded'),
            phaseId: text(form, 'phaseId'),
            categoryId: text(form, 'categoryId'),
            dependencies: form.getAll('dependencies').map(String),
          },
          'PATCH',
        )
      }
    >
      <label>
        名称
        <input aria-label="名称" name="title" defaultValue={ticket.title} required />
      </label>
      <label>
        主要结果
        <textarea aria-label="主要结果" name="goal" defaultValue={ticket.goal} required />
      </label>
      <label>
        包含范围
        <textarea aria-label="包含范围" name="included" defaultValue={ticket.included} required />
      </label>
      <label>
        不包含
        <textarea aria-label="不包含" name="excluded" defaultValue={ticket.excluded} />
      </label>
      <label>
        当前归属期次
        <select aria-label="当前归属期次" name="phaseId" defaultValue={ticket.phaseId}>
          {data.phases.map((phase) => (
            <option key={phase.id} value={phase.id}>
              {phase.code} {phase.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        当前类别
        <select aria-label="当前类别" name="categoryId" defaultValue={ticket.categoryId}>
          {data.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.code} {category.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        直接依赖
        <select
          aria-label="直接依赖"
          name="dependencies"
          multiple
          defaultValue={ticket.dependencies}
        >
          {data.tickets
            .filter((value) => value.id !== ticket.id)
            .map((value) => (
              <option key={value.id} value={value.id}>
                {value.code} {value.title}
              </option>
            ))}
        </select>
      </label>
      <label>
        修改理由
        <textarea aria-label="修改理由" name="reason" required />
      </label>
      <p className={styles.description}>
        编号 {ticket.code} 保持不变。条件修改在 Checklist 中单独维护。
      </p>
    </WorkbenchForm>
  );
}
function LogFields({ corrects = '' }: { corrects?: string }) {
  return (
    <>
      <label>
        Log 标题
        <input aria-label="Log 标题" name="logTitle" required />
      </label>
      <label>
        Log 正文
        <textarea aria-label="Log 正文" name="logContent" required />
      </label>
      <label>
        主类型
        <select aria-label="主类型" name="logType" defaultValue="verification">
          <option value="progress">进展</option>
          <option value="discovery">发现</option>
          <option value="judgment">判断</option>
          <option value="verification">验证</option>
          <option value="problem">问题</option>
          <option value="continuation">接续</option>
        </select>
      </label>
      <label>
        重要程度
        <select aria-label="重要程度" name="importance" defaultValue="normal">
          <option value="normal">一般</option>
          <option value="important">重要</option>
          <option value="critical">关键</option>
        </select>
      </label>
      <label>
        证据引用（每行一项）
        <textarea aria-label="证据引用（每行一项）" name="references" />
      </label>
      <label>
        纠正原 Log ID（可选）
        <input aria-label="纠正原 Log ID（可选）" name="corrects" defaultValue={corrects} />
      </label>
    </>
  );
}
function logBody(form: FormData) {
  return {
    title: text(form, 'logTitle'),
    content: text(form, 'logContent'),
    type: text(form, 'logType'),
    importance: text(form, 'importance'),
    references: lines(text(form, 'references')),
    ...(text(form, 'corrects') ? { corrects: text(form, 'corrects') } : {}),
  };
}
function ChecklistBasis() {
  const [mode, setMode] = useState('new');
  return (
    <>
      <label>
        Log 依据
        <select
          aria-label="Log 依据"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
          name="logMode"
        >
          <option value="new">同次新建 Log</option>
          <option value="existing">引用同票已有 Log</option>
        </select>
      </label>
      {mode === 'existing' ? (
        <label>
          已有 Log ID
          <input aria-label="已有 Log ID" name="logId" required placeholder="L001" />
        </label>
      ) : (
        <LogFields />
      )}
    </>
  );
}
function Checklist({
  ticket,
  base,
  run,
}: {
  ticket: TicketRecord;
  base: string;
  run: WorkbenchCommand;
}) {
  const path = base + `/tickets/${ticket.id}`;
  return (
    <section>
      <p className={styles.description}>
        更新结果必须有同票 Log。勾选不会送审、验收或结票；人工项只由用户确认。
      </p>
      {ticket.checklist.map((item) => (
        <article key={item.id} className={styles.recordRow}>
          <h4>
            {item.checked ? '☑' : '☐'} {item.id} {item.condition}
          </h4>
          <p>
            {item.verification === 'manual'
              ? '用户人工确认'
              : item.verification === 'review'
                ? '独立审阅'
                : '自动化验证'}{' '}
            · 条件修订 {item.revision}
          </p>
          <p>
            {item.result || '尚无结果'}
            {item.logId ? ' · 依据 ' + item.logId : ''}
          </p>
          <div className={styles.actions}>
            <WorkbenchForm
              title={`记录 Checklist ${item.id}`}
              trigger={`更新结果 ${item.id}`}
              description="此操作以当前用户为记录者保存结果；不会冒用开发会话或自动完成票据。"
              onSubmit={(form) =>
                run(path + '/checklist', {
                  updates: [
                    {
                      id: item.id,
                      expectedRevision: item.revision,
                      checked: text(form, 'checked') === 'true',
                      result: text(form, 'result'),
                    },
                  ],
                  ...(text(form, 'logMode') === 'existing'
                    ? { logId: text(form, 'logId') }
                    : { newLog: logBody(form) }),
                })
              }
            >
              <p>{item.condition}</p>
              <label>
                当前结果
                <select aria-label="当前结果" name="checked" defaultValue={String(item.checked)}>
                  <option value="false">尚未满足</option>
                  <option value="true">已有依据满足</option>
                </select>
              </label>
              <label>
                结果说明
                <textarea aria-label="结果说明" name="result" required defaultValue={item.result} />
              </label>
              <ChecklistBasis />
            </WorkbenchForm>
            <WorkbenchForm
              title={`修改条件 ${item.id}`}
              trigger={`编辑条件 ${item.id}`}
              description="实质改变条件会使这一项原有结果失效，保留旧条件与证据历史。"
              onSubmit={(form) =>
                run(
                  path + `/conditions/${item.id}`,
                  {
                    expectedRevision: item.revision,
                    condition: text(form, 'condition'),
                    verification: text(form, 'verification'),
                    reason: text(form, 'reason'),
                  },
                  'PATCH',
                )
              }
            >
              <label>
                条件
                <textarea
                  aria-label="条件"
                  name="condition"
                  defaultValue={item.condition}
                  required
                />
              </label>
              <VerificationSelect value={item.verification} />
              <label>
                修改理由
                <textarea aria-label="修改理由" name="reason" required />
              </label>
            </WorkbenchForm>
          </div>
        </article>
      ))}
      <WorkbenchForm
        title="增加 Checklist 条件"
        trigger="增加条件"
        onSubmit={(form) =>
          run(path + '/conditions', {
            condition: text(form, 'condition'),
            verification: text(form, 'verification'),
            reason: text(form, 'reason'),
          })
        }
      >
        <label>
          条件
          <textarea aria-label="条件" name="condition" required />
        </label>
        <VerificationSelect />
        <label>
          增加依据
          <input aria-label="增加依据" name="reason" required />
        </label>
      </WorkbenchForm>
      <ChecklistHistory path={path} ticketId={ticket.id} projectId={base.split('/').at(-1)!} />
    </section>
  );
}
function ChecklistHistory({
  path,
  ticketId,
  projectId,
}: {
  path: string;
  ticketId: string;
  projectId: string;
}) {
  const [open, setOpen] = useState(false),
    query = useQuery({
      queryKey: ['checklist-history', projectId, ticketId],
      enabled: open,
      queryFn: () => request(path + '/checklist/revisions'),
    });
  return (
    <section>
      <button type="button" className={styles.textButton} onClick={() => setOpen(!open)}>
        {open ? '收起' : '查看'} Checklist 结果历史
      </button>
      {open && <QueryText query={query} />}
    </section>
  );
}
function QueryText({
  query,
}: {
  query: { isPending: boolean; isError: boolean; error: Error | null; data: unknown };
}) {
  if (query.isPending) return <p role="status">正在读取…</p>;
  if (query.isError)
    return (
      <p role="alert" className={styles.error}>
        {query.error?.message}
      </p>
    );
  return <pre className={styles.filePreview}>{JSON.stringify(query.data, null, 2)}</pre>;
}
function LogEntry({
  log,
  path,
  projectId,
  run,
}: {
  log: LogRecord;
  path: string;
  projectId: string;
  run: WorkbenchCommand;
}) {
  const [history, setHistory] = useState(false),
    query = useQuery({
      queryKey: ['log-history', projectId, log.ticketId, log.id],
      enabled: history,
      queryFn: () => request(path + `/logs/${log.id}/revisions`),
    });
  return (
    <article className={styles.recordRow}>
      <h4>
        {log.id} · {log.title} {log.archived ? '（已归档）' : ''}
      </h4>
      <p>
        {log.author.roleCode ?? '用户'} · {log.author.address ?? '本机用户入口'} ·{' '}
        {new Date(log.createdAt).toLocaleString()}
      </p>
      <p>
        {logTypeLabels[log.type]} · {importanceLabels[log.importance]}
        {log.corrects ? ' · 纠正 ' + log.corrects : ''}
      </p>
      <Markdown content={log.content} />
      {log.references.map((reference, n) => (
        <p key={n}>依据：{reference}</p>
      ))}
      {log.archiveReason && <p>归档原因：{log.archiveReason}</p>}
      <div className={styles.actions}>
        <WorkbenchForm
          title={`维护 Log ${log.id}`}
          trigger={`整理 ${log.id}`}
          description="分类、重要性和归档只改变查阅元数据。正文纠正请追加 Log，原作者和正文保留。"
          onSubmit={(form) =>
            run(
              path + `/logs/${log.id}`,
              {
                type: text(form, 'logType'),
                importance: text(form, 'importance'),
                archived: text(form, 'archived') === 'true',
                reason: text(form, 'reason'),
              },
              'PATCH',
            )
          }
        >
          <label>
            主类型
            <select aria-label="主类型" name="logType" defaultValue={log.type}>
              <option value="progress">进展</option>
              <option value="discovery">发现</option>
              <option value="judgment">判断</option>
              <option value="verification">验证</option>
              <option value="problem">问题</option>
              <option value="continuation">接续</option>
            </select>
          </label>
          <label>
            重要程度
            <select aria-label="重要程度" name="importance" defaultValue={log.importance}>
              <option value="normal">一般</option>
              <option value="important">重要</option>
              <option value="critical">关键</option>
            </select>
          </label>
          <label>
            查阅状态
            <select aria-label="查阅状态" name="archived" defaultValue={String(log.archived)}>
              <option value="false">有效参考</option>
              <option value="true">已归档</option>
            </select>
          </label>
          <label>
            整理原因
            <textarea aria-label="整理原因" name="reason" required />
          </label>
        </WorkbenchForm>
        <WorkbenchForm
          title={`追加纠正 ${log.id}`}
          trigger={`纠正 ${log.id}`}
          onSubmit={(form) => run(path + '/logs', logBody(form))}
        >
          <LogFields corrects={log.id} />
        </WorkbenchForm>
        <button type="button" className={styles.textButton} onClick={() => setHistory(!history)}>
          查看 {log.id} 历史
        </button>
      </div>
      {history && <QueryText query={query} />}
    </article>
  );
}
function Logs({
  path,
  projectId,
  run,
}: {
  path: string;
  projectId: string;
  run: WorkbenchCommand;
}) {
  const [mode, setMode] = useState('active'),
    query = useQuery({
      queryKey: ['ticket-logs', projectId, path, mode],
      queryFn: async () => z.array(logSchema).parse(await request(path + '/logs?mode=' + mode)),
    });
  return (
    <section>
      <div className={styles.actions}>
        <label>
          Log 查阅范围
          <select
            aria-label="Log 查阅范围"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="active">当前有效</option>
            <option value="archived">仅已归档</option>
            <option value="all">包含全部</option>
          </select>
        </label>
        <WorkbenchForm
          title="追加工作 Log"
          trigger="新增 Log"
          description="以当前用户保存过程与依据。Log 不是授权、正式决定或独审结论。"
          onSubmit={(form) => run(path + '/logs', logBody(form))}
        >
          <LogFields />
        </WorkbenchForm>
      </div>
      {query.isPending && <p role="status">正在读取 Log…</p>}
      {query.isError && (
        <p role="alert" className={styles.error}>
          {query.error.message}
        </p>
      )}
      {query.data?.length === 0 && <p>此范围暂无 Log。</p>}
      {query.data?.map((log) => (
        <LogEntry key={log.id} log={log} path={path} projectId={projectId} run={run} />
      ))}
    </section>
  );
}
function Materials({ path, projectId }: { path: string; projectId: string }) {
  const [directory, setDirectory] = useState(''),
    [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['ticket-materials', projectId, path, directory],
    queryFn: async () =>
      z
        .object({
          root: z.string(),
          entries: z.array(
            z.object({
              name: z.string(),
              path: z.string(),
              kind: z.enum(['directory', 'file', 'unavailable']),
              size: z.number().nullable(),
            }),
          ),
          note: z.string(),
          currentDelivery: z.null(),
          executionDomains: z.array(materialDomainSchema),
        })
        .parse(await request(path + '/materials?path=' + encodeURIComponent(directory))),
  });
  const preview = useQuery({
    queryKey: ['material-preview', projectId, path, selected],
    enabled: selected !== null,
    queryFn: async () =>
      z
        .object({ path: z.string(), content: z.string() })
        .parse(await request(path + '/material?path=' + encodeURIComponent(selected!))),
  });
  return (
    <section>
      <p className={styles.description}>
        材料根与实际执行域由软件分配。文件存在或名为“结果”不代表已送审或有效交付。
      </p>
      {query.isPending && <p role="status">正在读取材料…</p>}
      {query.isError && (
        <p role="alert" className={styles.error}>
          {query.error.message}
        </p>
      )}
      {query.data && (
        <>
          <p className={styles.materialPath}>{query.data.root}</p>
          <p>当前正式交付：尚未产生。</p>
          {query.data.executionDomains.length === 0 ? (
            <p>执行及独审域尚未分配。</p>
          ) : (
            query.data.executionDomains.map((domain) => (
              <p key={domain.id}>
                {domain.kind === 'review'
                  ? '独审'
                  : domain.kind === 'assistant'
                    ? '协作'
                    : '主执行'}{' '}
                · {domain.roleCode} · {domain.address} · {domain.relativePath}
                {domain.available ? '' : ' · ' + domain.error}
              </p>
            ))
          )}
          {directory && (
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setDirectory(directory.split('/').slice(0, -1).join('/'));
                setSelected(null);
              }}
            >
              返回上级
            </button>
          )}
          <ul className={styles.materialList}>
            {query.data.entries.map((entry) => (
              <li key={entry.path}>
                {entry.kind === 'directory' ? (
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => {
                      setDirectory(entry.path);
                      setSelected(null);
                    }}
                  >
                    {entry.name}/
                  </button>
                ) : entry.kind === 'unavailable' ? (
                  <span>{entry.name} · 链接不可用</span>
                ) : (
                  <>
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => setSelected(entry.path)}
                    >
                      {entry.name}
                    </button>
                    <span>{entry.size} 字节</span>
                    <a href={path + '/material?download=1&path=' + encodeURIComponent(entry.path)}>
                      下载 {entry.name}
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
          {query.data.entries.length === 0 && <p>暂无材料。系统没有用示例文件代替成果。</p>}
        </>
      )}
      {selected && (
        <section>
          <h4>{selected}</h4>
          {preview.isPending && <p role="status">正在预览…</p>}
          {preview.isError && (
            <p role="alert" className={styles.error}>
              {preview.error.message}
            </p>
          )}
          {preview.data && <pre className={styles.filePreview}>{preview.data.content}</pre>}
        </section>
      )}
    </section>
  );
}
function Revisions({ path, projectId }: { path: string; projectId: string }) {
  const query = useQuery({
    queryKey: ['ticket-revisions', projectId, path],
    queryFn: async () =>
      z
        .array(
          z.object({
            value: ticketSchema,
            author: authorSchema,
            reason: z.string(),
            at: z.string(),
          }),
        )
        .parse(await request(path + '/revisions')),
  });
  if (query.isPending) return <p role="status">正在读取修订…</p>;
  if (query.isError)
    return (
      <p role="alert" className={styles.error}>
        {query.error.message}
      </p>
    );
  return (
    <section>
      {query.data.map((revision, n) => (
        <article key={n} className={styles.recordRow}>
          <h4>
            修订 {revision.value.revision} · {revision.value.title}
          </h4>
          <p>
            {revision.reason} · {revision.author.roleCode ?? '用户'} ·{' '}
            {new Date(revision.at).toLocaleString()}
          </p>
          <dl className={styles.facts}>
            <dt>目标</dt>
            <dd>{revision.value.goal}</dd>
            <dt>包含</dt>
            <dd>{revision.value.included}</dd>
            <dt>不包含</dt>
            <dd>{revision.value.excluded || '未填写'}</dd>
          </dl>
          <details>
            <summary>当时的条件与结果</summary>
            {revision.value.checklist.map((item: ChecklistItem) => (
              <p key={item.id}>
                {item.id} {item.condition} · {item.checked ? '已勾' : '未勾'} · {item.result}
              </p>
            ))}
          </details>
        </article>
      ))}
    </section>
  );
}
export function TicketDetails({
  projectId,
  ticketId,
  data,
  run,
}: {
  projectId: string;
  ticketId: string;
  data: WorkbenchSnapshot;
  run: WorkbenchCommand;
}) {
  const [view, setView] = useState<
      'requirements' | 'checklist' | 'logs' | 'materials' | 'revisions' | 'execution' | 'acceptance'
    >('requirements'),
    base = `/api/projects/${projectId}`,
    path = base + `/tickets/${ticketId}`;
  const query = useQuery({
    queryKey: ['ticket', projectId, ticketId],
    queryFn: async () => ticketSchema.parse(await request(path)),
  });
  if (query.isPending) return <p role="status">正在读取票据…</p>;
  if (query.isError)
    return (
      <p role="alert" className={styles.error}>
        {query.error.message}
      </p>
    );
  const ticket = query.data;
  return (
    <section className={styles.ticketDetails} aria-label="票据详情">
      <div className={styles.sectionHeader}>
        <h3>
          {ticket.code} · {ticket.title}
        </h3>
        <span>{stateLabels[ticket.state]}</span>
      </div>
      <p className={styles.description}>
        要求修订 {ticket.revision} · 当前执行：{ticket.currentExecution ?? '尚未派工'}
      </p>
      <div className={styles.tabs} role="tablist" aria-label="票据视图">
        {(
          [
            ['requirements', '要求'],
            ['checklist', 'Checklist'],
            ['logs', 'Log'],
            ['materials', '材料'],
            ['execution', '执行观察'],
            ['acceptance', '审阅与验收'],
            ['revisions', '修订历史'],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'requirements' && (
        <>
          <EditTicket ticket={ticket} data={data} base={base} run={run} />
          <h4>主要结果</h4>
          <Markdown content={ticket.goal} />
          <h4>包含范围</h4>
          <Markdown content={ticket.included} />
          <h4>不包含</h4>
          <Markdown content={ticket.excluded || '未填写'} />
          <h4>直接依赖</h4>
          <p>
            {ticket.dependencies
              .map((id) => data.tickets.find((value) => value.id === id)?.code ?? id)
              .join('、') || '无'}
          </p>
          <div className={styles.actions}>
            <p>正式派工请通过 Chat 向主管提出；此处只读观察，不代替主管身份。</p>
            <button type="button" className={styles.button} onClick={() => setView('acceptance')}>
              查看审阅与验收
            </button>
          </div>
        </>
      )}
      {view === 'checklist' && <Checklist ticket={ticket} base={base} run={run} />}
      {view === 'acceptance' && <TicketAcceptance projectId={projectId} ticketId={ticket.id} />}
      {view === 'logs' && <Logs path={path} projectId={projectId} run={run} />}
      {view === 'materials' && <Materials path={path} projectId={projectId} />}
      {view === 'execution' && (
        <ExecutionObservation
          projectId={projectId}
          ticketId={ticket.id}
          executionId={ticket.currentExecution}
        />
      )}
      {view === 'revisions' && <Revisions path={path} projectId={projectId} />}
    </section>
  );
}
