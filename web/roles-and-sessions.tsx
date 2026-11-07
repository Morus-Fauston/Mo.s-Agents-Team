import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { z } from 'zod';
import { registeredRoleSchema } from '../src/contracts/roles';
import type { RegisteredRole, WorkflowType } from '../src/contracts/roles';
import { sessionSchema } from '../src/contracts/sessions';
import { assistantSchema } from '../src/contracts/collaboration';
import { executionSchema } from '../src/contracts/execution';
import type { ProjectView } from '../src/contracts/project';
import { executionConfigurationSchema } from '../src/contracts/project';
import { request } from './request';
import styles from './workbench.module.css';
import shell from './workspace-shell.module.css';
import {
  modelStateSchema,
  modelChangeSchema,
  fallbackPolicySchema,
} from '../src/contracts/model-policy';
import { WorkbenchForm, useWorkbenchCommand, text } from './workbench-form';
const typeNames: Record<WorkflowType, string> = {
  supervisor: '主管',
  developer: '开发',
  investigator: '调查',
  reviewer: '审阅',
  committer: '提交',
};
function MutationDialog({
  title,
  description,
  fields,
  save,
  afterSave,
  primary = false,
}: {
  title: string;
  description: string;
  fields: ReactNode;
  save: (data: FormData) => Promise<unknown>;
  afterSave: () => Promise<unknown>;
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: async () => {
      await afterSave();
      setOpen(false);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate(new FormData(event.currentTarget));
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!mutation.isPending) {
          setOpen(value);
          mutation.reset();
        }
      }}
    >
      <Dialog.Trigger className={primary ? styles.primary : styles.button}>{title}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.dialogTitle}>{title}</Dialog.Title>
          <Dialog.Description className={styles.description}>{description}</Dialog.Description>
          <form className={styles.form} onSubmit={submit}>
            {fields}
            {mutation.isError && (
              <p role="alert" className={styles.error}>
                {mutation.error.message}
              </p>
            )}
            <div className={styles.actions}>
              <Dialog.Close className={styles.button} type="button" disabled={mutation.isPending}>
                取消
              </Dialog.Close>
              <button type="submit" className={styles.primary} disabled={mutation.isPending}>
                {mutation.isPending ? '正在保存…' : '确认保存'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function ConfigurationFields({ role }: { role?: RegisteredRole }) {
  return (
    <>
      <div className={styles.columns}>
        <label>
          Provider
          <input
            name="provider"
            required
            autoComplete="off"
            defaultValue={role?.configuration.provider}
          />
        </label>
        <label>
          模型
          <input
            name="model"
            required
            autoComplete="off"
            defaultValue={role?.configuration.model}
          />
        </label>
      </div>
      <label>
        思考强度（可选）
        <input
          name="reasoningEffort"
          autoComplete="off"
          defaultValue={role?.configuration.reasoningEffort}
        />
      </label>
    </>
  );
}
function configuration(data: FormData) {
  const reasoningEffort = String(data.get('reasoningEffort') ?? '');
  return {
    provider: String(data.get('provider') ?? ''),
    model: String(data.get('model') ?? ''),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}
function FallbackFields({ role }: { role?: RegisteredRole }) {
  return (
    <fieldset className={styles.fieldset}>
      <legend>单一备用</legend>
      <label>
        <input
          name="fallbackEnabled"
          type="checkbox"
          defaultChecked={role?.fallback.enabled ?? false}
        />
        模型失败时只尝试下列备用
      </label>
      <label>
        备用 Provider
        <input
          name="fallbackProvider"
          defaultValue={role?.fallback.configuration?.provider ?? ''}
        />
      </label>
      <label>
        备用模型
        <input name="fallbackModel" defaultValue={role?.fallback.configuration?.model ?? ''} />
      </label>
      <label>
        备用思考强度（可选）
        <input
          name="fallbackEffort"
          defaultValue={role?.fallback.configuration?.reasoningEffort ?? ''}
        />
      </label>
      <p>未开启时保留原模型失败。新默认只用于后建会话，已有会话保留策略快照。</p>
    </fieldset>
  );
}
function fallback(data: FormData) {
  const provider = text(data, 'fallbackProvider').trim(),
    model = text(data, 'fallbackModel').trim(),
    reasoningEffort = text(data, 'fallbackEffort').trim();
  return {
    enabled: data.get('fallbackEnabled') === 'on',
    configuration:
      provider || model
        ? { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
        : null,
  };
}
export function RoleAndSessionPanel({
  project,
  mode,
  openChat,
}: {
  project: ProjectView;
  mode: 'members' | 'settings';
  openChat?: (id: string) => void;
}) {
  const path = `/api/projects/${project.id}`;
  const client = useQueryClient();
  const run = useWorkbenchCommand(project.id);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const roles = useQuery({
    queryKey: ['roles', project.id],
    queryFn: async () => z.array(registeredRoleSchema).parse(await request(path + '/roles')),
  });
  const sessions = useQuery({
    queryKey: ['sessions-with-collaboration', project.id],
    enabled: mode === 'members',
    queryFn: async () =>
      z
        .array(sessionSchema.extend({ collaboration: assistantSchema.nullable().optional() }))
        .parse(await request(path + '/sessions')),
  });
  const settings = useQuery({
    queryKey: ['settings', project.id],
    enabled: mode === 'settings',
    queryFn: async () =>
      z.object({ skillSourceRoot: z.string().nullable() }).parse(await request(path + '/settings')),
  });
  const runtime = useQuery({
    queryKey: ['runtime'],
    enabled: mode === 'members',
    queryFn: async () =>
      z
        .object({ available: z.boolean(), message: z.string() })
        .parse(await request('/api/runtime')),
  });
  const executions = useQuery({
    queryKey: ['overview-executions', project.id],
    enabled: mode === 'members',
    queryFn: async () => z.array(executionSchema).parse(await request(path + '/executions')),
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['roles', project.id] }),
      client.invalidateQueries({ queryKey: ['sessions', project.id] }),
      client.invalidateQueries({ queryKey: ['sessions-with-collaboration', project.id] }),
      client.invalidateQueries({ queryKey: ['projects'] }),
    ]);
  };
  const [selected, setSelected] = useState<string | null>(null);
  const actual = useQuery({
    queryKey: ['session-configuration', project.id, selected],
    enabled: selected !== null,
    queryFn: async () =>
      z
        .object({
          session: sessionSchema,
          defaultConfiguration: executionConfigurationSchema,
          requestedConfiguration: executionConfigurationSchema,
          nativeSelection: executionConfigurationSchema.nullable(),
          modelState: modelStateSchema,
          modelChanges: z.array(modelChangeSchema),
          defaultFallback: fallbackPolicySchema,
          actualPreset: z.string().nullable(),
          registeredTools: z.array(z.string()).nullable(),
          nativeLoaded: z.boolean(),
          requests: z.array(
            z.object({
              id: z.string(),
              step: z.number(),
              turn: z.number(),
              contextVersion: z.string(),
              requestConfiguration: z.record(z.string(), z.unknown()),
              tools: z.array(z.string()),
              skillManifestVersion: z.string(),
              skillCatalogVersion: z.string(),
              loadedSkills: z.array(
                z.object({ name: z.string(), path: z.string(), sha256: z.string() }),
              ),
              reportedModel: z.string().nullable(),
              usage: z.record(z.string(), z.number()).nullable(),
              status: z.string(),
              error: z.string().nullable(),
              sources: z.array(
                z.object({
                  path: z.string(),
                  sha256: z.string(),
                  bytes: z.number(),
                  modifiedAt: z.string(),
                }),
              ),
            }),
          ),
        })
        .parse(await request(path + `/sessions/${selected}/configuration`)),
  });
  const sessionRows = (roleId: string) => {
    const list = sessions.data?.filter((session) => session.roleId === roleId) ?? [];
    const ended = (session: (typeof list)[number]) => {
      const last = executions.data?.findLast((record) => record.sessionId === session.id);
      return (
        session.status === 'closed' ||
        ['terminated', 'archived'].includes(session.communicationState) ||
        !!session.communicationOrigin ||
        (!!last && ['terminated', 'closed'].includes(last.lifecycleState) && !session.collaboration)
      );
    };
    const render = (session: (typeof list)[number]) => {
      const last = executions.data?.findLast((record) => record.sessionId === session.id),
        historical = ended(session);
      const state = session.error
        ? '运行异常'
        : historical
          ? '已结束'
          : session.communicationState === 'paused'
            ? '暂停'
            : last?.lifecycleState === 'waiting'
              ? '等待'
              : last?.lifecycleState === 'active' && last.goalId
                ? '在途执行'
                : session.status === 'bound'
                  ? '已绑定'
                  : '绑定待确认';
      return (
        <li key={session.id} className={shell.sessionCard}>
          <div className={shell.sessionIdentity}>
            <strong>{session.name}</strong>
            <span>
              {session.addresses.readable} · {state}
            </span>
          </div>
          <p>
            {last?.ticketCode ? `${last.ticketCode} · ` : ''}
            {session.collaboration ? '本票辅助 · ' : ''}
            {session.purpose}
          </p>
          <p>
            建立配置：{session.configuration.provider} / {session.configuration.model}
            {session.configuration.reasoningEffort
              ? ` · ${session.configuration.reasoningEffort}`
              : ''}
          </p>
          {session.error && (
            <p role="alert" className={styles.error}>
              {session.error}
            </p>
          )}
          <div className={shell.sessionActions}>
            <button type="button" className={styles.button} onClick={() => setSelected(session.id)}>
              查看生效配置
            </button>
            {openChat && session.status === 'bound' && !historical && (
              <button type="button" className={styles.button} onClick={() => openChat(session.id)}>
                打开私聊
              </button>
            )}
          </div>
        </li>
      );
    };
    const current = list.filter((session) => !ended(session)),
      prior = list.filter(ended);
    return (
      <>
        {current.length ? (
          <ul className={shell.sessionCards}>{current.map(render)}</ul>
        ) : (
          <p className={shell.empty}>暂无在列会话。</p>
        )}
        {!!prior.length && (
          <details className={shell.sessionHistory}>
            <summary>历史会话 · {prior.length}</summary>
            <ul className={shell.sessionCards}>{prior.map(render)}</ul>
          </details>
        )}
      </>
    );
  };
  return (
    <>
      <div className={styles.sectionHeader}>
        <h2>{mode === 'settings' ? '已登记角色' : '角色与工作会话'}</h2>
        {mode === 'members' && (
          <button type="button" className={styles.button} onClick={() => void refresh()}>
            刷新成员
          </button>
        )}
        {mode === 'settings' && (
          <MutationDialog
            title="登记角色"
            primary
            description="登记长期角色并准备规范文件；正文可以为空。新建会话使用已登记身份。"
            afterSave={refresh}
            save={(data) =>
              request(path + '/roles', {
                code: String(data.get('code')),
                name: String(data.get('name')),
                type: String(data.get('type')),
                configuration: configuration(data),
                fallback: fallback(data),
              })
            }
            fields={
              <>
                <label>
                  角色标识
                  <input
                    name="code"
                    required
                    pattern={'[A-Z][A-Z0-9\\-]*'}
                    placeholder="DEV-CORE"
                    maxLength={64}
                  />
                </label>
                <label>
                  角色名称
                  <input name="name" required maxLength={160} />
                </label>
                <label>
                  工作流类型
                  <select name="type" aria-label="工作流类型" defaultValue="developer">
                    {(['developer', 'investigator', 'reviewer', 'committer'] as const).map(
                      (type) => (
                        <option value={type} key={type}>
                          {typeNames[type]}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <ConfigurationFields />
                <FallbackFields />
              </>
            }
          />
        )}
      </div>
      {roles.isPending && <p role="status">正在读取角色…</p>}
      {roles.isError && (
        <p role="alert" className={styles.error}>
          {roles.error.message}
        </p>
      )}
      {mode === 'members' && (
        <>
          <p className={styles.description}>{runtime.data?.message ?? '正在核对宿主连接…'}</p>
          {sessions.isPending && <p role="status">正在读取工作会话…</p>}
          {(runtime.error || sessions.error || executions.error) && (
            <p role="alert" className={styles.error}>
              {(runtime.error ?? sessions.error ?? executions.error)?.message}
            </p>
          )}
        </>
      )}
      {mode === 'members' ? (
        <div className={shell.memberGroups}>
          {(Object.keys(typeNames) as WorkflowType[]).map((type) => {
            const group = roles.data?.filter((role) => role.type === type) ?? [];
            return group.length ? (
              <section className={shell.surface} key={type} aria-label={typeNames[type]}>
                <h2>{typeNames[type]}</h2>
                <div className={shell.roleGrid}>
                  {group.map((role) => (
                    <article className={shell.memberCard} key={role.id}>
                      <h3>{role.name}</h3>
                      <p>
                        {role.code} · 默认配置：{role.configuration.provider} /{' '}
                        {role.configuration.model}
                        {role.configuration.reasoningEffort
                          ? ` · ${role.configuration.reasoningEffort}`
                          : ''}
                      </p>
                      {sessionRows(role.id)}
                    </article>
                  ))}
                </div>
              </section>
            ) : null;
          })}
        </div>
      ) : (
        <>
          <div className={styles.roleList}>
            {roles.data?.map((role) => (
              <article className={styles.role} key={role.id}>
                <div>
                  <strong>
                    {role.name} · {typeNames[role.type]}
                  </strong>
                  <span>
                    {role.code} · {role.id}
                  </span>
                </div>
                <p>
                  {role.configuration.provider} / {role.configuration.model}
                  {role.configuration.reasoningEffort
                    ? ` · ${role.configuration.reasoningEffort}`
                    : ''}
                </p>
                <p>
                  {role.fallback.enabled
                    ? `单一备用：${role.fallback.configuration?.provider} / ${role.fallback.configuration?.model}`
                    : '备用未启用'}
                </p>
                <dl className={styles.facts}>
                  <dt>身份资料</dt>
                  <dd>{role.paths.soul}</dd>
                  <dt>工作准则</dt>
                  <dd>{role.paths.agent}</dd>
                </dl>
                <div className={styles.actions}>
                  <MutationDialog
                    title={`修改 ${role.code} 默认配置`}
                    description="修改角色名称和新会话默认执行配置；已有会话保持创建时配置。"
                    afterSave={refresh}
                    save={(data) =>
                      request(
                        path + `/roles/${role.id}`,
                        {
                          name: String(data.get('name')),
                          configuration: configuration(data),
                          fallback: fallback(data),
                        },
                        'PATCH',
                      )
                    }
                    fields={
                      <>
                        <label>
                          角色名称
                          <input name="name" required defaultValue={role.name} />
                        </label>
                        <ConfigurationFields role={role} />
                        <FallbackFields role={role} />
                      </>
                    }
                  />
                  <MutationDialog
                    title={`为 ${role.code} 创建会话`}
                    description={`使用 ${role.configuration.provider} / ${role.configuration.model} 的配置快照准备会话。创建后仍未开工，不附首条消息。`}
                    afterSave={refresh}
                    save={(data) =>
                      request(path + '/sessions', {
                        roleId: role.id,
                        name: String(data.get('name')),
                        purpose: String(data.get('purpose')),
                        cwd: String(data.get('cwd')),
                      })
                    }
                    fields={
                      <>
                        <label>
                          会话名称
                          <input name="name" required maxLength={160} />
                        </label>
                        <label>
                          本次用途
                          <textarea name="purpose" required maxLength={2000} />
                        </label>
                        <label>
                          工作目录
                          <input name="cwd" required defaultValue={project.root} />
                        </label>
                      </>
                    }
                  />
                </div>
              </article>
            ))}
          </div>
          <details className={styles.settings}>
            <summary>Skill 来源配置</summary>
            <p>填写 Mo.s-skill 的真实本地目录。新会话按 For MAT 清单发现方法，正文按需加载。</p>
            {settings.isError && (
              <p role="alert" className={styles.error}>
                {settings.error.message}
              </p>
            )}
            {settings.data && (
              <MutationDialog
                title="设置 Skill 来源"
                description="验证五类清单的真实来源后保存；新来源目录只用于新建会话。"
                afterSave={async () =>
                  client.invalidateQueries({ queryKey: ['settings', project.id] })
                }
                save={(data) =>
                  request(
                    path + '/settings',
                    { skillSourceRoot: String(data.get('skillSourceRoot')) },
                    'PUT',
                  )
                }
                fields={
                  <label>
                    来源根目录
                    <input
                      name="skillSourceRoot"
                      required
                      defaultValue={settings.data.skillSourceRoot ?? ''}
                      placeholder="D:\Git\Mo.s-skill"
                    />
                  </label>
                }
              />
            )}
            <p className={styles.path}>{settings.data?.skillSourceRoot ?? '尚未设置来源'}</p>
          </details>
        </>
      )}
      <Dialog.Root
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content className={styles.configDialog}>
            <Dialog.Title className={styles.dialogTitle}>会话配置与实际请求</Dialog.Title>
            <Dialog.Description className={styles.description}>
              默认值、创建快照和真实请求分别记录。查询不唤醒会话；缺失 usage 显示为未提供。
            </Dialog.Description>
            {actual.isPending && <p role="status">正在读取配置…</p>}
            {actual.isError && (
              <p role="alert" className={styles.error}>
                {actual.error.message}
              </p>
            )}
            {actual.data && (
              <>
                <dl className={styles.facts}>
                  <dt>角色当前默认</dt>
                  <dd>{JSON.stringify(actual.data.defaultConfiguration)}</dd>
                  <dt>会话配置快照</dt>
                  <dd>{JSON.stringify(actual.data.requestedConfiguration)}</dd>
                  <dt>此会话备用快照</dt>
                  <dd>{JSON.stringify(actual.data.modelState.policy)}</dd>
                  <dt>当前已核定配置</dt>
                  <dd>
                    {JSON.stringify(actual.data.modelState.current)} · 来源{' '}
                    {
                      (
                        { initial: '创建快照', user: '用户明确切换', fallback: '单一备用' } as const
                      )[actual.data.modelState.source]
                    }
                  </dd>
                  <dt>原生当前选择</dt>
                  <dd>
                    {actual.data.nativeSelection
                      ? JSON.stringify(actual.data.nativeSelection)
                      : '未加载或无法取得；不推定生效'}
                  </dd>
                  <dt>备用进展</dt>
                  <dd>
                    {
                      (
                        {
                          unused: '尚未尝试',
                          attempting: '选择待核对',
                          selected: '原生选择已持久确认，调用结果另看请求',
                          failed: '指定备用后的工作异常，未尝试其他模型',
                          unknown: '结果未知，未确认成功',
                        } as const
                      )[actual.data.modelState.fallbackState]
                    }
                  </dd>
                  <dt>原生会话</dt>
                  <dd>{actual.data.session.nativeSessionId ?? '未绑定'}</dd>
                  <dt>当前实际预设</dt>
                  <dd>{actual.data.actualPreset ?? '当前进程未加载；不推定已生效'}</dd>
                  <dt>已登记工具</dt>
                  <dd>{actual.data.registeredTools?.join('、') ?? '当前进程未加载'}</dd>
                </dl>
                <WorkbenchForm
                  title="明确切换此会话配置"
                  trigger="明确切换此会话配置"
                  description="仅此会话；在原生空闲且Goal已解除武装时办理。不会改角色默认、重做旧工具或恢复暂停；选择持久确认也不代表模型调用成功。"
                  onSubmit={(data) =>
                    run(path + `/sessions/${selected}/configuration`, {
                      expectedRevision: actual.data!.modelState.revision,
                      configuration: configuration(data),
                      reason: text(data, 'reason'),
                    })
                  }
                >
                  <ConfigurationFields />
                  <label>
                    切换原因
                    <textarea name="reason" required />
                  </label>
                </WorkbenchForm>
                {switchError && <p role="alert">{switchError}</p>}
                <section aria-label="模型切换留痕">
                  <h4>模型切换留痕</h4>
                  {actual.data.modelChanges.length === 0 ? (
                    <p>尚无配置切换。</p>
                  ) : (
                    actual.data.modelChanges.map((change) => (
                      <article key={change.id}>
                        <p>
                          {change.source === 'fallback' ? '指定单一备用' : '用户明确切换'} ·{' '}
                          {
                            (
                              {
                                reserved: '待原生核对',
                                confirmed: '原生选择已持久确认',
                                failed: '办理失败',
                                unknown: '结果未知',
                              } as const
                            )[change.status]
                          }
                        </p>
                        <p>
                          {JSON.stringify(change.previous)} → {JSON.stringify(change.configuration)}
                        </p>
                        <p>{change.reason}</p>
                        {change.error && <p role="alert">{change.error}</p>}
                        {['reserved', 'unknown'].includes(change.status) && (
                          <button
                            type="button"
                            className={styles.button}
                            onClick={() =>
                              void (async () => {
                                setSwitchError(null);
                                try {
                                  await run(
                                    path +
                                      `/sessions/${selected}/configuration/${change.id}/reconcile`,
                                    {},
                                  );
                                } catch (error) {
                                  setSwitchError(
                                    error instanceof Error
                                      ? error.message
                                      : '补核失败，原结果仍未知',
                                  );
                                  await actual.refetch();
                                }
                              })()
                            }
                          >
                            补核原选择
                          </button>
                        )}
                      </article>
                    ))
                  )}
                </section>
                {actual.data.requests.length === 0 && (
                  <p>尚无实际模型请求。已保存配置不代表模型已成功调用。</p>
                )}
                {actual.data.requests.map((item) => (
                  <details key={item.id} className={styles.request}>
                    <summary>
                      第 {item.turn} 轮 / 第 {item.step} 步 · {item.status}
                    </summary>
                    <p>实际请求：{JSON.stringify(item.requestConfiguration)}</p>
                    <p>实际工具集合：{item.tools.join('、')}</p>
                    <p>服务报告模型：{item.reportedModel ?? '未提供'}</p>
                    <p>Usage：{item.usage ? JSON.stringify(item.usage) : '未提供'}</p>
                    {item.error && (
                      <p role="alert" className={styles.error}>
                        {item.error}
                      </p>
                    )}
                    <p className={styles.path}>规范版本：{item.contextVersion}</p>
                    <p className={styles.path}>
                      Skill清单版本：{item.skillManifestVersion}
                      <br />
                      实际目录版本：{item.skillCatalogVersion}
                    </p>
                    {item.loadedSkills.map((skill) => (
                      <p className={styles.path} key={skill.name}>
                        已加载 {skill.name}：{skill.path}
                        <br />
                        {skill.sha256}
                      </p>
                    ))}
                    {item.sources.map((source) => (
                      <p key={source.path} className={styles.path}>
                        {source.path}
                        <br />
                        {source.sha256} · {source.bytes} 字节 · {source.modifiedAt}
                      </p>
                    ))}
                  </details>
                ))}
              </>
            )}
            <div className={styles.actions}>
              <button className={styles.button} onClick={() => void actual.refetch()}>
                刷新配置
              </button>
              <Dialog.Close className={styles.primary}>关闭</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
