import { WorktreeService } from '../services/worktrees.ts';
import { WorktreeMergeService } from '../services/worktree-merges.ts';
import { installWorktreeMergeTools } from './worktree-merge-tools.ts';
import { createWorktreeHost } from './worktree-host.ts';
import { installWorktreeTools } from './worktree-tools.ts';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  fingerprintPaths,
  inFlightNativeTools,
  windowsProcessSnapshot,
} from '../services/quiescence.ts';
import { nativeTerminalJobStatuses } from '../contracts/controls.ts';
import type { StoppedObservation } from '../contracts/controls.ts';
import type { AssistantRecord } from '../contracts/collaboration.ts';
import type { CollaborationWait } from '../contracts/collaboration-results.ts';
import { CollaborationResultsService } from '../services/collaboration-results-service.ts';
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
import { ReviewResultService } from '../services/review-result-service.ts';
import { AcceptanceService } from '../services/acceptance-service.ts';
import { installAcceptanceTools } from './acceptance-tools.ts';
import { NativeProcessRanges } from './process-ranges.ts';
import { installExecutionTools } from './execution-tools.ts';
import { installCommunicationTools } from './chat-tools.ts';
import { installWorkbenchTools } from './workbench-tools.ts';
import { installReviewTools } from './review-tools.ts';
import { installReviewResultTools } from './review-result-tools.ts';
import { AssistantService } from '../services/assistant-service.ts';
import { installAssistantTools } from './assistant-tools.ts';
import { AssistantLogNotices } from './assistant-log-notices.ts';
import { AssistantControlService } from '../services/assistant-controls.ts';
import { installAssistantControlTools } from './assistant-control-tools.ts';
import { installDecisionRequestTools } from './decision-request-tools.ts';
import { LocalCommitService } from '../services/local-commits.ts';
import { installLocalCommitTools } from './local-commit-tools.ts';
import { observeLocalCommit } from './local-commit-quiescence.ts';
import { DecisionRequestService } from '../services/decision-requests.ts';
import {
  ModelConfigurationService,
  modelAvailabilityFailureCodes,
  modelFaultMatches,
} from '../services/model-configurations.ts';
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
  execution?: { executionId: string; version: string; reviewResultId: string | null };
  review?: { reviewId: string; versionId: string; version: string };
}
export interface SessionRuntime {
  readonly worktreeMerges?: WorktreeMergeService;
  readonly worktrees?: WorktreeService;
  readonly localCommits?: LocalCommitService;
  readonly models?: ModelConfigurationService;
  readonly decisionRequests?: DecisionRequestService;
  readonly assistantControls?: AssistantControlService;
  readonly collaborationResults?: CollaborationResultsService;
  readonly assistants?: AssistantService;
  readonly communication: CommunicationService;
  readonly dispatch?: DispatchService;
  readonly controls?: ExecutionControlService;
  readonly projectControl?: ProjectControlService;
  readonly completions?: CompletionService;
  readonly reviewResults?: ReviewResultService;
  readonly acceptance?: AcceptanceService;
  create(projectId: string, input: SessionInput): Promise<SessionRecord>;
  configuration(projectId: string, sessionId: string): unknown;
  close(): Promise<void>;
}
export class HostSessionRuntime implements SessionRuntime {
  readonly worktreeMerges: WorktreeMergeService;
  readonly worktrees: WorktreeService;
  readonly localCommits: LocalCommitService;
  readonly models: ModelConfigurationService;
  readonly decisionRequests: DecisionRequestService;
  readonly assistantControls: AssistantControlService;
  private readonly logNotices = new AssistantLogNotices();
  readonly collaborationResults: CollaborationResultsService;
  readonly assistants: AssistantService;
  readonly communication: CommunicationService;
  readonly dispatch: DispatchService;
  readonly controls: ExecutionControlService;
  readonly projectControl: ProjectControlService;
  readonly completions: CompletionService;
  readonly reviewResults: ReviewResultService;
  readonly acceptance: AcceptanceService;
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
      connection.worktrees().saveManagedRange(fact.sessionId, fact);
      connection.localCommits().saveManagedRange(fact.sessionId, fact);
      connection.worktreeMerges().saveManagedRange(fact.sessionId, fact);
      connection.controls().saveManagedRange(fact.sessionId, fact.callId, fact);
      connection.reviews().saveManagedRange(fact.sessionId, fact.callId, fact);
      this.assistantControls?.reconcile(fact.projectId, fact.sessionId, fact.state === 'pending');
      this.collaborationResults?.reconcile(fact.projectId, fact.sessionId);
    });
    this.communication = new CommunicationService(projects, {
      peek: (project, session) => this.peek(project, session),
      open: (project, session) => this.open(project, session),
      flush: (agent) => ctx.sessions.flush(agent.session),
    });
    this.dispatch = new DispatchService(projects, {
      observeSessionReuse: (project, session, previous) => {
        if (!session.nativeSessionId || previous.startBoundarySeq === null) return undefined;
        const ranges = this.ranges
          .forSession(session.id)
          .filter((range) => range.projectId === project);
        return observeLocalCommit(
          ctx,
          this.peek(project, session.id),
          session.nativeSessionId,
          this.dispatch.epoch,
          this.ranges.available,
          {
            native: {
              nativeSessionId: session.nativeSessionId,
              epoch: this.dispatch.epoch,
              boundary: previous.startBoundarySeq,
              ranges,
            },
          },
        );
      },
      workspaceDirectory: (p, a, id, cwd) => this.worktrees.prepareDispatch(p, a, id, cwd),
      admitWorkspace: async (p, id, cwd) => {
        if (!(await this.worktreeMerges.admitExecution(p, id, cwd)))
          return this.worktrees.admitExecution(p, id, cwd);
      },
      confirmWorkspaceBaseline: (p, id, version) => {
        this.worktreeMerges.confirmStartupBaseline(p, id, version);
        this.worktrees.confirmStartupBaseline(p, id, version);
      },
      create: (project, input, reserved) => this.create(project, input, reserved),
      open: (project, session) => this.open(project, session),
      peek: (project, session) => this.peek(project, session),
      directory: (agent) => ctx.workingDirectory.get(agent.session),
      ensureDirectory: (agent) => this.ensureDirectory(agent),
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
    this.assistants = new AssistantService(projects, {
      failed: (project, a) => this.collaborationResults.fault(project, a.id),
      create: (project, input, reserved) => this.create(project, input, reserved),
      reuse: async (project, id, claim) => {
        const agent = await this.open(project, id);
        const cwd = await this.ensureDirectory(agent);
        if (
          agent.status !== 'idle' ||
          agent.inbox.nextStep.some(
            (m) =>
              !['agent-instructions', 'skill-catalog', 'skill-invocation'].includes(
                String(m.source.kind),
              ),
          ) ||
          ctx.goals?.get(agent) ||
          !ctx.jobs ||
          ctx.jobs
            .list(agent.id)
            .some(
              (job) => job.owner === agent.id && !nativeTerminalJobStatuses.includes(job.status),
            ) ||
          this.ranges.forSession(id).some((f) => f.state !== 'gone')
        )
          throw new ProjectError(
            'ASSISTANT_NATIVE_BUSY',
            '原生会话仍忙碌、有Goal或待处理输入，不能接管',
          );
        const prepared = {
          ...projects.forProject(project).session(id),
          cwd,
        };
        claim(prepared);
        return prepared;
      },
    });
    this.assistantControls = new AssistantControlService(
      projects,
      this.communication,
      {
        native: ctx,
        peek: (project, id) => this.peek(project, id),
        inspect: (project, a, agent) => this.inspectCollaboration(project, a, agent),
        freshContext: async (project, id, agent) => {
          const connection = projects.forProject(project),
            session = connection.session(id),
            role = connection.roles().find((r) => r.id === session.roleId)!;
          const cwd = await this.ensureDirectory(agent),
            context = assembleContext(connection.snapshot(), role, session, cwd);
          return {
            cwd,
            sources: context.sources,
            version: context.version,
            configuration: agent.model.current(),
          };
        },
        changed: (project, id) => this.collaborationResults.fault(project, id),
      },
      this.dispatch.epoch,
    );
    this.controls = new ExecutionControlService(
      projects,
      this.dispatch,
      this.communication,
      {
        unassociatedProcesses: (session, associated) =>
          this.ranges
            .forSession(session)
            .filter((fact) => fact.state !== 'gone' && !associated.includes(fact.id)).length,
        native: ctx,
        peek: (project, session) => this.peek(project, session),
        openControlled: (project, session) => this.openControlled(project, session),
        checkMergeRecovery: (project, execution, cwd) =>
          this.worktreeMerges.admitExecution(project, execution, cwd, true),
        freshContext: async (project, id, agent) => {
          const connection = projects.forProject(project),
            session = connection.session(id),
            role = connection.roles().find((role) => role.id === session.roleId)!;
          const cwd = await this.ensureDirectory(agent),
            context = assembleContext(connection.snapshot(), role, session, cwd);
          return {
            cwd,
            sources: context.sources,
            version: context.version,
            configuration: agent.model.current(),
          };
        },
      },
      this.assistantControls,
    );
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
    this.reviewResults = new ReviewResultService(projects, this.communication, {
      native: ctx,
      epoch: this.dispatch.epoch,
      peek: (project, session) => this.peek(project, session),
      openControlled: (project, session) => this.openControlled(project, session),
      settleReviewer: (project, id) => this.completions.settleReview(project, id),
      inspectMain: (project, id, agent, afterClear) =>
        this.controls.inspectExecution(project, id, agent, undefined, afterClear),
      freshExecution: async (project, id, agent) => {
        const connection = projects.forProject(project),
          execution = connection.executions().currentForSession(id),
          result = execution ? connection.reviewResults().list(execution.id).at(-1) : undefined;
        if (!execution || !result)
          throw new ProjectError('REVIEW_RETURN_CONTEXT_MISSING', '原执行正式意见不可取得');
        const cwd = await this.ensureDirectory(agent),
          session = connection.session(id),
          role = connection.roles().find((role) => role.id === session.roleId)!;
        const context = assembleContext(connection.snapshot(), role, session, cwd),
          input = this.dispatch.context(project, id, cwd, result.id);
        if (!input)
          throw new ProjectError('REVIEW_RETURN_CONTEXT_MISSING', '最新原票及规范无法装配');
        return {
          objective:
            input.message.content[0]!.text +
            '\n当前角色规范来源版本：' +
            context.version +
            '\n先用mat_review_result读全当前正式退回意见，只在原授权范围修正，再完成Chat。',
          version: input.version + ':' + context.version,
        };
      },
      assertWriteScope: (project, id, scopes) => this.controls.conflictGuard(project, id, scopes),
    });
    this.acceptance = new AcceptanceService(projects, this.communication, this.dispatch);
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
    this.collaborationResults = new CollaborationResultsService(projects, this.communication, {
      peek: (project, id) => this.peek(project, id),
      pause: async (project, w, agent) => {
        this.assertCollaborationWait(project, w, agent);
        if (!ctx.goals) throw new ProjectError('HOST_GOALS_UNAVAILABLE', '原生Goal不可用');
        let goal = ctx.goals.get(agent);
        if (!goal || goal.id !== w.goalId || goal.phase === 'complete')
          throw new ProjectError('WAIT_GOAL_MISMATCH', '等待不是当前原Goal，不新建替代');
        ctx.goals.disarm(agent);
        goal = ctx.goals.get(agent)!;
        if (goal.phase === 'active')
          ctx.goals.pause(agent, { id: goal.id, revision: goal.revision });
        if (!(await ctx.sessions.flush(agent.session)))
          throw new ProjectError('WAIT_DURABILITY_UNKNOWN', '原Goal挂起未确认持久接纳');
        this.assertCollaborationWait(project, w, agent);
        goal = ctx.goals.get(agent);
        if (goal?.id !== w.goalId || goal.phase !== 'paused' || goal.activation !== 'disarmed')
          throw new ProjectError('WAIT_PAUSE_UNKNOWN', '原Goal暂停和解除武装未核清');
      },
      resume: async (project, w, agent) => {
        this.assertCollaborationWait(project, w, agent);
        const c = projects.forProject(project);
        if (!c.collaborationResults().canWake(w.id))
          throw new ProjectError('WAIT_NOT_READY', '当前等待不允许恢复');
        const goal = ctx.goals?.get(agent);
        if (
          !goal ||
          goal.id !== w.goalId ||
          goal.phase !== 'paused' ||
          goal.activation !== 'disarmed'
        )
          throw new ProjectError('WAIT_GOAL_MISMATCH', '原Goal不处于本次等待暂停，不解除其他控制');
        ctx.goals!.resume(agent, { id: goal.id, revision: goal.revision });
        if (!(await ctx.sessions.flush(agent.session)))
          throw new ProjectError('WAIT_DURABILITY_UNKNOWN', '原Goal接续未确认持久接纳');
        this.assertCollaborationWait(project, w, agent);
        const actual = ctx.goals!.get(agent);
        if (actual?.id !== w.goalId || actual.phase !== 'active' || actual.activation !== 'armed')
          throw new ProjectError('WAIT_RESUME_UNKNOWN', '原Goal接续未核清');
      },
      inspect: (project, a, agent) => this.inspectCollaboration(project, a, agent),
    });
    this.decisionRequests = new DecisionRequestService(
      projects,
      this.communication,
      this.collaborationResults,
    );
    this.localCommits = new LocalCommitService(projects, {
      inspect: (p, s, callId, value) =>
        observeLocalCommit(
          ctx,
          this.peek(p, s),
          projects.forProject(p).session(s).nativeSessionId,
          this.dispatch.epoch,
          this.ranges.available,
          value,
          callId,
        ),
      allowed: (p, s) => this.controls.admission(p, s),
      notify: (p, id, notice) => this.communication.sendLocalCommitNotice(p, id, notice),
    });
    this.worktreeMerges = new WorktreeMergeService(projects, {
      inspect: (p, s, callId, value) =>
        observeLocalCommit(
          ctx,
          this.peek(p, s),
          projects.forProject(p).session(s).nativeSessionId,
          this.dispatch.epoch,
          this.ranges.available,
          value,
          callId,
          'mat_merge',
        ),
      allowed: (p, s) => this.controls.admission(p, s),
      notify: (p, id, notice) => this.communication.sendMergeNotice(p, id, notice),
    });
    this.worktrees = new WorktreeService(
      projects,
      createWorktreeHost(
        ctx,
        projects,
        (p, s) => this.peek(p, s),
        this.ranges,
        this.dispatch.epoch,
      ),
    );
    this.models = new ModelConfigurationService(projects, {
      peek: (p, s) => this.peek(p, s),
      flush: (a) => ctx.sessions.flush(a.session),
      canContinue: (p, s, a) =>
        this.peek(p, s) === a &&
        this.controls.admission(p, s) &&
        this.completions.admission(p, s, a) &&
        this.reviewResults.admission(p, s, a),
      canSwitch: (a) => a.status === 'idle' && ctx.goals?.get(a)?.activation !== 'armed',
      classify: (error) => {
        const code = (error as { code?: unknown } | null)?.code;
        return modules.isLlmFailure?.(error) &&
          typeof code === 'string' &&
          modelAvailabilityFailureCodes.has(code)
          ? code
          : null;
      },
      recoverableFault: (agent, error) => modelFaultMatches(agent.session.snapshotEvents(), error),
      fault: (_p, _s, a, input) => this.nativeError(a, input, false),
    });
  }
  private assertCollaborationWait(project: string, w: CollaborationWait, agent: NativeAgent): void {
    const c = this.projects.forProject(project),
      e = c.executions().get(w.executionId),
      session = c.session(w.sessionId);
    if (
      e.hostEpoch !== this.dispatch.epoch ||
      e.nativeSessionId !== agent.id ||
      e.sessionId !== w.sessionId ||
      e.lifecycleState !== 'waiting' ||
      e.waitingReviewId !== null ||
      session.communicationState !== 'active' ||
      c.controls().revision(e.id) !== w.controlRevision
    )
      throw new ProjectError('WAIT_CONTROL_CHANGED', '原等待身份或控制修订变化，不解除暂停');
  }
  private async inspectCollaboration(
    project: string,
    a: AssistantRecord,
    agent: NativeAgent,
  ): Promise<StoppedObservation> {
    const c = this.projects.forProject(project),
      domains = c
        .workbench()
        .materialDomains(a.ticketId)
        .filter((d) => d.referenceId === a.id),
      paths = [...a.writeScopes, ...domains.map((d) => d.path)];
    if (agent.id !== a.nativeSessionId || this.ctx.goals?.get(agent))
      throw new ProjectError(
        'ASSISTANT_GOAL_UNEXPECTED',
        '辅助原生身份或Goal不能核对，未控制其他Goal',
      );
    const excluded = [dirname(c.snapshot().paths.database)],
      first = fingerprintPaths(paths, { excluded });
    await delay(300);
    const second = fingerprintPaths(paths, { excluded }),
      snapshot = await windowsProcessSnapshot();
    const ranges = this.ranges.forSession(a.sessionId!),
      events = agent.session.snapshotEvents(),
      registered = events.filter((e) => e.type === 'job/registered' && e.data.owner === agent.id);
    const live = this.ctx.jobs?.list(agent.id),
      ids = new Set(registered.map((e) => String(e.data.jobId)));
    const observations = registered.map((event) => {
      const id = String(event.data.jobId),
        settled = events.findLast(
          (e) =>
            e.type === 'job/settled' &&
            e.data.jobId === id &&
            e.data.owner === agent.id &&
            e.data.startedAt === event.data.startedAt,
        );
      const native = live?.find((j) => j.id === id && j.owner === agent.id);
      const status =
        native?.status ??
        (settled?.data.producerReported === true ? String(settled.data.status) : 'unknown');
      const callId = (event.data.toolCall as { callId?: string } | undefined)?.callId,
        owned = ranges.filter((r) => r.callId === callId);
      return {
        jobId: id,
        nativeStatus: status,
        externalStatus:
          owned.length && owned.every((r) => r.state === 'gone')
            ? ('gone' as const)
            : ('unknown' as const),
      };
    });
    return {
      agentIdle: agent.status === 'idle',
      inFlightTools: inFlightNativeTools(events, 0).length > 0,
      filesStable: first.complete && second.complete ? first.digest === second.digest : null,
      fileFingerprint: second.digest,
      processesComplete:
        snapshot.complete &&
        this.ranges.available &&
        ranges.every((r) => r.state === 'gone') &&
        !!live &&
        !live.some((j) => j.owner === agent.id && !ids.has(j.id)) &&
        observations.every(
          (j) => j.externalStatus === 'gone' && nativeTerminalJobStatuses.includes(j.nativeStatus),
        ),
      jobObservations: observations,
      note: '实际辅助会话与工具、两次声明范围指纹间隔300ms、原生作业及受管进程范围分别核对；未知不释放，不宣称OS隔离。',
      observedAt: new Date().toISOString(),
      intervalMs: 300,
    };
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
          if (event.type === 'job/settled')
            runtime.assistantControls.reconcile(
              found[1].connection.snapshot().id,
              found[1].session.id,
            );
          if (event.type === 'job/settled')
            runtime.collaborationResults.reconcile(
              found[1].connection.snapshot().id,
              found[1].session.id,
            );
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
            event.type === 'turn/end'
              ? runtime.models.recoveryForTurn(
                  found[1].connection.snapshot().id,
                  found[1].session.id,
                  event.data.turn,
                  (event.data.reason as { error?: { code?: unknown } } | undefined)?.error?.code,
                )
              : undefined,
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
              runtime.models.recovering(found[1].connection.snapshot().id, found[1].session.id)
                ? '原配置请求失败；正在核对本会话指定单一备用，不代表已成功使用'
                : (reason.error?.message ??
                    '原生会话执行失败；请查询DSH原始会话记录与配置切换事实'),
            );
          else if (reason?.kind === 'completed')
            found[1].connection.recordSessionError(found[1].session.id, null);
          found[1].connection.messages().notifySession(found[1].session.id);
        }),
      );
      runtime.disposers.push(
        ctx.on('agent/error', (input) => runtime.nativeError(input.agent, input)),
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
  private nativeError(
    agent: NativeAgent,
    input: { error: unknown; turn?: number; step?: number },
    fallback = true,
  ): void {
    const binding = this.bindings.get(agent);
    if (!binding) return;
    if (
      fallback &&
      this.models.modelError(binding.connection.snapshot().id, binding.session.id, agent, input)
    )
      return;
    const review = binding.connection.reviews().forSession(binding.session.id);
    if (review)
      binding.connection
        .reviews()
        .problem(review.id, '实际审核会话报告异常，保留原版本及审核身份，不另开替代');
    binding.connection.recordSessionError(
      binding.session.id,
      '原生会话报告异常；原始错误见DSH会话记录，配置切换与失败请求分别记录',
    );
    this.dispatch.hostError(binding.connection.snapshot().id, binding.session.id, agent, input);
    const assistant = binding.connection.collaborations().currentForSession(binding.session.id);
    if (assistant) {
      binding.connection
        .collaborations()
        .problem(assistant.id, '辅助原生会话报告异常，原始错误见DSH会话记录', true);
      this.collaborationResults.fault(binding.connection.snapshot().id, assistant.id);
    }
  }
  private assertBusinessDirectory(agent: NativeAgent) {
    const b = this.bindings.get(agent);
    if (b)
      this.worktrees?.assertBusinessDirectory(
        b.connection.snapshot().id,
        b.session.id,
        this.ctx.workingDirectory.get(agent.session),
      );
  }
  private async ensureDirectory(agent: NativeAgent, signal?: AbortSignal) {
    this.assertBusinessDirectory(agent);
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal);
    this.assertBusinessDirectory(agent);
    return cwd;
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
      ...(role.type === 'supervisor' ? ['ask_user_question', 'present'] : []),
      ...(['supervisor', 'developer', 'investigator'].includes(role.type)
        ? ['create_worktree']
        : []),
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
          const cwd = await this.ensureDirectory(exec.agent, exec.signal);
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
      this.collaborationResults,
      this.assistantControls,
    );
    installAssistantControlTools(
      agentCtx,
      agent,
      this.modules,
      (caller) => {
        const binding = this.requireBinding(caller);
        return { connection: binding.connection, sessionId: binding.session.id };
      },
      this.assistantControls,
    );
    installDecisionRequestTools(
      agentCtx,
      agent,
      this.modules,
      (caller) => {
        const binding = this.requireBinding(caller);
        return { connection: binding.connection, sessionId: binding.session.id };
      },
      this.decisionRequests,
    );
    installLocalCommitTools(
      agentCtx,
      agent,
      this.modules,
      (caller) => {
        const b = this.requireBinding(caller);
        return { connection: b.connection, sessionId: b.session.id };
      },
      this.localCommits,
    );
    installWorktreeTools(
      agentCtx,
      agent,
      this.modules,
      role.type,
      (caller) => {
        const b = this.requireBinding(caller);
        return { connection: b.connection, sessionId: b.session.id };
      },
      this.worktrees,
      (definition) =>
        this.ranges.wrap(
          definition,
          agent,
          connection.snapshot().id,
          session.id,
          (caller, name) => {
            this.requireBinding(caller);
            if (name !== 'mat_worktree') this.assertBusinessDirectory(caller);
          },
        ),
    );
    installWorktreeMergeTools(
      agentCtx,
      agent,
      this.modules,
      (caller) => {
        const b = this.requireBinding(caller);
        return { connection: b.connection, sessionId: b.session.id };
      },
      this.worktreeMerges,
    );
    installWorkbenchTools(agentCtx, agent, this.modules, role.type, (caller) => {
      const binding = this.requireBinding(caller);
      return { connection: binding.connection, sessionId: binding.session.id };
    });
    if (['developer', 'investigator', 'reviewer'].includes(role.type))
      installAssistantTools(
        agentCtx,
        agent,
        this.modules,
        (caller) => {
          const binding = this.requireBinding(caller);
          return { connection: binding.connection, sessionId: binding.session.id };
        },
        this.assistants,
      );
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
    installAcceptanceTools(
      agentCtx,
      agent,
      this.modules,
      role.type,
      (caller) => {
        const binding = this.requireBinding(caller);
        return { connection: binding.connection, sessionId: binding.session.id };
      },
      this.acceptance,
    );
    installReviewResultTools(
      agentCtx,
      agent,
      this.modules,
      role.type,
      (caller) => {
        const binding = this.requireBinding(caller);
        return { connection: binding.connection, sessionId: binding.session.id };
      },
      this.reviewResults,
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
    for (const definition of agentCtx.tools.definitions(agent)) {
      if (!['write', 'edit', 'working_directory'].includes(definition.name)) continue;
      agentCtx.tools.register({
        ...definition,
        execute: (args, exec) => {
          if (exec.agent !== agent)
            throw new ProjectError('TOOL_CALLER_MISMATCH', '目录工具不属于实际会话');
          this.assertBusinessDirectory(agent);
          return definition.execute(args, exec);
        },
      });
    }
    this.ranges.install(agentCtx, agent, connection.snapshot().id, session.id, (caller, name) => {
      this.requireBinding(caller);
      if (name !== 'mat_worktree') this.assertBusinessDirectory(caller);
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
    const collaboration = binding.connection.collaborations().currentForSession(current.id);
    if (
      collaboration &&
      !binding.connection.collaborations().scopeForSession(current.id)?.allowWrite
    )
      return { kind: 'reject', reason: '原主执行或本次协作不再允许继续，普通输入不解除控制' };
    if (current.status !== 'bound' || current.communicationState !== 'active')
      return {
        kind: 'reject',
        reason: '当前入口受暂停、终止或封存控制；普通输入和原生通知不能解除',
      };
    if (!this.models.admission(binding.connection.snapshot().id, binding.session.id))
      return { kind: 'reject', reason: '原生模型切换尚未核定，不发起未经确认的新配置步骤' };
    if (!this.controls.admission(binding.connection.snapshot().id, binding.session.id))
      return { kind: 'reject', reason: '项目或当前控制尚未允许继续；查询和原生消息不解除限制' };
    if (
      !this.completions.admission(binding.connection.snapshot().id, binding.session.id, input.agent)
    )
      return { kind: 'reject', reason: '审核等待、控制或Goal身份尚未允许继续，普通输入不解除' };
    if (
      !this.reviewResults.admission(
        binding.connection.snapshot().id,
        binding.session.id,
        input.agent,
      )
    )
      return { kind: 'reject', reason: '正式返修结果尚未接纳实际原Goal，普通输入不能解除未知' };
    this.controls.assertModelGoal(
      binding.connection.snapshot().id,
      binding.session.id,
      input.agent,
    );
    const role = binding.connection.roles().find((r) => r.id === binding.session.roleId)!;
    const cwd = await this.ensureDirectory(input.agent, input.signal);
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
    if (collaboration) {
      const parent = binding.connection.session(collaboration.parentSessionId),
        ticket = binding.connection.workbench().getTicket(collaboration.ticketId);
      const domain = binding.connection.workbench().allocateCurrentMaterial(current.id);
      messages.push({
        id: randomUUID(),
        role: 'user',
        source: {
          kind: 'mat-collaboration-context',
          collaborationId: collaboration.id,
          executionId: collaboration.executionId,
        },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              responsibility:
                '本票一层辅助，结果先回主负责人；不能再创建辅助，不自行交整票独审或结票。',
              collaborationId: collaboration.id,
              ticket: {
                id: ticket.id,
                code: ticket.code,
                goal: ticket.goal,
                included: ticket.included,
                excluded: ticket.excluded,
              },
              parentSessionId: parent.id,
              parentAddress: parent.addresses.readable,
              cwd: collaboration.cwd,
              writeScopes: collaboration.writeScopes,
              allowedChecklistIds: collaboration.checklistGrant?.ids ?? [],
              control: binding.connection.assistantControls().access(collaboration.id),
              materialDirectory: domain.path,
              boundary:
                '源码只写声明范围，空列表只读源码；只写自身材料域。可读取同票材料。不代填人工或默认更新Checklist。普通Chat不扩范围。control.shutdownOnly=true时只保存手上小块与必要Log，按该controlId挂起回报，不展开新工作。',
            }),
          },
        ],
      });
    }
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
      binding.execution = {
        executionId: execution.executionId,
        version: execution.version,
        reviewResultId: execution.reviewResultId,
      };
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
      !this.completions.admission(
        binding.connection.snapshot().id,
        binding.session.id,
        input.agent,
      ) ||
      !this.reviewResults.admission(
        binding.connection.snapshot().id,
        binding.session.id,
        input.agent,
      )
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
    if (role.type === 'committer') {
      const local = binding.connection.localCommits().currentForSession(binding.session.id),
        last = input.agent.session
          .deriveMessages()
          .findLast((m) => m.source.kind === 'mat-local-commit-context');
      const localVersion = local ? local.id + ':' + local.revision : 'none';
      if (last?.source.version !== localVersion)
        messages.push({
          id: randomUUID(),
          role: 'user',
          source: { kind: 'mat-local-commit-context', version: localVersion },
          content: [
            {
              type: 'text',
              text: local
                ? JSON.stringify({
                    responsibility: '主管直属本地提交事项，不新建主执行或Goal、不处理业务修复',
                    id: local.id,
                    revision: local.revision,
                    status: local.status,
                    repository: local.plan.repository,
                    head: local.plan.head,
                    kind: local.kind,
                    fileCount: local.plan.files.length,
                    fingerprint: local.plan.fingerprint,
                    materialDirectory: local.materialPath,
                    detailTool: 'mat_local_commit query',
                    instruction:
                      '先分页读完整原安排、依据及准确files，再inspect核对；只有ready才可一次办理原范围。终端须明确git --literal-pathspecs -C 原仓库及单个files，清除影响仓库/索引路由的GIT环境覆盖。禁止自动全部暂存、stash、reset、clean或push。unknown只能先reconcile回读；completed不再写Git。自报、Git对象、原生安静与通知接纳分别记录，不以commit改业务验收。',
                  })
                : '此前本地提交安排已结束或不再适用；没有当前Git写入授权，不从旧对话重做。',
            },
          ],
        });
      const merge = binding.connection.worktreeMerges().currentForSession(binding.session.id),
        previousMerge = input.agent.session
          .deriveMessages()
          .findLast((m) => m.source.kind === 'mat-merge-context'),
        mergeVersion = merge ? merge.id + ':' + merge.revision : 'none';
      if (previousMerge?.source.version !== mergeVersion)
        messages.push({
          id: randomUUID(),
          role: 'user',
          source: { kind: 'mat-merge-context', version: mergeVersion },
          content: [
            {
              type: 'text',
              text: merge
                ? JSON.stringify({
                    responsibility:
                      '原主管明确的普通跨树合入，不创建业务主执行或Goal；不代开发者选择业务冲突',
                    id: merge.id,
                    revision: merge.revision,
                    status: merge.status,
                    repository: merge.preview.plan.target.repository,
                    targetHead: merge.preview.plan.target.head,
                    sourceCommit: merge.preview.plan.sourceCommit,
                    sourceVersionId: merge.preview.source.versionId,
                    sourceResultId: merge.preview.source.resultId,
                    mode: merge.lastInspection?.mode ?? merge.preview.plan.mode,
                    repairVersion: merge.repair?.version?.versionId ?? null,
                    combinationTicketId: merge.combinationTicketId,
                    instructions:
                      '用mat_merge query完整读取原依据，再inspect；只在ready按inspection.mode执行一次获准Git。continue-stage只准确暂存repair.paths再inspect；continue-commit只commit --no-edit。unknown/conflict/repairing/awaiting-verification不执行merge；不得stash/reset/abort/选业务一边。Git核定和组合核验分别记录。',
                  })
                : '此前跨树合入安排已结束；没有当前跨树Git写入授权，不从旧对话重做。',
            },
          ],
        });
    }
    const logNotice = this.logNotices.prepare(binding.connection, binding.session.id, input.agent);
    if (logNotice) messages.push(logNotice);
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
        ...(binding.connection.collaborations().currentForSession(binding.session.id)
          ? {
              collaborationId: binding.connection
                .collaborations()
                .currentForSession(binding.session.id)!.id,
            }
          : {}),
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
              reviewResultId: binding.execution.reviewResultId,
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
      this.logNotices.entered(
        binding.connection,
        binding.session.id,
        agent,
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
        record.error = '本次宿主请求未完成，原始错误见关联DSH会话；配置切换与后续请求分别记录';
      binding.connection.saveRequest(record);
      this.collaborationResults.reconcile(binding.connection.snapshot().id, binding.session.id);
      this.assistantControls.reconcile(binding.connection.snapshot().id, binding.session.id);
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
      nativeSelection: native?.model.current() ?? null,
      modelState: connection.modelPolicies().state(sessionId),
      modelChanges: connection.modelPolicies().history(sessionId),
      defaultFallback: connection.roles().find((r) => r.id === session.roleId)!.fallback,
      actualPreset: native ? (this.ctx.agentPresets?.composedPreset(native.ctx) ?? null) : null,
      registeredTools: native ? native.ctx.tools.definitions(native).map((t) => t.name) : null,
      requests: connection.requests(sessionId),
      nativeLoaded: !!native,
      usageAvailability: '每次请求独立保存；null表示宿主未提供',
      unavailableActions: ['审计', '交接保存'],
      officialWorktreesAvailable: this.worktrees.available,
      nativeWorkingDirectory: native ? this.ctx.workingDirectory.get(native.session) : null,
      processRangeObservation: this.ranges.available,
      processRanges: this.ranges.forSession(sessionId),
      sandboxMode: native
        ? (native.session.snapshotEvents().findLast((event) => event.type === 'sandbox/mode')?.data
            .mode ?? null)
        : null,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.worktrees.close();
    await this.localCommits.close();
    await this.worktreeMerges.close();
    await this.models.close();
    await this.decisionRequests.close();
    await this.collaborationResults.close();
    await this.assistantControls.close();
    await this.assistants.close();
    await this.acceptance.close();
    await this.reviewResults.close();
    await this.completions.close();
    await this.projectControl.close();
    await this.controls.close();
    this.ranges.close();
    await this.dispatch.close();
    await this.communication.close();
    await Promise.allSettled([...this.openings.values()]);
    for (const dispose of this.disposers.splice(0).reverse()) await dispose();
    for (const handle of this.handles.splice(0).reverse()) await handle.dispose();
    for (const binding of this.bindings.values()) {
      await binding.skills.dispose();
    }
    this.bindings.clear();
  }
}
