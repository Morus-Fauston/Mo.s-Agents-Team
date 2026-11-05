import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { z } from 'zod';
import { registeredRoleSchema } from '../源码/契约/角色';
import type { RegisteredRole, WorkflowType } from '../源码/契约/角色';
import { sessionSchema } from '../源码/契约/会话';
import type { ProjectView } from '../源码/契约/项目';
import { executionConfigurationSchema } from '../源码/契约/项目';
import { request } from './请求';
import styles from './工作台.module.css';
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
export function RoleAndSessionPanel({ project }: { project: ProjectView }) {
  const path = `/api/projects/${project.id}`;
  const client = useQueryClient();
  const roles = useQuery({
    queryKey: ['roles', project.id],
    queryFn: async () => z.array(registeredRoleSchema).parse(await request(path + '/roles')),
  });
  const sessions = useQuery({
    queryKey: ['sessions', project.id],
    queryFn: async () => z.array(sessionSchema).parse(await request(path + '/sessions')),
  });
  const settings = useQuery({
    queryKey: ['settings', project.id],
    queryFn: async () =>
      z.object({ skillSourceRoot: z.string().nullable() }).parse(await request(path + '/settings')),
  });
  const runtime = useQuery({
    queryKey: ['runtime'],
    queryFn: async () =>
      z
        .object({ available: z.boolean(), message: z.string() })
        .parse(await request('/api/runtime')),
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['roles', project.id] }),
      client.invalidateQueries({ queryKey: ['sessions', project.id] }),
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
  return (
    <>
      <div className={styles.sectionHeader}>
        <h3>已登记角色</h3>
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
                  {(['developer', 'investigator', 'reviewer', 'committer'] as const).map((type) => (
                    <option value={type} key={type}>
                      {typeNames[type]}
                    </option>
                  ))}
                </select>
              </label>
              <ConfigurationFields />
            </>
          }
        />
      </div>
      {roles.isPending && <p role="status">正在读取角色…</p>}
      {roles.isError && (
        <p role="alert" className={styles.error}>
          {roles.error.message}
        </p>
      )}
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
              {role.configuration.reasoningEffort ? ` · ${role.configuration.reasoningEffort}` : ''}
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
                    { name: String(data.get('name')), configuration: configuration(data) },
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
            afterSave={async () => client.invalidateQueries({ queryKey: ['settings', project.id] })}
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
      <div className={styles.sectionHeader}>
        <h3>工作会话</h3>
        <button
          className={styles.button}
          onClick={() => void client.invalidateQueries({ queryKey: ['sessions', project.id] })}
        >
          刷新会话
        </button>
      </div>
      <p className={styles.description}>{runtime.data?.message ?? '正在核对宿主连接…'}</p>
      {runtime.isError && (
        <p role="alert" className={styles.error}>
          {runtime.error.message}
        </p>
      )}
      {sessions.isError && (
        <p role="alert" className={styles.error}>
          {sessions.error.message}
        </p>
      )}
      {sessions.data?.length === 0 && <p>尚未创建工作会话。</p>}
      <div className={styles.sessionList}>
        {sessions.data?.map((session) => (
          <div className={styles.sessionRow} key={session.id}>
            <div>
              <strong>{session.name}</strong>
              <p>
                {session.addresses.readable} · {session.addresses.numeric}
              </p>
              <p>
                {session.purpose} ·{' '}
                {session.status === 'bound' ? '已绑定，未据此判定开工' : session.status}
              </p>
              {session.error && (
                <p role="alert" className={styles.error}>
                  {session.error}
                </p>
              )}
            </div>
            <button className={styles.button} onClick={() => setSelected(session.id)}>
              查看生效配置
            </button>
          </div>
        ))}
      </div>
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
                  <dt>原生会话</dt>
                  <dd>{actual.data.session.nativeSessionId ?? '未绑定'}</dd>
                  <dt>当前实际预设</dt>
                  <dd>{actual.data.actualPreset ?? '当前进程未加载；不推定已生效'}</dd>
                  <dt>已登记工具</dt>
                  <dd>{actual.data.registeredTools?.join('、') ?? '当前进程未加载'}</dd>
                </dl>
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
