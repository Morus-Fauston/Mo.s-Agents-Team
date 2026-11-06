import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import {
  reviewOpinionSchema,
  reviewResultSchema,
  reviewResultRetrySchema,
} from '../contracts/review-results.ts';
import type { ReviewResult } from '../contracts/review-results.ts';
import type { ReviewCatalog } from './review-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
import type { ActionProgress } from '../contracts/completion.ts';
import type { StoppedObservation } from '../contracts/controls.ts';
import { nativeTerminalJobStatuses } from '../contracts/controls.ts';
import type { ControlCatalog } from './control-catalog.ts';
const now = () => new Date().toISOString(),
  pending = () => ({
    state: 'pending' as const,
    note: '业务结果已保存；原生停稳、接续和通知分别办理',
    at: now(),
  });
export function migrateReviewResults(db: DatabaseSync) {
  db.exec(
    `CREATE TABLE review_result(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, review_id TEXT NOT NULL UNIQUE REFERENCES review(id), execution_id TEXT NOT NULL REFERENCES execution(id), version_id TEXT NOT NULL REFERENCES execution_version(id), data TEXT NOT NULL); CREATE TABLE review_result_command(operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, data TEXT NOT NULL); PRAGMA user_version=10;`,
  );
}
/** Immutable formal audit results; native effects never masquerade as part of the SQL transaction. */
export class ReviewResultCatalog {
  private readonly db: DatabaseSync;
  private readonly reviews: ReviewCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly wb: WorkbenchCatalog;
  private readonly sessions: SessionCatalog;
  private readonly controls: ControlCatalog;
  constructor(
    db: DatabaseSync,
    reviews: ReviewCatalog,
    executions: ExecutionCatalog,
    wb: WorkbenchCatalog,
    sessions: SessionCatalog,
    controls: ControlCatalog,
  ) {
    this.db = db;
    this.reviews = reviews;
    this.executions = executions;
    this.wb = wb;
    this.sessions = sessions;
    this.controls = controls;
  }
  get(id: string): ReviewResult {
    const row = this.db.prepare('SELECT data FROM review_result WHERE id=?').get(id);
    if (!row) throw new ProjectError('REVIEW_RESULT_NOT_FOUND', '正式审计意见不存在');
    return reviewResultSchema.parse(JSON.parse(String(row.data)));
  }
  byOperation(operationId: string): ReviewResult | undefined {
    const row = this.db
      .prepare('SELECT id FROM review_result WHERE operation_id=?')
      .get(operationId);
    return row ? this.get(String(row.id)) : undefined;
  }
  retry(actor: WorkbenchActor, id: string, raw: unknown) {
    const input = reviewResultRetrySchema.parse(raw),
      author = this.wb.author(actor);
    if (
      author.kind !== 'user' &&
      (author.roleType !== 'supervisor' ||
        (actor.kind === 'session' &&
          this.sessions.get(actor.sessionId).communicationState !== 'active'))
    )
      throw new ProjectError('REVIEW_RESULT_MANAGER_REQUIRED', '仅用户或实际主管可明确接续原结果');
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ id, input, author }))
      .digest('hex');
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT request_hash FROM review_result_command WHERE operation_id=?')
        .get(input.operationId);
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new ProjectError('REVIEW_RESULT_RETRY_CONFLICT', '接续操作正文或来源冲突');
        return { result: this.get(id), enqueue: false };
      }
      const value = this.current(id, input.expectedControlRevision !== undefined);
      if (value.progress.state === 'confirmed')
        throw new ProjectError('REVIEW_RESULT_ALREADY_HANDLED', '本次结果已办理，不重新执行');
      if (input.expectedControlRevision !== undefined)
        this.controls.resumeReviewResultOnly(
          actor,
          value.executionId,
          value.id,
          input.expectedControlRevision,
          input.operationId,
          input.reason,
        );
      value.progress = { state: 'prepared', note: input.reason, at: now() };
      this.save(value);
      this.db
        .prepare('INSERT INTO review_result_command(operation_id,request_hash,data) VALUES(?,?,?)')
        .run(input.operationId, requestHash, JSON.stringify({ resultId: id }));
      return { result: value, enqueue: true };
    });
  }
  current(id: string, allowStopped = false): ReviewResult {
    const value = this.get(id),
      execution = this.executions.get(value.executionId),
      review = this.reviews.get(value.reviewId),
      ticket = this.wb.getTicket(value.ticketId);
    if (
      review.wait.resultId !== id ||
      review.status !== 'decided' ||
      ticket.currentExecution !== execution.id ||
      ticket.state !== (value.verdict === 'return' ? 'in-progress' : 'review-passed') ||
      execution.failure ||
      !(
        (execution.waitingReviewId === review.id &&
          (execution.lifecycleState === 'waiting' ||
            (allowStopped && execution.lifecycleState === 'paused'))) ||
        (value.verdict === 'return' &&
          execution.reviewResultId === id &&
          (execution.lifecycleState === 'active' ||
            (allowStopped && execution.lifecycleState === 'paused')) &&
          execution.waitingReviewId === null)
      )
    )
      throw new ProjectError(
        'REVIEW_RESULT_NOT_CURRENT',
        '正式结果已不对应当前等待或执行，不复活旧回执',
      );
    // The project intent and authorized controls fence every native effect.
    this.controls.requireDispatch();
    const control = this.controls.activeControl(execution.id);
    if (!allowStopped && control && !(control.action === 'resume' && control.status === 'resumed'))
      throw new ProjectError('REVIEW_RESULT_CONTROLLED', '原执行已有有权控制，结果不解除限制');
    return value;
  }
  private save(value: ReviewResult): ReviewResult {
    const parsed = reviewResultSchema.parse(value);
    this.db
      .prepare('UPDATE review_result SET data=? WHERE id=?')
      .run(JSON.stringify(parsed), parsed.id);
    this.db
      .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
      .run('review-result-changed', parsed.id);
    return parsed;
  }
  progress(
    id: string,
    field: 'progress' | 'reviewCleanup' | 'authorAction' | 'authorGoalClear',
    progress: ActionProgress,
  ): ReviewResult {
    return transaction(this.db, () => {
      const value = this.get(id);
      value[field] = progress;
      return this.save(value);
    });
  }
  notified(id: string, targetSessionId: string, progress: ActionProgress): ReviewResult {
    return transaction(this.db, () => {
      const value = this.get(id),
        notice = value.notifications.find((notice) => notice.targetSessionId === targetSessionId);
      if (!notice) throw new ProjectError('REVIEW_RESULT_TARGET', '不是本次正式结果的投递对象');
      notice.progress = progress;
      return this.save(value);
    });
  }
  authorObserved(id: string, observation: StoppedObservation): ReviewResult {
    return transaction(this.db, () => {
      const value = this.current(id);
      value.authorObservation = observation;
      const proof = this.hasQuietMain(value);
      value.authorAction = {
        state: proof ? 'prepared' : 'unknown',
        note: proof
          ? '原执行完整作业及声明范围已核清；原生接续或清除另验'
          : '原执行作业或声明范围停稳尚未确认',
        at: now(),
      };
      return this.save(value);
    });
  }
  private hasQuietMain(value: ReviewResult): boolean {
    const observation = value.authorObservation,
      jobs = this.controls.jobs(value.executionId);
    return (
      !!observation &&
      observation.agentIdle === true &&
      observation.inFlightTools === false &&
      observation.filesStable === true &&
      observation.processesComplete &&
      observation.jobObservations.length === jobs.length &&
      new Set(observation.jobObservations.map((job) => job.jobId)).size === jobs.length &&
      jobs.every((job) =>
        observation.jobObservations.some(
          (seen) =>
            seen.jobId === job.id &&
            seen.externalStatus === 'gone' &&
            nativeTerminalJobStatuses.includes(seen.nativeStatus),
        ),
      )
    );
  }
  mainIsQuiet(id: string) {
    return this.hasQuietMain(this.get(id));
  }
  admitReturn(id: string, epoch: string, scopeGuard: () => void): ReviewResult {
    return transaction(this.db, () => {
      const value = this.current(id),
        review = this.reviews.get(value.reviewId);
      if (
        value.verdict !== 'return' ||
        review.closure?.state !== 'confirmed' ||
        !this.hasQuietMain(value)
      )
        throw new ProjectError('REVIEW_RETURN_UNPREPARED', '审核及原执行尚未核清，不恢复作者');
      scopeGuard();
      value.authorAction = {
        state: 'prepared',
        note: '已接纳原尝试返修；实际原Goal恢复及持久化另验',
        at: now(),
      };
      this.executions.returnFromReview(value.executionId, value.reviewId, value.id, epoch);
      return this.save(value);
    });
  }
  closeMain(id: string): ReviewResult {
    return transaction(this.db, () => {
      const value = this.current(id),
        review = this.reviews.get(value.reviewId);
      if (
        value.verdict !== 'pass' ||
        value.authorGoalClear?.state !== 'confirmed' ||
        review.closure?.state !== 'confirmed' ||
        !this.hasQuietMain(value)
      )
        throw new ProjectError('REVIEW_CLOSE_UNCONFIRMED', '原执行或审核尚未明确收尾，不释放占用');
      this.executions.closeFromReview(value.executionId, value.reviewId, value.id);
      value.authorAction = {
        state: 'confirmed',
        note: '原执行Goal清除且声明范围已核清，本次执行已收尾，不等于票据完成',
        at: now(),
      };
      value.progress = { ...value.authorAction };
      return this.save(value);
    });
  }
  list(executionId?: string): ReviewResult[] {
    if (executionId) this.executions.get(executionId);
    return (
      executionId
        ? this.db
            .prepare('SELECT id FROM review_result WHERE execution_id=? ORDER BY rowid')
            .all(executionId)
        : this.db.prepare('SELECT id FROM review_result ORDER BY rowid').all()
    ).map((row) => this.get(String(row.id)));
  }
  submit(actor: WorkbenchActor, raw: unknown): ReviewResult {
    const input = reviewOpinionSchema.parse(raw),
      author = this.wb.author(actor);
    if (actor.kind !== 'session' || author.roleType !== 'reviewer')
      throw new ProjectError(
        'DESIGNATED_REVIEWER_REQUIRED',
        '只有当前指定实际独审会话可提交正式意见',
      );
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ input, author }))
      .digest('hex');
    return transaction(this.db, () => {
      const prior = this.db
        .prepare('SELECT id,request_hash FROM review_result WHERE operation_id=?')
        .get(input.operationId);
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new ProjectError('REVIEW_RESULT_CONFLICT', '正式意见操作身份冲突，正文或来源不同');
        return this.get(String(prior.id));
      }
      const review = this.reviews.current(input.reviewId),
        session = this.sessions.get(actor.sessionId),
        completion = this.reviews.completion(review.completionId),
        execution = this.executions.get(review.executionId);
      if (review.versionId !== input.versionId)
        throw new ProjectError('REVIEW_RESULT_VERSION_MISMATCH', '意见版本不是当前固定送审版本');
      if (
        review.sessionId !== actor.sessionId ||
        session.nativeSessionId !== review.nativeSessionId ||
        !review.nativeSessionId ||
        !review.goalId ||
        author.roleId !== review.reviewerRole?.id ||
        completion.sourceSessionId === actor.sessionId ||
        session.communicationState !== 'active'
      )
        throw new ProjectError(
          'DESIGNATED_REVIEWER_REQUIRED',
          '不是本次指定实际独审，不能代填意见',
        );
      if (!['starting', 'active'].includes(review.status))
        throw new ProjectError(
          'REVIEW_RESULT_UNPREPARED',
          '审核尚未实际准备或处于未知，不能提交正式结果',
        );
      const id = randomUUID(),
        value: ReviewResult = {
          id,
          operationId: input.operationId,
          reviewId: review.id,
          completionId: completion.id,
          executionId: execution.id,
          ticketId: review.ticketId,
          versionId: review.versionId,
          previousResultId: this.list(execution.id).at(-1)?.id ?? null,
          author,
          nativeSessionId: review.nativeSessionId,
          verdict: input.verdict,
          scope: input.scope,
          basis: input.basis,
          issues: input.issues,
          evidencePaths: input.evidencePaths,
          progress: pending(),
          reviewCleanup: pending(),
          authorAction: pending(),
          authorGoalClear: null,
          authorObservation: null,
          createdAt: now(),
          notifications: (input.verdict === 'return'
            ? [completion.sourceSessionId]
            : execution.managerSessionIds
          ).map((targetSessionId) => ({
            messageId: randomUUID(),
            targetSessionId,
            content: `MAT正式审计${input.verdict === 'return' ? '退回原执行同次修正' : '通过并交主管核必要验收'}。票据 ${execution.ticketCode}；版本 ${review.versionId}；意见 ${id}。范围及依据从正式意见读取。原生停稳、接续或收尾以分步回执为准；此通知不代表结票或解除上级控制。`,
            progress: pending(),
          })),
        };
      this.db
        .prepare(
          'INSERT INTO review_result(id,operation_id,request_hash,review_id,execution_id,version_id,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.operationId,
          requestHash,
          review.id,
          execution.id,
          review.versionId,
          JSON.stringify(reviewResultSchema.parse(value)),
        );
      this.reviews.signalWait(review.id, actor.sessionId, review.versionId, id);
      this.wb.reviewDecided(actor, review.ticketId, {
        resultId: id,
        reviewId: review.id,
        executionId: execution.id,
        versionId: review.versionId,
        verdict: value.verdict,
        basis: value.basis,
      });
      this.reviews.decided(review.id, id);
      return value;
    });
  }
}
