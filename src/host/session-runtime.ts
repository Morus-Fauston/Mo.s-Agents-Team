import { createHash, randomUUID } from 'node:crypto';
import { assembleContext } from '../services/context.ts';
import type { AssembledContext } from '../services/context.ts';
import type { ProjectService } from '../services/project-service.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { SessionInput, SessionRecord } from '../contracts/sessions.ts';
import type { RequestRecord } from '../contracts/session-runtime.ts';
import type { WorkflowType } from '../contracts/roles.ts';
import { ProjectError } from '../services/errors.ts';
import { SkillAssembly } from './skills.ts';
import { ExplicitSkillGrants } from './explicit-skills.ts';
import { loadNativeModules } from './native.ts';
import { CommunicationService } from '../services/chat-service.ts';
import { DispatchService } from '../services/dispatch-service.ts';
import { ExecutionControlService } from '../services/execution-controls.ts';
import { ProjectControlService } from '../services/project-controls.ts';
import { CompletionService } from '../services/completion-service.ts';
import { NativeProcessRanges } from './process-ranges.ts';
import { installExecutionTools } from './execution-tools.ts';
import { installCommunicationTools } from './chat-tools.ts';
import { installWorkbenchTools } from './workbench-tools.ts';
import { installReviewTools } from './review-tools.ts';
import type {
  NativeAgent,
  NativeContext,
  NativeModules,
  StepInput,
  StepDecision,
} from './native.ts';
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
  review?: { reviewId: string; versionId: string; version: string };
}
export interface SessionRuntime {
  readonly communication: CommunicationService;
  readonly dispatch?: DispatchService;
  readonly controls?: ExecutionControlService;
  readonly projectControl?: ProjectControlService;
  readonly completions?: CompletionService;
  create(projectId: string, input: SessionInput): Promise<SessionRecord>;
  configuration(projectId: string, sessionId: string): unknown;
  close(): Promise<void>;
}
export class HostSessionRuntime implements SessionRuntime {
  readonly communication: CommunicationService;
  readonly dispatch: DispatchService;
  readonly controls: ExecutionControlService;
  readonly projectControl: ProjectControlService;
  readonly completions: CompletionService;
  private readonly ranges: NativeProcessRanges;
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
    this.ranges = new NativeProcessRanges(ctx, (fact) => {
      const connection = projects.forProject(fact.projectId);
      connection.controls().saveManagedRange(fact.sessionId, fact.callId, fact);
      connection.reviews().saveManagedRange(fact.sessionId, fact.callId, fact);
    });
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
    this.controls = new ExecutionControlService(projects, this.dispatch, this.communication, {
      unassociatedProcesses: (session, associated) =>
        this.ranges
          .forSession(session)
          .filter((fact) => fact.state !== 'gone' && !associated.includes(fact.id)).length,
      native: ctx,
      peek: (project, session) => this.peek(project, session),
      openControlled: (project, session) => this.openControlled(project, session),
      freshContext: async (project, id, agent) => {
        const connection = projects.forProject(project),
          session = connection.session(id),
          role = connection.roles().find((role) => role.id === session.roleId)!;
        const cwd = await ctx.workingDirectory.ensure(agent),
          context = assembleContext(connection.snapshot(), role, session, cwd);
        return {
          cwd,
          sources: context.sources,
          version: context.version,
          configuration: agent.model.current(),
        };
      },
    });
    this.completions = new CompletionService(projects, this.communication, {
      native: ctx,
      peek: (project, session) => this.peek(project, session),
      openControlled: (project, session) => this.openControlled(project, session),
      create: (project, input, reserved) => this.create(project, input, reserved),
      setDirectory: (agent, cwd) => ctx.workingDirectory.set(agent, cwd),
      inspectAuthor: (project, id, agent) => this.controls.inspectExecution(project, id, agent),
      inspectReview: (project, id, review, agent) =>
        this.controls.inspectExecution(project, id, agent, review),
    });
    this.projectControl = new ProjectControlService(
      projects,
      this.controls,
      this.communication,
      {
        reviewsQuiet: (project) => this.completions.reviewsQuiet(project),
        unsettledProcesses: (session) =>
          this.ranges.forSession(session).filter((fact) => fact.state !== 'gone').length,
        native: ctx,
        peek: (project, session) => this.peek(project, session),
        openControlled: (project, session) => this.openControlled(project, session),
        createManager: (project, reserved) => {
          const connection = projects.forProject(project);
          return this.create(
            project,
            {
              roleId: connection.roles().find((role) => role.type === 'supervisor')!.id,
              name: '项目主管默认入口',
              purpose: '项目启动和已授权工作管理',
              cwd: connection.snapshot().root,
            },
            reserved,
          );
        },
      },
      this.dispatch.epoch,
    );
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
          runtime.controls.nativeEvent(
            found[1].connection.snapshot().id,
            found[1].session.id,
            found[0],
            event,
          );
          try {
            found[1].connection.reviews().recordJob(found[1].session.id, event);
          } catch {
            const review = found[1].connection.reviews().forSession(found[1].session.id);
            if (review)
              found[1].connection
                .reviews()
                .problem(review.id, '实际审阅作业来源无法完整关联，保留未知');
          }
          if (event.type === 'job/registered')
            for (const fact of runtime.ranges.forSession(found[1].session.id)) {
              found[1].connection.controls().saveManagedRange(fact.sessionId, fact.callId, fact);
              found[1].connection.reviews().saveManagedRange(fact.sessionId, fact.callId, fact);
            }
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
          const review = binding.connection.reviews().forSession(binding.session.id);
          if (review)
            binding.connection
              .reviews()
              .problem(review.id, '实际审核会话报告异常，保留原版本及审核身份，不另开替代');
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
      runtime.projectControl.startLoaded();
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
    if (!agent.session.snapshotEvents().some((event) => event.type === 'sandbox/mode'))
      this.modules.setSandboxMode(agent.session, 'danger-full-access');
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
      this.controls,
      this.completions,
    );
    installWorkbenchTools(agentCtx, agent, this.modules, role.type, (caller) => {
      const binding = this.requireBinding(caller);
      return { connection: binding.connection, sessionId: binding.session.id };
    });
    installReviewTools(
      agentCtx,
      agent,
      this.modules,
      (caller) => {
        const binding = this.requireBinding(caller);
        return { connection: binding.connection, sessionId: binding.session.id };
      },
      this.completions,
    );
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
      this.controls,
    );
    this.ranges.install(agentCtx, agent, connection.snapshot().id, session.id, (caller) => {
      this.requireBinding(caller);
    });
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
    if (!this.controls.admission(projectId, sessionId))
      throw new ProjectError(
        'PROJECT_OR_EXECUTION_CONTROLLED',
        '项目未启动或当前入口受控制，消息仅保留',
      );
    return this.openControlled(projectId, sessionId);
  }
  async openControlled(projectId: string, sessionId: string): Promise<NativeAgent> {
    if (this.closed) throw new ProjectError('RUNTIME_CLOSED', '会话服务已经关闭');
    const connection = this.projects.forProject(projectId);
    const session = connection.session(sessionId);
    if (
      session.status !== 'bound' ||
      ['terminated', 'archived'].includes(session.communicationState)
    )
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
    const current = binding.connection.session(binding.session.id);
    if (current.status !== 'bound' || current.communicationState !== 'active')
      return {
        kind: 'reject',
        reason: '当前入口受暂停、终止或封存控制；普通输入和原生通知不能解除',
      };
    if (!this.controls.admission(binding.connection.snapshot().id, binding.session.id))
      return { kind: 'reject', reason: '项目或当前控制尚未允许继续；查询和原生消息不解除限制' };
    if (
      !this.completions.admission(binding.connection.snapshot().id, binding.session.id, input.agent)
    )
      return { kind: 'reject', reason: '审核等待、控制或Goal身份尚未允许继续，普通输入不解除' };
    this.controls.assertModelGoal(
      binding.connection.snapshot().id,
      binding.session.id,
      input.agent,
    );
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
    this.controls.assertModelGoal(
      binding.connection.snapshot().id,
      binding.session.id,
      input.agent,
    );
    if (
      !this.controls.admission(binding.connection.snapshot().id, binding.session.id) ||
      !this.completions.admission(binding.connection.snapshot().id, binding.session.id, input.agent)
    )
      return { kind: 'reject', reason: '准备期间已进入等待或控制，不发起新的模型步骤' };
    const review = this.completions.context(binding.connection.snapshot().id, binding.session.id);
    if (review) {
      binding.review = {
        reviewId: review.reviewId,
        versionId: review.versionId,
        version: review.version,
      };
      if (
        input.agent.session
          .deriveMessages()
          .findLast((message) => message.source.kind === 'mat-review-context')?.source.version !==
        review.version
      )
        messages.push({
          id: randomUUID(),
          role: 'user',
          source: {
            kind: 'mat-review-context',
            reviewId: review.reviewId,
            versionId: review.versionId,
            version: review.version,
          },
          content: [{ type: 'text', text: review.text }],
        });
    } else delete binding.review;
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
        ...(binding.review
          ? {
              reviewId: binding.review.reviewId,
              reviewVersionId: binding.review.versionId,
              reviewContextVersion: binding.review.version,
            }
          : {}),
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
      unavailableActions: ['审计', '交接保存'],
      processRangeObservation: this.ranges.available,
      sandboxMode: native
        ? (native.session.snapshotEvents().findLast((event) => event.type === 'sandbox/mode')?.data
            .mode ?? null)
        : null,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.completions.close();
    await this.projectControl.close();
    await this.controls.close();
    this.ranges.close();
    await this.dispatch.close();
    await this.communication.close();
    await Promise.allSettled([...this.openings.values()]);
    for (const dispose of this.disposers.splice(0).reverse()) await dispose();
    for (const handle of this.handles.splice(0).reverse()) await handle.dispose();
    for (const binding of this.bindings.values()) await binding.skills.dispose();
    this.bindings.clear();
  }
}
