import { randomUUID } from 'node:crypto';
import type { ExecutionRecord } from '../src/contracts/execution.ts';
import { localCommitFixture } from './local-commit-fixture.ts';
/** Synthetic native receipts only; Git and immutable review records are real test data. */
export function finishMergeExecution(
  f: ReturnType<typeof localCommitFixture>,
  e: ExecutionRecord,
  verdict: 'pass' | 'return' = 'pass',
) {
  const c = f.c,
    wb = c.workbench();
  const session = c.reserveSession({
    roleId: e.roleId,
    name: '测试主执行',
    purpose: '仅合成原生回执',
    cwd: e.cwd,
  });
  c.executions().sessionReserved(e.id, session.id);
  c.bindSession(session.id, 'unit-' + randomUUID());
  c.executions().sessionPrepared(e.id, session.id);
  wb.allocateCurrentMaterial(session.id);
  c.versions().baseline(e.id);
  c.executions().starting(e.id, 10, { provider: 'unit', model: 'unit' }, '仅服务夹具');
  const goal = 'unit-' + randomUUID();
  c.executions().goalLinked(e.id, {
    id: goal,
    revision: 1,
    objective: '仅服务夹具',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 2,
  });
  c.executions().goalDurable(e.id);
  const requestId = randomUUID();
  c.saveRequest({
    id: requestId,
    executionId: e.id,
    executionContextVersion: 'unit',
    sessionId: session.id,
    nativeAttemptId: 'unit',
    turn: 1,
    step: 1,
    contextVersion: 'unit',
    sources: [],
    skillManifestVersion: 'unit',
    skillCatalogVersion: 'unit',
    loadedSkills: [],
    requestConfiguration: { provider: 'unit', model: 'unit' },
    tools: [],
    reportedModel: 'unit',
    usage: null,
    status: 'completed',
    error: null,
    startedAt: new Date().toISOString(),
  });
  c.executions().requestObserved(session.id, requestId);
  const ticket = wb.getTicket(e.ticketId);
  wb.updateChecklist({ kind: 'session', sessionId: session.id }, ticket.id, {
    operationId: randomUUID(),
    updates: ticket.checklist.map((item) => ({
      id: item.id,
      expectedRevision: item.revision,
      checked: true,
      result: '仅单元合成结果',
    })),
    newLog: {
      title: '夹具',
      content: '仅单元，不作为真实SDK通过',
      type: 'verification',
      references: [],
    },
  });
  const reviewerRole =
    c.roles().find((r) => r.type === 'reviewer') ??
    c.registerRole({
      code: 'REV',
      name: '审阅',
      type: 'reviewer',
      configuration: { provider: 'unit', model: 'unit' },
    });
  const reviews = c.reviews();
  reviews.configure(
    { kind: 'user' },
    { operationId: randomUUID(), reviewerRoleId: reviewerRole.id },
  );
  const completion = reviews.complete(session.id, {
    operationId: randomUUID(),
    summary: '固定版本夹具',
    scope: '本例源码',
    checklistItemIds: ticket.checklist.map((i) => i.id),
  });
  const quiet = {
    agentIdle: true,
    inFlightTools: false,
    filesStable: true,
    fileFingerprint: 'unit',
    processesComplete: true,
    jobObservations: [],
    observedAt: new Date().toISOString(),
    intervalMs: 1000,
    note: '仅合成，不冒充原生停稳',
  };
  reviews.authorPaused(
    completion.reviewId,
    goal,
    c.session(session.id).nativeSessionId!,
    true,
    quiet,
  );
  const reviewer = c.reserveSession({
    roleId: reviewerRole.id,
    name: '指定独审',
    purpose: '仅合成回执',
    cwd: ticket.materialRoot,
  });
  reviews.sessionReserved(completion.reviewId, reviewer.id);
  c.bindSession(reviewer.id, 'unit-' + randomUUID());
  reviews.sessionPrepared(
    completion.reviewId,
    reviewer.id,
    c.session(reviewer.id).nativeSessionId!,
  );
  wb.allocateCurrentMaterial(reviewer.id);
  reviews.materialPrepared(completion.reviewId);
  reviews.armWait(completion.reviewId);
  const reviewGoal = 'unit-' + randomUUID();
  reviews.goalLinked(
    completion.reviewId,
    {
      id: reviewGoal,
      revision: 1,
      objective: '固定版本夹具',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 1,
      maxGoalRounds: 1,
    },
    0,
  );
  reviews.startDurable(completion.reviewId, true, { matches: true, error: null });
  const result = c.reviewResults().submit(
    { kind: 'session', sessionId: reviewer.id },
    {
      operationId: randomUUID(),
      reviewId: completion.reviewId,
      versionId: completion.versionId,
      verdict,
      scope: '本例固定版本',
      basis: '仅合成意见',
      issues: verdict === 'return' ? ['组合检查失败，修正后重新验证和送审'] : [],
      evidencePaths: [],
    },
  );
  reviews.controlled(completion.reviewId, '合成停稳', quiet);
  reviews.closeAfterResult(
    completion.reviewId,
    reviewGoal,
    c.session(reviewer.id).nativeSessionId!,
  );
  const progress = {
    state: 'confirmed' as const,
    note: '仅合成回执',
    at: new Date().toISOString(),
  };
  c.reviewResults().progress(result.id, 'reviewCleanup', progress);
  c.reviewResults().authorObserved(result.id, quiet);
  if (verdict === 'pass') {
    c.reviewResults().progress(result.id, 'authorGoalClear', progress);
    c.reviewResults().closeMain(result.id);
  }
  return {
    version: c.versions().get(completion.versionId),
    result: c.reviewResults().get(result.id),
    session,
  };
}
