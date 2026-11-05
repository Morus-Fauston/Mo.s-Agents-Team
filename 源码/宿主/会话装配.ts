import { createHash, randomUUID } from 'node:crypto';
import { assembleContext } from '../业务/上下文.ts';
import type { AssembledContext } from '../业务/上下文.ts';
import type { ProjectService } from '../业务/项目服务.ts';
import type { ProjectConnection } from '../业务/项目.ts';
import type { SessionInput, SessionRecord } from '../契约/会话.ts';
import type { RequestRecord } from '../契约/装配.ts';
import type { WorkflowType } from '../契约/角色.ts';
import { ProjectError } from '../业务/错误.ts';
import { SkillAssembly } from './Skill装配.ts';
import { ExplicitSkillGrants } from './本次Skill许可.ts';
import { loadNativeModules } from './原生接口.ts';
import { CommunicationService } from '../业务/私聊服务.ts';
import { DispatchService } from '../业务/派工服务.ts';
import { installExecutionTools } from './执行工具.ts';
import { installCommunicationTools } from './私聊工具.ts';
import { installWorkbenchTools } from './工作台工具.ts';
import type {
  NativeAgent,
  NativeContext,
  NativeModules,
  StepInput,
  StepDecision,
} from './原生接口.ts';
const titles: Record<WorkflowType, string> = {
  supervisor: '主管',
  developer: '开发',
  investigator: '调查',
  reviewer: '审阅',
  committer: '提交',
};
const basic = [
  'read',
  'glob',
  'grep',
  'read_image',
  'write',
  'edit',
  'pwsh',
  'job_output',
  'job_list',
  'job_kill',
  'todo_write',
  'working_directory',
];
interface Binding {
  connection: ProjectConnection;
  session: SessionRecord;
  skills: SkillAssembly;
  context: AssembledContext;
  catalogVersion: string;
  loadedSkills: Map<string, { name: string; path: string; sha256: string }>;
  explicitSkills: ExplicitSkillGrants;
  currentRequest?: RequestRecord;
  execution?: { executionId: string; version: string };
}
export interface SessionRuntime {
  readonly communication: CommunicationService;
  readonly dispatch?: DispatchService;
  create(projectId: string, input: SessionInput): Promise<SessionRecord>;
  configuration(projectId: string, sessionId: string): unknown;
  close(): Promise<void>;
}
export class HostSessionRuntime implements SessionRuntime {
  readonly communication: CommunicationService;
  readonly dispatch: DispatchService;
  private readonly ctx: NativeContext;
  private readonly projects: ProjectService;
  private readonly modules: NativeModules;
  private readonly bindings = new Map<NativeAgent, Binding>();
  private readonly handles: { agent: NativeAgent; dispose(): Promise<void> }[] = [];
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private closed = false;
  private readonly openings = new Map<string, Promise<NativeAgent>>();
  private constructor(ctx: NativeContext, projects: ProjectService, modules: NativeModules) {
    this.ctx = ctx;
    this.projects = projects;
    this.modules = modules;
    this.communication = new CommunicationService(projects, {
      open: (project, session) => this.open(project, session),
      flush: (agent) => ctx.sessions.flush(agent.session),
    });
    this.dispatch = new DispatchService(projects, {
      create: (project, input, reserved) => this.create(project, input, reserved),
      open: (project, session) => this.open(project, session),
      peek: (project, session) => this.peek(project, session),
      directory: (agent) => ctx.workingDirectory.get(agent.session),
      ensureDirectory: (agent) => ctx.workingDirectory.ensure(agent),
      setDirectory: (agent, cwd) => ctx.workingDirectory.set(agent, cwd),
      getGoal: (agent) => {
        if (!ctx.goals) throw new ProjectError('HOST_GOALS_UNAVAILABLE', '宿主未装配原生Goal服务');
        return ctx.goals.get(agent);
      },
      createGoal: (agent, input) => {
        if (!ctx.goals) throw new ProjectError('HOST_GOALS_UNAVAILABLE', '宿主未装配原生Goal服务');
        return ctx.goals.create(agent, input);
      },
      flush: (agent) => ctx.sessions.flush(agent.session),
      notify: (project, input) => this.communication.sendSystem(project, input),
    });
  }
  static async start(ctx: NativeContext, projects: ProjectService): Promise<HostSessionRuntime> {
    if (!ctx.agentPresets)
      throw new ProjectError(
        'HOST_PRESETS_UNAVAILABLE',
        '当前宿主未装配原生预设服务，不能创建MAT工作会话',
      );
    const runtime = new HostSessionRuntime(ctx, projects, await loadNativeModules(ctx));
    try {
      for (const type of Object.keys(titles) as WorkflowType[])
        runtime.disposers.push(
          await ctx.agentPresets.register({
            id: `mat-${type}`,
            name: `MAT ${titles[type]}`,
            description: 'MAT五类共享基础装配；单独选择不取得项目身份',
            plugins: [],
          }),
        );
      runtime.disposers.push(
        ctx.on('agent/pre-step', (input, next) => runtime.prepare(input, next), { prepend: true }),
      );
      runtime.disposers.push(
        ctx.on('agent/assistant-stream', (input) => runtime.trackRequest(input.agent, input.frame)),
      );
      runtime.disposers.push(
        ctx.on('session/event', (session, event) => {
          const found = [...runtime.bindings].find(([agent]) => agent.id === session.id);
          if (!found) return;
          runtime.dispatch.observe(
            found[1].connection.snapshot().id,
            found[1].session.id,
            found[0],
            event,
          );
          runtime.communication.observeOutput(
            found[1].connection.snapshot().id,
            found[1].session.id,
            found[0],
            event,
          );
          if (event.type !== 'turn/end') return;
          const reason = event.data.reason as
            { kind?: string; error?: { message?: string } } | undefined;
          if (reason?.kind === 'error')
            found[1].connection.recordSessionError(
              found[1].session.id,
              reason.error?.message ?? '原生会话执行失败；请查询DSH原始会话记录，不自动换模',
            );
          else if (reason?.kind === 'completed')
            found[1].connection.recordSessionError(found[1].session.id, null);
          found[1].connection.messages().notifySession(found[1].session.id);
        }),
      );
      runtime.disposers.push(
        ctx.on('agent/error', (input) => {
          const binding = runtime.bindings.get(input.agent);
          if (!binding) return;
          binding.connection.recordSessionError(
            binding.session.id,
            '原生会话报告异常；原始错误见DSH会话记录，未自动换模',
          );
          runtime.dispatch.hostError(
            binding.connection.snapshot().id,
            binding.session.id,
            input.agent,
            input,
          );
        }),
      );
      runtime.disposers.push(
        ctx.on('goal/changed', ({ agent }) => {
          const binding = runtime.bindings.get(agent);
          if (binding)
            runtime.dispatch.goalObserved(
              binding.connection.snapshot().id,
              binding.session.id,
              agent,
            );
        }),
      );
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }
  private requireBinding(agent: NativeAgent): Binding {
    const binding = this.bindings.get(agent);
    if (!binding || binding.session.nativeSessionId !== agent.id)
      throw new ProjectError(
        'MAT_IDENTITY_REQUIRED',
        'MAT会话未取得真实项目和角色绑定；预设、cwd和正文不能赋予身份',
      );
    if (this.ctx.agentPresets?.composedPreset(agent.ctx) !== `mat-${binding.session.roleType}`)
      throw new ProjectError('MAT_PRESET_MISMATCH', '当前实际预设与正式角色类型不一致');
    if (binding.connection.session(binding.session.id).nativeSessionId !== agent.id)
      throw new ProjectError('MAT_BINDING_MISMATCH', '持久会话绑定与实际调用者不一致');
    return binding;
  }
  async create(
    projectId: string,
    input: SessionInput,
    onReserved?: (session: SessionRecord) => void,
  ): Promise<SessionRecord> {
    if (this.closed) throw new ProjectError('RUNTIME_CLOSED', '会话装配服务已经关闭');
    const connection = this.projects.forProject(projectId);
    const role = connection.roles().find((r) => r.id === input.roleId);
    if (!role) throw new ProjectError('ROLE_NOT_FOUND', '当前项目没有登记此角色');
    const source = connection.skillSourceRoot();
    if (!source)
      throw new ProjectError('SKILL_SOURCE_REQUIRED', '请先在项目配置中指定For MAT真实来源目录');
    const session = connection.reserveSession(input);
    let skills: SkillAssembly | undefined;
    let handle: { agent: NativeAgent; dispose(): Promise<void> } | undefined;
    let preparedAgent: NativeAgent | undefined;
    try {
      onReserved?.(session);
      const context = assembleContext(connection.snapshot(), role, session, session.cwd);
      skills = new SkillAssembly(this.ctx, this.modules, source, role.type);
      await skills.catalog(session.cwd);
      const ownedSkills = skills;
      const nativeId = `mat-${projectId}-${session.id}`;
      handle = await this.ctx.agents.create({
        sessionId: nativeId,
        meta: { cwd: session.cwd },
        agentOptions: session.configuration,
        setup: async (agentCtx, agent) => {
          preparedAgent = agent;
          await this.configureAgent(connection, session, ownedSkills, context, agentCtx, agent);
        },
      });
      const bound = connection.bindSession(session.id, handle.agent.id);
      this.bindings.get(handle.agent)!.session = bound;
      await this.ctx.agentPresets!.select(handle.agent, `mat-${role.type}`);
      this.handles.push(handle);
      return bound;
    } catch (error) {
      if (preparedAgent) this.bindings.delete(preparedAgent);
      if (handle) await handle.dispose();
      await skills?.dispose();
      connection.failSession(
        session.id,
        error instanceof Error ? error.message : '原生会话创建失败',
      );
      throw error;
    }
  }
  private async configureAgent(
    connection: ProjectConnection,
    session: SessionRecord,
    ownedSkills: SkillAssembly,
    context: AssembledContext,
    agentCtx: NativeContext,
    agent: NativeAgent,
  ): Promise<void> {
    const role = connection.roles().find((role) => role.id === session.roleId)!;
    await this.ctx.agentPresets!.mount(agentCtx, `mat-${role.type}`);
    const allowed = [
      ...basic,
      'skill',
      ...(role.type === 'committer' ? [] : ['web_search', 'web_fetch']),
      ...(role.type === 'supervisor' ? ['ask_user_question', 'present', 'create_worktree'] : []),
    ];
    const existing = agentCtx.tools.definitions(agent).map((tool) => tool.name);
    agentCtx.tools.restrict({ allow: allowed.filter((name) => existing.includes(name)) });
    agentCtx.tools.register(
      this.modules.defineTool({
        name: 'skill',
        description:
          '从当前角色适用的For MAT真实来源按需加载完整Skill。显式入口须本次用户以 $名称 指定。',
        parameters: {
          name: { type: 'string', required: true, description: '目录中的准确名称' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
        },
        execute: async (
          args: { name: string },
          exec: { agent: NativeAgent; signal: AbortSignal },
        ) => {
          const binding = this.requireBinding(exec.agent);
          if (binding.skills !== ownedSkills)
            throw new ProjectError('SKILL_CALLER_MISMATCH', 'Skill工具实际调用者不属于此装配');
          const cwd = await this.ctx.workingDirectory.ensure(exec.agent, exec.signal);
          const loaded = await ownedSkills.load(
            args.name,
            cwd,
            exec.signal,
            binding.explicitSkills.has(args.name),
          );
          binding.loadedSkills.set(args.name, {
            name: args.name,
            path: loaded.path,
            sha256: loaded.sha256,
          });
          return loaded.body;
        },
      }),
    );
    this.bindings.set(agent, {
      connection,
      session: { ...session, nativeSessionId: agent.id },
      skills: ownedSkills,
      context,
      catalogVersion: '',
      loadedSkills: new Map(),
      explicitSkills: new ExplicitSkillGrants(),
    });
    installCommunicationTools(
      agentCtx,
      agent,
      this.modules,
      (caller) => {
        const binding = this.requireBinding(caller);
        return { connection: binding.connection, sessionId: binding.session.id };
      },
      this.communication,
    );
    installWorkbenchTools(agentCtx, agent, this.modules, role.type, (caller) => {
      const binding = this.requireBinding(caller);
      return { connection: binding.connection, sessionId: binding.session.id };
    });
    installExecutionTools(
      agentCtx,
      agent,
      this.modules,
      role.type,
      (caller) => {
        const binding = this.requireBinding(caller);
        return { connection: binding.connection, sessionId: binding.session.id };
      },
      this.dispatch,
    );
  }
  peek(projectId: string, sessionId: string): NativeAgent | undefined {
    const agent = [...this.bindings].find(
      ([, binding]) =>
        binding.connection.snapshot().id === projectId && binding.session.id === sessionId,
    )?.[0];
    if (agent) this.requireBinding(agent);
    return agent;
  }
  async open(projectId: string, sessionId: string): Promise<NativeAgent> {
    if (this.closed) throw new ProjectError('RUNTIME_CLOSED', '会话服务已经关闭');
    const connection = this.projects.forProject(projectId);
    const session = connection.session(sessionId);
    if (session.status !== 'bound' || session.communicationState !== 'active')
      throw new ProjectError('TARGET_CONTROLLED', '目标不是可接纳的活跃入口，不因聊天恢复');
    const existing = [...this.bindings].find(
      ([, binding]) => binding.connection === connection && binding.session.id === sessionId,
    )?.[0];
    if (existing) {
      this.requireBinding(existing);
      return existing;
    }
    const key = `${projectId}:${sessionId}`;
    const pending = this.openings.get(key);
    if (pending) return pending;
    const opening = this.restore(connection, session);
    this.openings.set(key, opening);
    void opening
      .finally(() => {
        if (this.openings.get(key) === opening) this.openings.delete(key);
      })
      .catch(() => {});
    return opening;
  }
  private async restore(
    connection: ProjectConnection,
    session: SessionRecord,
  ): Promise<NativeAgent> {
    if (!session.nativeSessionId || !session.skillSourceRoot)
      throw new ProjectError(
        'SESSION_RESTORE_INCOMPLETE',
        '原会话缺少原生身份或创建时Skill来源，不猜测恢复配置',
      );
    const role = connection.roles().find((role) => role.id === session.roleId)!;
    const context = assembleContext(connection.snapshot(), role, session, session.cwd);
    const skills = new SkillAssembly(
      this.ctx,
      this.modules,
      session.skillSourceRoot,
      session.roleType,
    );
    let prepared: NativeAgent | undefined;
    let handle: { agent: NativeAgent; dispose(): Promise<void> } | undefined;
    try {
      await skills.catalog(session.cwd);
      handle = await this.ctx.agents.resume({
        resumeSessionId: session.nativeSessionId,
        setup: async (agentCtx, agent) => {
          prepared = agent;
          const selected = agent.session
            .snapshotEvents()
            .findLast((event) => event.type === 'agent-preset/selected')?.data.agentPreset;
          if (selected !== `mat-${session.roleType}`)
            throw new ProjectError(
              'RESTORE_PRESET_MISMATCH',
              '历史实际预设与角色绑定不一致，拒绝静默改绑',
            );
          await this.configureAgent(connection, session, skills, context, agentCtx, agent);
        },
      });
      if (handle.agent.id !== session.nativeSessionId)
        throw new ProjectError('RESTORE_ID_MISMATCH', '恢复后的原生会话身份与持久记录不一致');
      this.handles.push(handle);
      return handle.agent;
    } catch (error) {
      if (prepared) this.bindings.delete(prepared);
      await handle?.dispose();
      await skills.dispose();
      throw error;
    }
  }
  private async prepare(
    input: StepInput,
    next: () => Promise<StepDecision>,
  ): Promise<StepDecision> {
    const preset = this.ctx.agentPresets?.composedPreset(input.agent.ctx);
    if (!this.bindings.has(input.agent) && !preset?.startsWith('mat-')) return next();
    const binding = this.requireBinding(input.agent);
    const role = binding.connection.roles().find((r) => r.id === binding.session.roleId)!;
    const cwd = await this.ctx.workingDirectory.ensure(input.agent, input.signal);
    const context = assembleContext(binding.connection.snapshot(), role, binding.session, cwd);
    const catalog = await binding.skills.summary(cwd, input.signal);
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    // Native global instructions, additive catalogs and explicit injections are replaced only for truly bound MAT Agents.
    const excluded = new Set(['agent-instructions', 'skill-catalog', 'skill-invocation']);
    for (const message of input.agent.inbox.nextStep)
      if (excluded.has(String(message.source.kind))) input.agent.inbox.remove(message.id);
    const filtered = decision.messages.filter(
      (message) => !excluded.has(String(message.source.kind)),
    );
    const admitted = await this.communication.admit(
      binding.connection.snapshot().id,
      binding.session.id,
      input.agent,
      input.turn,
      filtered,
    );
    const messages = admitted.messages;
    binding.explicitSkills.accept(input.turn, admitted.grants);
    const version = createHash('sha256')
      .update(context.version)
      .update(catalog.version)
      .digest('hex');
    const previous = input.agent.session
      .deriveMessages()
      .findLast((m) => m.source.kind === 'mat-context');
    if (previous?.source.version !== version) {
      const oldSources = Array.isArray(previous?.source.sources)
        ? (previous.source.sources as { path: string; sha256: string }[])
        : [];
      const changed = context.sections.filter(
        (section) =>
          !oldSources.some(
            (old) => old.path === section.source.path && old.sha256 === section.source.sha256,
          ),
      );
      const removed = oldSources
        .filter((old) => !context.sources.some((current) => current.path === old.path))
        .map((old) => old.path);
      const body = previous
        ? [
            'MAT规范更新：以下现行正文替换先前同路径版本；未变来源继续适用。',
            context.identity,
            ...changed.map((section) => section.body),
            `已不再适用的来源：${JSON.stringify(removed)}`,
            ...(previous.source.catalogVersion === catalog.version ? [] : [catalog.body]),
          ].join('\n\n')
        : `${context.body}\n\n${catalog.body}`;
      if (Buffer.byteLength(body) > 65536)
        throw new ProjectError('CONTEXT_BUDGET', '完整核心规范与Skill目录超出预算，拒绝截断后开工');
      messages.push({
        id: randomUUID(),
        role: 'user',
        source: {
          kind: 'mat-context',
          version,
          sources: context.sources,
          catalogVersion: catalog.version,
        },
        content: [{ type: 'text', text: body }],
      });
    }
    binding.context = context;
    binding.catalogVersion = catalog.version;
    const execution = this.dispatch.context(
      binding.connection.snapshot().id,
      binding.session.id,
      cwd,
    );
    if (execution)
      binding.execution = { executionId: execution.executionId, version: execution.version };
    else delete binding.execution;
    if (
      execution &&
      input.agent.session
        .deriveMessages()
        .findLast((message) => message.source.kind === 'mat-execution-context')?.source.version !==
        execution.version
    )
      messages.push(execution.message);
    return { ...decision, messages };
  }
  private trackRequest(
    agent: NativeAgent,
    frame: {
      type: string;
      attemptId: string;
      turn: number;
      step: number;
      outcome?: { kind: string; seq?: number };
    },
  ): void {
    const binding = this.bindings.get(agent);
    if (!binding) return;
    if (frame.type === 'start') {
      const header = agent.session.requestHeader();
      if (!header)
        throw new ProjectError('REQUEST_HEADER_MISSING', '实际请求没有可追溯的原生请求头');
      binding.currentRequest = {
        id: randomUUID(),
        sessionId: binding.session.id,
        nativeAttemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        contextVersion: binding.context.version,
        sources: binding.context.sources,
        skillManifestVersion: binding.skills.sources.version,
        skillCatalogVersion: binding.catalogVersion,
        loadedSkills: [...binding.loadedSkills.values()],
        requestConfiguration: header.config,
        tools: header.tools?.map((t) => t.name) ?? [],
        reportedModel: null,
        usage: null,
        status: 'started',
        error: null,
        startedAt: new Date().toISOString(),
        ...(binding.execution
          ? {
              executionId: binding.execution.executionId,
              executionContextVersion: binding.execution.version,
            }
          : {}),
      };
      binding.connection.saveRequest(binding.currentRequest);
      this.dispatch.requestObserved(
        binding.connection.snapshot().id,
        binding.session.id,
        binding.currentRequest.id,
      );
      this.communication.noteEntered(
        binding.connection.snapshot().id,
        binding.session.id,
        agent,
        frame.attemptId,
        binding.currentRequest.id,
      );
    } else if (frame.type === 'end' && binding.currentRequest) {
      const record = binding.currentRequest;
      const event =
        frame.outcome?.seq === undefined ? undefined : agent.session.eventAt(frame.outcome.seq);
      const data = event?.data;
      const message = data?.message as
        { source?: { replayState?: { response?: { model?: unknown } } } } | undefined;
      const model = message?.source?.replayState?.response?.model;
      record.reportedModel = typeof model === 'string' ? model : null;
      const usage = data?.usage;
      if (usage && typeof usage === 'object')
        record.usage = Object.fromEntries(
          Object.entries(usage).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === 'number' && Number.isFinite(entry[1]),
          ),
        );
      record.status =
        event?.type === 'assistant/message'
          ? data?.interrupted
            ? 'interrupted'
            : 'completed'
          : 'failed';
      if (record.status === 'failed')
        record.error = '宿主请求未完成，原始错误见关联DSH会话；未自动换模';
      binding.connection.saveRequest(record);
      this.dispatch.requestObserved(
        binding.connection.snapshot().id,
        binding.session.id,
        record.id,
      );
    }
  }
  configuration(projectId: string, sessionId: string) {
    const connection = this.projects.forProject(projectId);
    const session = connection.session(sessionId);
    const native = [...this.bindings].find(
      ([, binding]) => binding.connection === connection && binding.session.id === sessionId,
    )?.[0];
    return {
      session,
      defaultConfiguration: connection.roles().find((r) => r.id === session.roleId)!.configuration,
      requestedConfiguration: session.configuration,
      actualPreset: native ? (this.ctx.agentPresets?.composedPreset(native.ctx) ?? null) : null,
      registeredTools: native ? native.ctx.tools.definitions(native).map((t) => t.name) : null,
      requests: connection.requests(sessionId),
      nativeLoaded: !!native,
      usageAvailability: '每次请求独立保存；null表示宿主未提供',
      unavailableActions: ['审计', '执行控制', '交接保存'],
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.dispatch.close();
    await this.communication.close();
    await Promise.allSettled([...this.openings.values()]);
    for (const dispose of this.disposers.splice(0).reverse()) await dispose();
    for (const handle of this.handles.splice(0).reverse()) await handle.dispose();
    for (const binding of this.bindings.values()) await binding.skills.dispose();
    this.bindings.clear();
  }
}
