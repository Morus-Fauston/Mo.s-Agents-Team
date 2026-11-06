import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
export function reviewResultFixture(
  verification: 'automated' | 'manual' | 'review' = 'automated',
  prechecked = false,
) {
  const f = completionFixture(verification),
    reviews = f.connection.reviews();
  if (prechecked)
    f.connection
      .workbench()
      .updateChecklist({ kind: 'session', sessionId: f.session.id }, f.ticket.id, {
        operationId: randomUUID(),
        updates: [
          {
            id: f.ticket.checklist[0]!.id,
            expectedRevision: 1,
            checked: true,
            result: '交付前已有自动化结果',
          },
        ],
        newLog: {
          title: '预先核验',
          content: '仅单元夹具的派审前结果',
          type: 'verification',
          references: [],
        },
      });
  reviews.configure({ kind: 'user' }, { operationId: randomUUID(), reviewerRoleId: f.reviewer.id });
  const completion = reviews.complete(f.session.id, {
    operationId: randomUUID(),
    summary: '待正式审计的单元交付',
    scope: '成果.txt',
  });
  reviews.authorPaused(completion.reviewId, 'unit-main-goal', 'unit-executor', true, {
    agentIdle: true,
    inFlightTools: false,
    filesStable: true,
    fileFingerprint: 'unit',
    processesComplete: true,
    jobObservations: [],
    note: '仅单元合成证明，不冒充真实宿主',
  });
  const reviewer = f.connection.reserveSession({
    roleId: f.reviewer.id,
    name: '正式独审夹具',
    purpose: '10原子结果用例',
    cwd: f.ticket.materialRoot,
  });
  reviews.sessionReserved(completion.reviewId, reviewer.id);
  f.connection.bindSession(reviewer.id, 'unit-result-reviewer');
  reviews.sessionPrepared(completion.reviewId, reviewer.id, 'unit-result-reviewer');
  f.connection.workbench().allocateCurrentMaterial(reviewer.id);
  reviews.materialPrepared(completion.reviewId);
  reviews.armWait(completion.reviewId);
  reviews.goalLinked(
    completion.reviewId,
    {
      id: 'unit-result-review-goal',
      revision: 1,
      objective: '仅固定版本独审',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 1,
      maxGoalRounds: 1,
    },
    0,
  );
  reviews.startDurable(completion.reviewId, true, { matches: true, error: null });
  return {
    ...f,
    completion,
    review: reviews.get(completion.reviewId),
    reviewer: f.connection.session(reviewer.id),
  };
}
