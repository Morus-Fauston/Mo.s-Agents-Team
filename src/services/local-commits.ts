import { z } from 'zod';
import type { ProjectService } from './project-service.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { SavedMessage } from '../contracts/chat.ts';
import type { LocalCommitRecord, LocalCommitQuiescence } from '../contracts/local-commits.ts';
import {
  localCommitArrangeSchema,
  localCommitInspectSchema,
  localCommitReportSchema,
  localCommitReconcileSchema,
} from '../contracts/local-commits.ts';
import { captureLocalGit, assertLocalGitReady, verifyLocalCommit } from './local-git.ts';
import { ProjectError } from './errors.ts';
import { withinPath } from './write-scopes.ts';
export const localCommitPreviewSchema = z
  .object({
    repository: z.string().min(1),
    files: z.array(z.string().min(1)).min(1).max(512),
    kind: z.enum(['baseline', 'commit']),
  })
  .strict();
export interface LocalCommitObservation extends LocalCommitQuiescence {
  nativeSessionId: string;
  epoch: string;
  boundary: number;
  ranges: NonNullable<LocalCommitRecord['native']>['ranges'];
}
export interface LocalCommitHost {
  inspect(
    project: string,
    session: string,
    callId?: string,
    value?: LocalCommitRecord,
  ): LocalCommitObservation;
  allowed(project: string, session: string): boolean;
  notify(project: string, arrangementId: string, noticeId: string): Promise<SavedMessage>;
}
interface GitReader {
  capture: typeof captureLocalGit;
  ready: typeof assertLocalGitReady;
  verify: typeof verifyLocalCommit;
}
export class LocalCommitService {
  private readonly projects: ProjectService;
  private readonly host: LocalCommitHost;
  private readonly git: GitReader;
  private readonly runs = new Set<Promise<unknown>>();
  private readonly notifying = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    projects: ProjectService,
    host: LocalCommitHost,
    git: GitReader = {
      capture: captureLocalGit,
      ready: assertLocalGitReady,
      verify: verifyLocalCommit,
    },
  ) {
    this.projects = projects;
    this.host = host;
    this.git = git;
  }
  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new ProjectError('LOCAL_COMMIT_CLOSED', '本地事项服务正在关闭'));
    const promise = run();
    this.runs.add(promise);
    return promise.finally(() => this.runs.delete(promise));
  }
  private manager(project: string, actor: WorkbenchActor, repository?: string) {
    const c = this.projects.forProject(project);
    c.localCommits().requireManager(actor);
    if (
      repository &&
      ![
        c.snapshot().root,
        ...c
          .executions()
          .list()
          .flatMap((e) => e.additionalRepositories),
      ].some((root) => withinPath(root, repository))
    )
      throw new ProjectError('LOCAL_COMMIT_REPOSITORY', '只核对固定项目或已明确其他仓库');
    return c;
  }
  preview(project: string, actor: WorkbenchActor, raw: unknown) {
    return this.track(async () => {
      const input = localCommitPreviewSchema.parse(raw);
      this.manager(project, actor, input.repository);
      const plan = await this.git.capture(input.repository, input.files, input.kind);
      this.manager(project, actor, plan.repository);
      return plan;
    });
  }
  arrange(project: string, actor: WorkbenchActor, raw: unknown) {
    return this.track(async () => {
      const input = localCommitArrangeSchema.parse(raw),
        c = this.manager(project, actor, input.repository),
        catalog = c.localCommits(),
        old = catalog.existingArrangement(actor, input);
      if (old) return old;
      c.controls().requireDispatch();
      if (!this.host.allowed(project, input.sessionId))
        throw new ProjectError('LOCAL_COMMIT_CONTROLLED', '提交入口受控制，不安排新工作');
      const before = this.host.inspect(project, input.sessionId);
      if (before.state !== 'confirmed')
        throw new ProjectError('LOCAL_COMMIT_NATIVE_BUSY', before.note);
      const plan = await this.git.capture(input.repository, input.files, input.kind);
      this.manager(project, actor, plan.repository);
      c.controls().requireDispatch();
      if (!this.host.allowed(project, input.sessionId))
        throw new ProjectError('LOCAL_COMMIT_CONTROLLED', '核对期间入口已受控制');
      const after = this.host.inspect(project, input.sessionId);
      if (
        after.state !== 'confirmed' ||
        before.nativeSessionId !== after.nativeSessionId ||
        before.epoch !== after.epoch
      )
        throw new ProjectError('LOCAL_COMMIT_NATIVE_BUSY', '核对期间原生会话或在途状态变化');
      const value = catalog.arrange(actor, input, plan, {
        nativeSessionId: after.nativeSessionId,
        epoch: after.epoch,
        boundary: after.boundary,
        ranges: after.ranges,
      });
      await this.notify(project, value.id);
      return catalog.get(actor, value.id);
    });
  }
  inspect(project: string, actor: WorkbenchActor, id: string, raw: unknown, callId?: string) {
    return this.track(async () => {
      const input = localCommitInspectSchema.parse(raw),
        c = this.projects.forProject(project),
        catalog = c.localCommits(),
        value = catalog.get(actor, id);
      this.worker(actor, value);
      if (['completed', 'cancelled'].includes(value.status)) return value;
      if (value.status === 'unknown')
        throw new ProjectError(
          'LOCAL_COMMIT_UNKNOWN',
          '原Git结果未知，先reconcile回读，不重新授权提交',
        );
      let note = '原范围、基线和索引核对一致，只办理此明确本地提交',
        ready = true;
      try {
        c.controls().requireDispatch();
        if (!this.host.allowed(project, value.committerSessionId)) throw new Error('原入口受控制');
        const before = this.host.inspect(project, value.committerSessionId, callId, value);
        if (before.state !== 'confirmed') throw new Error(before.note);
        await this.git.ready(value.plan);
        this.worker(actor, catalog.get(actor, id));
        c.controls().requireDispatch();
        if (!this.host.allowed(project, value.committerSessionId))
          throw new Error('核对期间入口受控制');
        const after = this.host.inspect(
          project,
          value.committerSessionId,
          callId,
          catalog.get(actor, id),
        );
        if (after.state !== 'confirmed') throw new Error(after.note);
      } catch (error) {
        ready = false;
        note = error instanceof Error ? error.message : '现场核对未知';
      }
      return catalog.inspected(actor, id, input, {
        ready,
        fingerprint: ready ? value.plan.fingerprint : null,
        note,
        observedAt: new Date().toISOString(),
      });
    });
  }
  private worker(actor: WorkbenchActor, value: LocalCommitRecord) {
    if (actor.kind !== 'session' || actor.sessionId !== value.committerSessionId)
      throw new ProjectError('LOCAL_COMMIT_WORKER', '仅原提交类型会话办理原回报');
  }
  private async proof(project: string, value: LocalCommitRecord, callId?: string, commit?: string) {
    const before = this.host.inspect(project, value.committerSessionId, callId, value);
    const proof = await this.git.verify(value.plan, commit);
    const latest = this.projects.forProject(project).localCommits().get({ kind: 'user' }, value.id),
      after = this.host.inspect(project, value.committerSessionId, callId, latest);
    const quiescence: LocalCommitQuiescence =
      before.state === 'confirmed' &&
      after.state === 'confirmed' &&
      before.nativeSessionId === after.nativeSessionId &&
      before.epoch === after.epoch
        ? after
        : {
            state: 'unknown',
            note:
              '提交对象与在途分别核验；' + (before.state === 'unknown' ? before.note : after.note),
            observedAt: after.observedAt,
          };
    return { proof, quiescence };
  }
  report(project: string, actor: WorkbenchActor, id: string, raw: unknown, callId?: string) {
    return this.track(async () => {
      const input = localCommitReportSchema.parse(raw),
        catalog = this.projects.forProject(project).localCommits(),
        value = catalog.get(actor, id);
      this.worker(actor, value);
      if (['completed', 'cancelled'].includes(value.status)) return value;
      const observed = await this.proof(project, value, callId, input.commit);
      const result = catalog.report(actor, id, input, observed.proof, observed.quiescence);
      await this.notify(project, id);
      return catalog.get(actor, result.id);
    });
  }
  reconcile(project: string, actor: WorkbenchActor, id: string, raw: unknown, callId?: string) {
    return this.track(async () => {
      const input = localCommitReconcileSchema.parse(raw),
        catalog = this.projects.forProject(project).localCommits(),
        value = catalog.get(actor, id);
      if (
        actor.kind !== 'session' ||
        ![value.managerSessionId, value.committerSessionId].includes(actor.sessionId)
      )
        throw new ProjectError('LOCAL_COMMIT_RECONCILE', '只有原主管或提交者可核对');
      if (['completed', 'cancelled'].includes(value.status)) return value;
      const observed = await this.proof(
        project,
        value,
        actor.sessionId === value.committerSessionId ? callId : undefined,
      );
      catalog.reconcile(actor, id, input, observed.proof, observed.quiescence);
      await this.notify(project, id);
      return catalog.get(actor, id);
    });
  }
  cancel(project: string, actor: WorkbenchActor, id: string, raw: unknown) {
    return this.track(async () => {
      const input = localCommitReconcileSchema.parse(raw),
        c = this.manager(project, actor),
        catalog = c.localCommits(),
        value = catalog.get(actor, id);
      if (actor.kind !== 'session' || actor.sessionId !== value.managerSessionId)
        throw new ProjectError('LOCAL_COMMIT_CANCEL', '仅原主管撤销安排');
      if (['completed', 'cancelled'].includes(value.status)) return value;
      const observed = await this.proof(project, value, undefined);
      this.manager(project, actor);
      if (
        observed.proof.state !== 'not-observed' ||
        observed.proof.currentHead !== value.plan.head ||
        observed.quiescence.state !== 'confirmed'
      )
        throw new ProjectError(
          'LOCAL_COMMIT_CANCEL',
          'Git对象或在途尚未核定，先核对原结果，不撤销后重做',
        );
      catalog.cancel(actor, id, input, observed.proof, observed.quiescence);
      await this.notify(project, id);
      return catalog.get(actor, id);
    });
  }
  retry(project: string, actor: WorkbenchActor, id: string) {
    return this.track(async () => {
      const catalog = this.projects.forProject(project).localCommits(),
        value = catalog.get(actor, id);
      if (
        actor.kind !== 'session' ||
        ![value.managerSessionId, value.committerSessionId].includes(actor.sessionId)
      )
        throw new ProjectError('LOCAL_COMMIT_NOTICE', '仅原责任方补投原通知');
      await this.notify(project, id);
      return catalog.get(actor, id);
    });
  }
  private async notify(project: string, id: string) {
    const existing = this.notifying.get(id);
    if (existing) return existing;
    const run = (async () => {
      const c = this.projects.forProject(project),
        catalog = c.localCommits();
      for (const notice of catalog.get({ kind: 'user' }, id).notices) {
        if (notice.state === 'confirmed' || !catalog.isCurrentNotice(notice.id)) continue;
        try {
          const saved = await this.host.notify(project, id, notice.id);
          catalog.noticeResult(id, notice.id, saved.receipt);
        } catch (error) {
          catalog.noticeFailed(
            id,
            notice.id,
            error instanceof Error ? error.message : '通知结果未知',
          );
        }
      }
    })();
    this.notifying.set(id, run);
    try {
      await run;
    } finally {
      if (this.notifying.get(id) === run) this.notifying.delete(id);
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.runs, ...this.notifying.values()]);
  }
}
