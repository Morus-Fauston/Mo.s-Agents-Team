import { randomUUID, createHash } from 'node:crypto';
import { dispatchInputSchema, nativeGoalSchema } from '../contracts/execution.ts';
import type { ExecutionRecord, NativeGoalView } from '../contracts/execution.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { SessionInput, SessionRecord } from '../contracts/sessions.ts';
import type { ChatInput, SavedMessage } from '../contracts/chat.ts';
import { executionConfigurationSchema } from '../contracts/project.ts';
import type { NativeAgent, NativeEvent, NativeMessage } from '../host/native.ts';
import type { ProjectService } from './project-service.ts';
import { ProjectError } from './errors.ts';
import { messageIdentity } from './message-presentation.ts';
import { canonicalDirectory, scopesOverlap } from './write-scopes.ts';
export interface DispatchHost {
  create(
    projectId: string,
    input: SessionInput,
    onReserved: (session: SessionRecord) => void,
  ): Promise<SessionRecord>;
  open(projectId: string, sessionId: string): Promise<NativeAgent>;
  peek(projectId: string, sessionId: string): NativeAgent | undefined;
  directory(agent: NativeAgent): string;
  ensureDirectory(agent: NativeAgent): Promise<string>;
  setDirectory(agent: NativeAgent, cwd: string): Promise<string>;
  getGoal(agent: NativeAgent): NativeGoalView | undefined;
  createGoal(
    agent: NativeAgent,
    input: { objective: string; maxGoalRounds?: number },
  ): NativeGoalView;
  flush(agent: NativeAgent): Promise<boolean>;
  notify(projectId: string, input: ChatInput): Promise<SavedMessage>;
}
export class DispatchService {
  readonly epoch = randomUUID();
  private readonly projects: ProjectService;
  private readonly host: DispatchHost;
  private closed = false;
  private readonly attached = new Set<string>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly notifications = new Map<string, Promise<void>>();
  constructor(projects: ProjectService, host: DispatchHost) {
    this.projects = projects;
    this.host = host;
    for (const entry of projects.list()) if (!('unavailable' in entry)) this.catalog(entry.id);
  }
  private catalog(projectId: string) {
    const catalog = this.projects.forProject(projectId).executions();
    if (!this.attached.has(projectId)) {
      this.attached.add(projectId);
      catalog.hostAttached(this.epoch);
    }
    return catalog;
  }
  private globalGuard(projectId: string, scopes: string[]): void {
    for (const entry of this.projects.list()) {
      if ('unavailable' in entry || entry.id === projectId) continue;
      for (const value of this.projects.forProject(entry.id).executions().list())
        if (
          value.writeOccupancy !== 'released' &&
          value.writeScopes.some((old) => scopes.some((scope) => scopesOverlap(old, scope)))
        )
          throw new ProjectError(
            'WRITE_SCOPE_BUSY',
            '写入范围与本插件另一项目的已登记执行冲突；未知占用不释放',
          );
    }
  }
  dispatch(projectId: string, actor: WorkbenchActor, raw: unknown): ExecutionRecord {
    if (this.closed) throw new ProjectError('DISPATCH_CLOSED', '派工服务正在关闭');
    this.projects.forProject(projectId).controls().requireDispatch();
    const input = dispatchInputSchema.parse(raw);
    const catalog = this.catalog(projectId),
      result = catalog.register(actor, input, this.epoch, (scopes) =>
        this.globalGuard(projectId, scopes),
      );
    if (result.isNew) {
      const job = Promise.resolve().then(() => this.start(projectId, result.record.id));
      this.jobs.set(result.record.id, job);
      void job.finally(() => this.jobs.delete(result.record.id)).catch(() => {});
    }
    return result.record;
  }
  private async start(projectId: string, id: string): Promise<void> {
    const connection = this.projects.forProject(projectId),
      catalog = this.catalog(projectId);
    let mayHaveStarted = false;
    try {
      let value = catalog.get(id);
      const requireStart = () => {
        connection.controls().requireDispatch();
        if (connection.controls().activeControl(id))
          throw new ProjectError('EXECUTION_CONTROLLED', '准备期间已接纳控制，未启动新Goal');
      };
      requireStart();
      if (this.closed) throw new ProjectError('DISPATCH_CLOSED', '宿主正在关闭，未继续启动');
      let session: SessionRecord;
      if (value.sessionId) {
        session = connection.session(value.sessionId);
        await this.host.open(projectId, session.id);
        catalog.sessionPrepared(id, session.id);
      } else {
        const name = value.ticketCode + ' · ' + value.name;
        if (name.length > 160)
          throw new ProjectError(
            'SESSION_NAME_BUDGET',
            '票号与用途合成名称超过160字，请缩短用途；未截断',
          );
        session = await this.host.create(
          projectId,
          {
            roleId: value.roleId,
            name,
            purpose: 'MAT正式单票主执行：' + value.ticketCode,
            cwd: value.cwd,
            ...(value.requestedConfiguration
              ? { configuration: value.requestedConfiguration }
              : {}),
          },
          (reserved) => catalog.sessionReserved(id, reserved.id),
        );
        catalog.sessionPrepared(id, session.id);
      }
      if (this.closed)
        throw new ProjectError('DISPATCH_CLOSED', '会话已准备但宿主正在关闭，未继续启动');
      const agent = await this.host.open(projectId, session.id);
      if (agent.status !== 'idle' || agent.inbox.nextStep.length > 0)
        throw new ProjectError(
          'SESSION_PREVIOUS_INPUT',
          '原会话有在途或未核对输入，不悄悄接管旧工作',
        );
      const oldGoal = this.host.getGoal(agent);
      if (oldGoal && oldGoal.phase !== 'complete')
        throw new ProjectError('OLD_GOAL_UNFINISHED', '现有会话仍有未收尾原生Goal，不能改绑新工作');
      const actualCwd =
        value.cwdMode === 'explicit'
          ? await this.host.setDirectory(agent, value.cwd)
          : await this.host.ensureDirectory(agent);
      catalog.resolveWorkingDirectory(id, actualCwd, (scopes) =>
        this.globalGuard(projectId, scopes),
      );
      value = catalog.get(id);
      if (value.requestedConfiguration) agent.model.select(value.requestedConfiguration);
      const configuration = executionConfigurationSchema.parse(agent.model.current());
      const domain = connection.workbench().allocateCurrentMaterial(session.id);
      const baseline = connection.versions().baseline(id);
      const ticket = connection.workbench().getTicket(value.ticketId);
      const objective = [
        'MAT本次正式执行。目标与权限仅限以下持久记录，不能从旧会话或Goal扩围。',
        JSON.stringify({
          executionId: value.id,
          dispatchId: value.dispatchId,
          ticket: value.ticketCode,
          ticketRevision: value.ticketRevision,
          goal: ticket.goal,
          included: ticket.included,
          excluded: ticket.excluded,
          additionalRequirements: value.requirements,
          checklist: ticket.checklist.map((item) => ({
            id: item.id,
            revision: item.revision,
            condition: item.condition,
            verification: item.verification,
          })),
          dependencies: ticket.dependencies,
          reviewedDependencies: value.dependencyEvidence,
          cwd: value.cwd,
          writeScopes: value.writeScopes,
          materialReadRoot: ticket.materialRoot,
          materialWriteDomain: domain.path,
          dispatchBaseline: {
            id: baseline.id,
            fingerprint: baseline.snapshot.fingerprint,
            roots: baseline.snapshot.roots.map((root) => ({
              root: root.root,
              kind: root.kind,
              head: root.head,
              tree: root.tree,
            })),
          },
          managers: value.managerSessionIds,
        }),
        '亲自执行本票。按需读取原票据及Log，不全量复述历史。完成和挂起使用平台正式交回；普通回复、原生Goal和idle不代表票据已完成。未经授权不提交或推送。',
      ].join('\n');
      if (Buffer.byteLength(objective) > 65536)
        throw new ProjectError(
          'EXECUTION_CONTEXT_BUDGET',
          '本次完整目标超出启动预算，拒绝截断后开工',
        );
      const boundary = Math.max(0, ...agent.session.snapshotEvents().map((event) => event.seq));
      catalog.starting(id, boundary, configuration, objective);
      const latestGoal = this.host.getGoal(agent);
      if (latestGoal && latestGoal.phase !== 'complete')
        throw new ProjectError('OLD_GOAL_UNFINISHED', '准备期间出现未收尾Goal，未替换');
      if (this.closed) throw new ProjectError('DISPATCH_CLOSED', '宿主关闭前未武装新Goal');
      requireStart();
      mayHaveStarted = true;
      const goal = this.host.createGoal(agent, {
        objective,
        ...(value.maxGoalRounds !== null ? { maxGoalRounds: value.maxGoalRounds } : {}),
      });
      catalog.goalLinked(id, goal);
      if (!(await this.host.flush(agent)))
        throw new ProjectError(
          'GOAL_DURABILITY_UNCONFIRMED',
          '宿主未确认Goal持久接纳；保留原Goal身份核对，不另开执行',
        );
      catalog.goalDurable(id);
    } catch (error) {
      if (
        error instanceof ProjectError &&
        ['PROJECT_NOT_STARTED', 'EXECUTION_CONTROLLED', 'PROJECT_OR_EXECUTION_CONTROLLED'].includes(
          error.code,
        )
      )
        return;
      const value = catalog.get(id);
      const unknown =
        mayHaveStarted ||
        this.closed ||
        (error instanceof ProjectError && error.code === 'SESSION_PREVIOUS_INPUT');
      catalog.fail(id, {
        code: error instanceof ProjectError ? error.code : 'HOST_START_FAILED',
        message:
          error instanceof ProjectError
            ? error.message
            : '宿主启动接缝未完成，原始记录见关联DSH会话；未自动换模或重派',
        unknown,
      });
      if (!this.closed) await this.publishProblems(projectId, value.id);
    }
  }
  private async publishProblems(projectId: string, id: string): Promise<void> {
    const catalog = this.catalog(projectId),
      value = catalog.prepareNotifications(id, (record, target) => ({
        messageId: messageIdentity('execution-problem:' + record.failure!.id + ':' + target),
        content: `MAT平台观测：${record.failure!.unknown ? '派工或执行结果未知' : '执行宿主异常或启动受阻'}。\n派工 ${record.dispatchId}\n执行 ${record.id}\n票据 ${record.ticketCode}\n当时原因：${record.failure!.message}\n已发生操作和写入占用仍按执行记录核对；本通知不证明外部作业停稳，不得盲目另开替代执行。请用执行查询查看当前事实。`,
      }));
    for (const notice of value.notifications) {
      if (notice.state === 'saved') continue;
      const key = id + ':' + notice.messageId;
      if (this.notifications.has(key)) {
        await this.notifications.get(key);
        continue;
      }
      const job = (async () => {
        try {
          const saved = await this.host.notify(projectId, {
            id: notice.messageId,
            target: notice.targetSessionId,
            content: notice.content,
          });
          catalog.notificationResult(id, notice.targetSessionId, 'saved', saved.receipt.error);
        } catch (error) {
          catalog.notificationResult(
            id,
            notice.targetSessionId,
            'unavailable',
            error instanceof Error ? error.message : '通知未确认接纳',
          );
        }
      })();
      this.notifications.set(key, job);
      try {
        await job;
      } finally {
        this.notifications.delete(key);
      }
    }
  }
  observe(projectId: string, sessionId: string, agent: NativeAgent, event: NativeEvent): void {
    const catalog = this.catalog(projectId),
      value = catalog.currentForSession(sessionId);
    if (
      !value ||
      value.hostEpoch !== this.epoch ||
      value.nativeSessionId !== agent.id ||
      this.closed
    )
      return;
    try {
      if (event.type === 'step/start') {
        catalog.stepStarted(sessionId, event);
        catalog.settleEndedSteps(value.id, Number(event.data.turn), Number(event.data.step));
      } else if (event.type === 'step/end') {
        catalog.stepEnded(sessionId, event);
      } else if (event.type === 'turn/end') {
        catalog.turnEnded(sessionId, event);
        if ((event.data.reason as { kind?: string } | undefined)?.kind === 'completed')
          catalog.settleEndedSteps(value.id, Number(event.data.turn));
        if (catalog.get(value.id).failure)
          void this.publishProblems(projectId, value.id).catch(() => {});
      } else if (event.type === 'tool/call' || event.type === 'tool/result')
        catalog.toolObserved(sessionId, event);
    } catch (error) {
      this.observationFailed(projectId, value.id, error);
    }
  }
  hostError(
    projectId: string,
    sessionId: string,
    agent: NativeAgent,
    input: { turn?: number; step?: number; error: unknown },
  ): void {
    const catalog = this.catalog(projectId),
      value = catalog.currentForSession(sessionId);
    if (
      !value ||
      value.hostEpoch !== this.epoch ||
      value.nativeSessionId !== agent.id ||
      this.closed
    )
      return;
    try {
      const error = input.error as { code?: unknown } | null;
      catalog.nativeError(sessionId, {
        code: typeof error?.code === 'string' ? error.code : 'NATIVE_AGENT_ERROR',
        ...(input.turn === undefined ? {} : { turn: input.turn }),
        ...(input.step === undefined ? {} : { step: input.step }),
      });
      void this.publishProblems(projectId, value.id).catch(() => {});
    } catch (error) {
      this.observationFailed(projectId, value.id, error);
    }
  }
  private observationFailed(projectId: string, id: string, error: unknown): void {
    try {
      this.catalog(projectId).fail(id, {
        code: 'OBSERVATION_UNCONFIRMED',
        message:
          error instanceof ProjectError
            ? error.message
            : '执行观测未完整保存，请核对原会话，未释放写域',
        unknown: true,
      });
      if (!this.closed) void this.publishProblems(projectId, id).catch(() => {});
    } catch {
      /* The original host log remains authoritative when the project database is unavailable. */
    }
  }
  requestObserved(projectId: string, sessionId: string, id: string): void {
    const catalog = this.catalog(projectId),
      value = catalog.currentForSession(sessionId);
    if (!value || value.hostEpoch !== this.epoch || this.closed) return;
    try {
      catalog.requestObserved(sessionId, id);
    } catch (error) {
      this.observationFailed(projectId, value.id, error);
    }
  }
  goalObserved(projectId: string, sessionId: string, agent: NativeAgent): void {
    if (this.closed) return;
    const catalog = this.catalog(projectId),
      value = catalog.currentForSession(sessionId);
    if (!value || value.hostEpoch !== this.epoch) return;
    try {
      const goal = this.host.getGoal(agent);
      if (goal) catalog.goalObserved(sessionId, goal);
    } catch (error) {
      this.observationFailed(projectId, value.id, error);
    }
  }
  context(
    projectId: string,
    sessionId: string,
    cwd: string,
  ): { message: NativeMessage; version: string; executionId: string } | undefined {
    const catalog = this.catalog(projectId),
      value = catalog.currentForSession(sessionId);
    if (!value) return undefined;
    if (
      value.hostEpoch !== this.epoch ||
      value.detachedAt ||
      !value.goalId ||
      value.lifecycleState !== 'active' ||
      value.failure !== null
    )
      throw new ProjectError(
        'EXECUTION_NOT_ACTIVE',
        '本次执行未在当前宿主确认可推进，普通消息不恢复旧执行',
      );
    if (canonicalDirectory(cwd) !== canonicalDirectory(value.cwd))
      throw new ProjectError(
        'EXECUTION_CWD_CHANGED',
        '当前源码目录已偏离本次派工，身份不变但不能借目录切换扩围',
      );
    const connection = this.projects.forProject(projectId),
      ticket = connection.workbench().getTicket(value.ticketId),
      domain = connection
        .workbench()
        .materialDomains(ticket.id)
        .find((domain) => domain.referenceId === value.id && domain.sessionId === sessionId);
    if (!domain?.available)
      throw new ProjectError(
        'EXECUTION_MATERIAL_UNAVAILABLE',
        '本次材料写域缺件或未确认，不悄悄换域继续',
      );
    const body =
      'MAT当前执行事实。以下现行记录优先于旧叙述和旧一次性要求；方法与Goal不产生额外权限。\n' +
      JSON.stringify({
        executionId: value.id,
        dispatchId: value.dispatchId,
        ticketId: ticket.id,
        ticketCode: ticket.code,
        requirementsRevision: ticket.revision,
        goal: ticket.goal,
        included: ticket.included,
        excluded: ticket.excluded,
        requirements: value.requirements,
        checklist: ticket.checklist.map((item) => ({
          id: item.id,
          revision: item.revision,
          condition: item.condition,
          verification: item.verification,
        })),
        dependencies: ticket.dependencies,
        reviewedDependencies: value.dependencyEvidence,
        cwd: value.cwd,
        writeScopes: value.writeScopes,
        materialReadRoot: ticket.materialRoot,
        materialWriteDomain: domain.path,
        managerSessionIds: value.managerSessionIds,
        control: (() => {
          const control = connection.controls().activeControl(value.id);
          return control
            ? {
                id: control.id,
                revision: control.revision,
                action: control.action,
                status: control.status,
                reason: control.reason,
                content: control.content,
                reportSaved: !!control.report,
              }
            : null;
        })(),
        goalId: value.goalId,
        completionPolicy:
          '普通消息和idle不结票；按平台正式交回及后续审阅办理，当前不自行批准或假填人工项。',
      });
    if (Buffer.byteLength(body) > 65536)
      throw new ProjectError(
        'EXECUTION_CONTEXT_BUDGET',
        '当前完整票据输入超出预算，不能截断授权或要求',
      );
    const version = createHash('sha256').update(body).digest('hex');
    return {
      executionId: value.id,
      version,
      message: {
        id: messageIdentity('execution-context:' + value.id + ':' + version),
        role: 'user',
        source: { kind: 'mat-execution-context', executionId: value.id, version },
        content: [{ type: 'text', text: body }],
      },
    };
  }
  query(projectId: string, id?: string) {
    const connection = this.projects.forProject(projectId),
      catalog = this.catalog(projectId);
    if (!id) return catalog.list();
    const record = catalog.get(id),
      agent = record.sessionId ? this.host.peek(projectId, record.sessionId) : undefined;
    let goal: NativeGoalView | null = null,
      goalError: string | null = null;
    if (agent)
      try {
        goal = this.host.getGoal(agent) ?? null;
      } catch (error) {
        goalError = error instanceof Error ? error.message : 'Goal不可读取';
      }
    const requestIds = new Set(catalog.steps(record.id).flatMap((step) => step.requestIds));
    if (record.firstRequestId) requestIds.add(record.firstRequestId);
    return {
      record,
      steps: catalog.steps(record.id),
      events: catalog.events(record.id),
      session: record.sessionId ? connection.session(record.sessionId) : null,
      native: {
        loaded: !!agent,
        status: agent?.status ?? null,
        cwd: agent ? this.host.directory(agent) : null,
        selection: agent?.model.current() ?? null,
        goal: goal ? nativeGoalSchema.parse(goal) : null,
        goalError,
        lastGoalSnapshot: record.goalSnapshot,
      },
      requests: record.sessionId
        ? connection.requests(record.sessionId).filter((request) => requestIds.has(request.id))
        : [],
      materials: connection
        .workbench()
        .materialDomains(record.ticketId)
        .filter((domain) => domain.referenceId === record.id),
      control: {
        revision: connection.controls().revision(record.id),
        controls: connection.controls().list(record.id),
        jobs: connection.controls().jobs(record.id),
      },
      unavailableActions: ['正式审阅意见和结票待10接入'],
      coordinationBasis: '当前插件可取得的声明写域；不是OS文件锁或外部作业停稳证明',
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.jobs.values()]);
    await Promise.allSettled([...this.notifications.values()]);
    for (const entry of this.projects.list())
      if (!('unavailable' in entry))
        this.projects.forProject(entry.id).executions().detached(this.epoch);
  }
}
