import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { z } from 'zod';
import { sessionSchema } from '../src/contracts/sessions';
import type { SessionRecord } from '../src/contracts/sessions';
import { conversationSchema, savedMessageSchema } from '../src/contracts/chat';
import type { ChatMessage, SavedMessage } from '../src/contracts/chat';
import type { ProjectView } from '../src/contracts/project';
import { request } from './request';
import styles from './workbench.module.css';
import { useProjectUpdates } from './project-events';
import shell from './workspace-shell.module.css';
const historySchema = z.object({
  conversation: conversationSchema,
  messages: z.array(savedMessageSchema),
});
interface Draft {
  id: string;
  content: string;
  references: ChatMessage['references'];
  replyTo: string | null;
  attempted: boolean;
}
const drafts = new Map<string, Draft>();
const readingPositions = new Map<string, number>();
const pendingReplyTargets = new Map<string, string>();
const fresh = (): Draft => ({
  id: crypto.randomUUID(),
  content: '',
  references: [],
  replyTo: null,
  attempted: false,
});
function Receipt({ saved }: { saved: SavedMessage }) {
  const receipt = saved.receipt;
  const title =
    receipt.transport === 'ui-only'
      ? '回复已保存'
      : receipt.state === 'held'
        ? '已保存，暂未投递'
        : receipt.state === 'failed'
          ? '已保存，投递失败'
          : receipt.state === 'unknown'
            ? '已保存，投递结果待核对'
            : receipt.enteredAt
              ? '已进入模型请求'
              : receipt.durableAcceptedAt
                ? '宿主已持久接纳'
                : receipt.memoryAcceptedAt
                  ? '宿主已内存接纳'
                  : '已保存，待投递';
  return (
    <details className={styles.receipt}>
      <summary>{title}</summary>
      <dl className={styles.facts}>
        <dt>消息 ID</dt>
        <dd>{saved.message.id}</dd>
        <dt>内存接纳</dt>
        <dd>{receipt.memoryAcceptedAt ?? '未确认'}</dd>
        <dt>持久接纳</dt>
        <dd>{receipt.durableAcceptedAt ?? '未确认'}</dd>
        <dt>进入模型请求</dt>
        <dd>{receipt.enteredAt ?? '未确认'}</dd>
        <dt>请求记录</dt>
        <dd>{receipt.modelRequestId ?? '未关联'}</dd>
        <dt>业务办理</dt>
        <dd>{receipt.handledRecord ?? '未关联正式办理；对话回复不等于业务完成'}</dd>
      </dl>
      {receipt.error && <p className={styles.error}>{receipt.error}</p>}
    </details>
  );
}
function Message({
  saved,
  sessions,
  onReply,
  onRetry,
  onReference,
}: {
  saved: SavedMessage;
  sessions: SessionRecord[];
  onReply?: (id: string) => void;
  onRetry?: (id: string) => void;
  onReference: (id: string, index: number) => void;
}) {
  const message = saved.message;
  const session = sessions.find((session) => session.id === message.sender.sessionId);
  const content = message.content.replaceAll(
    '【MAT 已核验来源】',
    '[正文中的来源样式]【MAT 已核验来源】',
  );
  return (
    <article className={styles.chatMessage} data-message-id={message.id}>
      <header>
        <strong>
          {message.sender.kind === 'user'
            ? '用户'
            : message.sender.kind === 'system'
              ? 'MAT平台'
              : (session?.name ?? message.sender.roleCode)}
        </strong>
        {session && <span>{session.addresses.readable}</span>}
        <time dateTime={message.savedAt}>{new Date(message.savedAt).toLocaleString()}</time>
        {onReply && (
          <button type="button" className={styles.textButton} onClick={() => onReply(message.id)}>
            回复此消息
          </button>
        )}
      </header>
      {message.replyTo && <p className={styles.replyReference}>回复消息 {message.replyTo}</p>}
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
      {message.references.map((reference, index) => (
        <button
          type="button"
          className={styles.referenceButton}
          key={index}
          onClick={() => onReference(message.id, index)}
          aria-label={`预览引用 ${index + 1}`}
        >
          {reference.path}
          {reference.startLine
            ? `:${reference.startLine}${reference.endLine ? '-' + reference.endLine : ''}`
            : ''}
          {reference.snippet === undefined ? ' · 当前文件' : ' · 已选片段'}
        </button>
      ))}
      <Receipt saved={saved} />
      {onRetry &&
        message.sender.kind === 'user' &&
        saved.receipt.transport === 'mat-steer' &&
        ['held', 'failed', 'unknown'].includes(saved.receipt.state) && (
          <button type="button" className={styles.textButton} onClick={() => onRetry(message.id)}>
            重试这条消息投递
          </button>
        )}
    </article>
  );
}
function Composer({
  projectId,
  target,
  reply,
  onReplyConsumed,
  onSaved,
}: {
  projectId: string;
  target: string;
  reply: string | null;
  onReplyConsumed: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const key = projectId + ':' + target;
  const [draft, setDraft] = useState<Draft>(() => drafts.get(key) ?? fresh());
  const [referenceOpen, setReferenceOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (reply) inputRef.current?.focus();
  }, [reply]);
  const change = (next: Draft) => {
    drafts.set(key, next);
    setDraft(next);
  };
  const edit = (patch: Partial<Draft>) =>
    change({
      ...draft,
      ...patch,
      ...(draft.attempted ? { id: crypto.randomUUID(), attempted: false } : {}),
    });
  const mutation = useMutation({
    mutationFn: async (submitted: Draft) => {
      const saved = savedMessageSchema.parse(
        await request(`/api/projects/${projectId}/messages`, {
          id: submitted.id,
          target,
          content: submitted.content,
          references: submitted.references,
          ...(submitted.replyTo ? { replyTo: submitted.replyTo } : {}),
        }),
      );
      await onSaved();
      if (['failed', 'unknown', 'held'].includes(saved.receipt.state))
        throw new Error(saved.receipt.error ?? '消息已保存，投递尚未确认，请沿原消息重试');
      return saved;
    },
    onSuccess: () => change(fresh()),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const submitted = {
      ...draft,
      ...(draft.attempted && reply !== null && reply !== draft.replyTo
        ? { id: crypto.randomUUID() }
        : {}),
      replyTo: reply ?? draft.replyTo,
      attempted: true,
    };
    change(submitted);
    onReplyConsumed();
    mutation.mutate(submitted);
  }
  function addReference(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget),
      start = String(data.get('startLine') ?? ''),
      end = String(data.get('endLine') ?? '');
    edit({
      references: [
        ...draft.references,
        {
          kind: 'file',
          path: String(data.get('path')),
          ...(start ? { startLine: Number(start) } : {}),
          ...(end ? { endLine: Number(end) } : {}),
        },
      ],
    });
    setReferenceOpen(false);
  }
  return (
    <>
      <form className={styles.composer} onSubmit={submit}>
        {(reply ?? draft.replyTo) && (
          <p>
            回复 {reply ?? draft.replyTo}{' '}
            <button
              type="button"
              className={styles.textButton}
              onClick={() => {
                edit({ replyTo: null });
                onReplyConsumed();
              }}
            >
              取消回复
            </button>
          </p>
        )}
        <label>
          消息正文
          <textarea
            ref={inputRef}
            aria-label="消息正文"
            name="content"
            value={draft.content}
            onChange={(event) => edit({ content: event.target.value })}
            disabled={mutation.isPending}
            placeholder="写下本轮交流内容，支持 Markdown"
            required
          />
        </label>
        {draft.references.map((reference, index) => (
          <div className={styles.draftReference} key={index}>
            <span>{reference.path}</span>
            <button
              type="button"
              className={styles.textButton}
              disabled={mutation.isPending}
              onClick={() =>
                edit({ references: draft.references.filter((_, position) => position !== index) })
              }
            >
              移除引用
            </button>
          </div>
        ))}
        {draft.attempted && (
          <p className={styles.description}>重试保持原消息身份；编辑内容会形成新消息。</p>
        )}
        {mutation.isError && (
          <p role="alert" className={styles.error}>
            {mutation.error.message}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={mutation.isPending}
            onClick={() => setReferenceOpen(true)}
          >
            ＋ 引用文件
          </button>
          <button
            type="submit"
            className={styles.primary}
            disabled={mutation.isPending || !draft.content.trim()}
          >
            {mutation.isPending ? '正在发送…' : draft.attempted ? '重试原消息' : '发送'}
          </button>
        </div>
        <p className={styles.description}>交流不代替派工、批准或验收。发送失败会保留草稿。</p>
      </form>
      <Dialog.Root open={referenceOpen} onOpenChange={setReferenceOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content className={styles.dialog}>
            <Dialog.Title className={styles.dialogTitle}>引用项目文件</Dialog.Title>
            <Dialog.Description className={styles.description}>
              填写本机准确路径与可选行范围。引用不会扩大可读范围，点击发送后才写入消息。
            </Dialog.Description>
            <form className={styles.form} onSubmit={addReference}>
              <label>
                文件绝对路径
                <input name="path" required autoComplete="off" />
              </label>
              <div className={styles.columns}>
                <label>
                  开始行（可选）
                  <input type="number" name="startLine" min={1} />
                </label>
                <label>
                  结束行（可选）
                  <input type="number" name="endLine" min={1} />
                </label>
              </div>
              <div className={styles.actions}>
                <Dialog.Close className={styles.button} type="button">
                  取消
                </Dialog.Close>
                <button className={styles.primary} type="submit">
                  添加到草稿
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
export function ChatPanel({
  project,
  mode,
  managerSessionId,
  initialSessionId,
}: {
  project: ProjectView;
  mode: 'supervisor' | 'private';
  managerSessionId: string | null;
  initialSessionId: string | null;
}) {
  const path = `/api/projects/${project.id}`,
    client = useQueryClient(),
    updates = useProjectUpdates(project.id);
  const [category, setCategory] = useState<'user' | 'members'>('user');
  const [privateSelection, setSelected] = useState<
    { kind: 'user'; sessionId: string } | { kind: 'members'; conversationId: string } | null
  >(initialSessionId ? { kind: 'user', sessionId: initialSessionId } : null);
  const selected =
    mode === 'supervisor'
      ? managerSessionId
        ? { kind: 'user' as const, sessionId: managerSessionId }
        : null
      : privateSelection;
  const [activeReply, setActiveReply] = useState<{ key: string; id: string | null } | null>(null);
  const [reference, setReference] = useState<{ id: string; index: number } | null>(null);
  const historyPane = useRef<HTMLDivElement | null>(null);
  const sessions = useQuery({
    queryKey: ['sessions', project.id],
    queryFn: async () => z.array(sessionSchema).parse(await request(path + '/sessions')),
  });
  const conversations = useQuery({
    queryKey: ['conversations', project.id],
    queryFn: async () => z.array(conversationSchema).parse(await request(path + '/conversations')),
  });
  const conversation =
    selected?.kind === 'members'
      ? conversations.data?.find((item) => item.id === selected.conversationId)
      : selected?.kind === 'user'
        ? conversations.data?.find(
            (item) =>
              item.participants.includes('user') && item.participants.includes(selected.sessionId),
          )
        : undefined;
  const history = useQuery({
    queryKey: ['chat-history', project.id, conversation?.id],
    enabled: !!conversation,
    queryFn: async () =>
      historySchema.parse(await request(path + '/conversations/' + conversation!.id)),
  });
  const readingKey = selected
    ? `${project.id}:${selected.kind === 'user' ? selected.sessionId : selected.conversationId}`
    : null;
  const reply =
    readingKey && selected?.kind === 'user'
      ? activeReply?.key === readingKey
        ? activeReply.id
        : (pendingReplyTargets.get(readingKey) ?? null)
      : null;
  const setReply = (id: string | null) => {
    if (!readingKey || selected?.kind !== 'user') return;
    if (id) pendingReplyTargets.set(readingKey, id);
    else pendingReplyTargets.delete(readingKey);
    setActiveReply({ key: readingKey, id });
  };
  const hasHistory = !!history.data;
  useLayoutEffect(() => {
    const pane = historyPane.current;
    if (pane && readingKey && hasHistory)
      pane.scrollTop = readingPositions.get(readingKey) ?? pane.scrollHeight;
  }, [readingKey, hasHistory]);
  const preview = useQuery({
    queryKey: ['chat-reference', project.id, reference?.id, reference?.index],
    enabled: reference !== null,
    queryFn: async () =>
      z
        .object({
          path: z.string(),
          content: z.string(),
          source: z.enum(['current-file', 'saved-snippet']),
        })
        .parse(await request(path + `/messages/${reference!.id}/references/${reference!.index}`)),
  });
  const refresh = () =>
    client.invalidateQueries({ predicate: (query) => query.queryKey.includes(project.id) });
  const retry = useMutation({
    mutationFn: async (id: string) => {
      const saved = savedMessageSchema.parse(await request(path + `/messages/${id}/retry`, {}));
      await refresh();
      if (['held', 'failed', 'unknown'].includes(saved.receipt.state))
        throw new Error(saved.receipt.error ?? '原消息仍未确认投递，未创建新消息');
      return saved;
    },
  });
  const target =
    selected?.kind === 'user'
      ? sessions.data?.find((session) => session.id === selected.sessionId)
      : undefined;
  const canSend =
    target?.status === 'bound' &&
    !['terminated', 'archived'].includes(target.communicationState) &&
    target.communicationOrigin?.kind !== 'execution-closed';
  const humanSessions =
    sessions.data?.filter(
      (session) =>
        session.status === 'bound' ||
        conversations.data?.some(
          (item) => item.participants.includes('user') && item.participants.includes(session.id),
        ),
    ) ?? [];
  const members = conversations.data?.filter((item) => !item.participants.includes('user')) ?? [];
  return (
    <section className={`${styles.chatSection} ${shell.chatSurface}`}>
      <div className={styles.sectionHeader}>
        <h2>{mode === 'supervisor' ? '主管默认会话' : '私聊联系人与消息'}</h2>
        <button type="button" className={styles.button} onClick={() => void refresh()}>
          刷新消息
        </button>
      </div>
      <p className={styles.description}>{updates}</p>
      {[sessions.error, conversations.error].filter(Boolean).map((error, index) => (
        <p className={styles.error} role="alert" key={index}>
          {error!.message}
        </p>
      ))}
      {mode === 'supervisor' && (
        <p className={styles.description}>从这里和当前项目主管交流。专注会话及定向信道未接入。</p>
      )}
      <div className={mode === 'supervisor' ? shell.supervisorChat : styles.chatLayout}>
        {mode === 'private' && (
          <nav className={styles.chatNav} aria-label="私聊联系人">
            <div className={styles.tabs}>
              <button
                type="button"
                aria-pressed={category === 'user'}
                onClick={() => {
                  setCategory('user');
                  setSelected(null);
                }}
              >
                我的私聊
              </button>
              <button
                type="button"
                aria-pressed={category === 'members'}
                onClick={() => {
                  setCategory('members');
                  setSelected(null);
                }}
              >
                成员间（只读）
              </button>
            </div>
            {category === 'user'
              ? humanSessions.map((session) => (
                  <button
                    type="button"
                    key={session.id}
                    className={styles.contact}
                    aria-pressed={selected?.kind === 'user' && selected.sessionId === session.id}
                    onClick={() => {
                      setSelected({ kind: 'user', sessionId: session.id });
                    }}
                  >
                    <strong>{session.name}</strong>
                    <span>{session.addresses.readable}</span>
                    <span>
                      {session.status !== 'bound'
                        ? '历史，只读'
                        : session.communicationState === 'paused'
                          ? session.communicationOrigin?.kind === 'execution-closed'
                            ? '已收尾，只读'
                            : '暂停，仅保存消息'
                          : session.communicationState === 'terminated' ||
                              session.communicationState === 'archived'
                            ? '已停止，只读'
                            : '可交流'}
                    </span>
                  </button>
                ))
              : members.map((item) => (
                  <button
                    type="button"
                    className={styles.contact}
                    key={item.id}
                    aria-pressed={
                      selected?.kind === 'members' && selected.conversationId === item.id
                    }
                    onClick={() => {
                      setSelected({ kind: 'members', conversationId: item.id });
                    }}
                  >
                    {item.participants
                      .map(
                        (id) =>
                          sessions.data?.find((session) => session.id === id)?.addresses.readable ??
                          (id === 'mat-platform' ? 'MAT平台' : id),
                      )
                      .join(' ↔ ')}
                  </button>
                ))}
            {category === 'user' && humanSessions.length === 0 && <p>还没有可显示的私聊会话。</p>}
            {category === 'members' && members.length === 0 && <p>暂无成员间私聊。</p>}
          </nav>
        )}
        <div className={styles.chatConversation}>
          {!selected ? (
            <p className={styles.description}>
              {mode === 'supervisor'
                ? '暂未取得项目主管默认会话。可在配置中核对项目运行状态。'
                : '选择一个明确会话查看或交流。同一角色的多个会话分别列出。'}
            </p>
          ) : (
            <>
              <h4>{target?.name ?? '成员间私聊（只读）'}</h4>
              {target && (
                <p className={styles.description}>
                  {target.addresses.readable} · {target.addresses.numeric}
                </p>
              )}
              {target?.error && (
                <p className={styles.error} role="alert">
                  会话运行异常：{target.error}
                </p>
              )}
              {history.isFetching && <p role="status">正在更新消息…</p>}
              {history.isError && (
                <p role="alert" className={styles.error}>
                  {history.error.message}
                </p>
              )}
              {retry.isError && (
                <p role="alert" className={styles.error}>
                  {retry.error.message}
                </p>
              )}
              <div
                className={styles.chatHistory}
                aria-label="私聊消息"
                ref={historyPane}
                onScroll={(event) => {
                  if (readingKey) readingPositions.set(readingKey, event.currentTarget.scrollTop);
                }}
              >
                {history.data?.messages.map((saved) => (
                  <Message
                    key={saved.message.id}
                    saved={saved}
                    sessions={sessions.data ?? []}
                    {...(selected.kind === 'user' && canSend
                      ? { onReply: (id: string) => setReply(id) }
                      : {})}
                    onReference={(id, index) => setReference({ id, index })}
                    {...(selected.kind === 'user' && canSend
                      ? { onRetry: (id: string) => retry.mutate(id) }
                      : {})}
                  />
                ))}
                {!history.data?.messages.length &&
                  !history.isFetching &&
                  !history.isError &&
                  !conversations.isPending &&
                  !conversations.isError && (
                    <p className={styles.description}>尚无消息。点击发送后才保存和投递。</p>
                  )}
              </div>
              {selected.kind === 'user' && canSend ? (
                <Composer
                  key={project.id + ':' + selected.sessionId}
                  projectId={project.id}
                  target={selected.sessionId}
                  reply={reply}
                  onReplyConsumed={() => setReply(null)}
                  onSaved={refresh}
                />
              ) : (
                <p className={styles.description}>此对话为只读，不能插话或借历史回复恢复旧执行。</p>
              )}
            </>
          )}
        </div>
      </div>
      <Dialog.Root
        open={reference !== null}
        onOpenChange={(open) => {
          if (!open) setReference(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content className={styles.configDialog}>
            <Dialog.Title className={styles.dialogTitle}>文件引用预览</Dialog.Title>
            <Dialog.Description className={styles.description}>
              {preview.data?.path ?? '核对文件可读范围后显示内容。'}
            </Dialog.Description>
            {preview.isPending && <p role="status">正在读取文件…</p>}
            {preview.isError && (
              <p role="alert" className={styles.error}>
                {preview.error.message}
              </p>
            )}
            {preview.data && (
              <>
                <p>
                  {preview.data.source === 'saved-snippet'
                    ? '发送时选定的片段'
                    : '当前文件内容，不是发送时快照'}
                </p>
                <pre className={styles.filePreview}>{preview.data.content}</pre>
              </>
            )}
            <div className={styles.actions}>
              <Dialog.Close className={styles.primary}>关闭预览</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
