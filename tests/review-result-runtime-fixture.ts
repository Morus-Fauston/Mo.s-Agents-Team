import { randomUUID } from 'node:crypto';
import { reviewResultFixture } from './review-result-fixture.ts';
import { ReviewResultService } from '../src/services/review-result-service.ts';
import type { NativeAgent, NativeContext } from '../src/host/native.ts';
import type { NativeGoalView } from '../src/contracts/execution.ts';
import type { CommunicationService } from '../src/services/chat-service.ts';
const quiet = {
  agentIdle: true,
  inFlightTools: false,
  filesStable: true,
  fileFingerprint: 'unit-only',
  processesComplete: true,
  jobObservations: [],
  note: '单元合成停稳，不是Host',
};
export function resultServiceFixture(
  verification: 'automated' | 'manual' | 'review' = 'automated',
  prechecked = false,
) {
  const f = reviewResultFixture(verification, prechecked),
    agents = new Map<string, NativeAgent>(),
    goals = new Map<string, NativeGoalView>(),
    calls: string[] = [];
  let reviewerQuiet = true;
  const make = (id: string) =>
    ({
      id,
      status: 'idle',
      session: { snapshotEvents: () => [] },
      inbox: { nextStep: [] },
    }) as unknown as NativeAgent;
  const author = make('unit-executor'),
    reviewer = make('unit-result-reviewer');
  agents.set(f.session.id, author);
  agents.set(f.reviewer.id, reviewer);
  goals.set(author.id, {
    id: 'unit-main-goal',
    revision: 1,
    objective: '旧输入',
    phase: 'paused',
    activation: 'disarmed',
    roundsStarted: 1,
    maxGoalRounds: 2,
  });
  goals.set(reviewer.id, {
    id: 'unit-result-review-goal',
    revision: 1,
    objective: '固定版本审阅',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 1,
  });
  const native = {
    goals: {
      get: (agent: NativeAgent) => goals.get(agent.id),
      disarm: (agent: NativeAgent) => {
        calls.push('disarm:' + agent.id);
        const goal = goals.get(agent.id)!;
        goal.activation = 'disarmed';
        return goal;
      },
      pause: (agent: NativeAgent) => {
        calls.push('pause:' + agent.id);
        const goal = goals.get(agent.id)!;
        goal.phase = 'paused';
        goal.activation = 'disarmed';
        goal.revision++;
        return goal;
      },
      edit: (agent: NativeAgent, _ref: unknown, input: { objective: string }) => {
        calls.push('edit:' + agent.id);
        const goal = goals.get(agent.id)!;
        goal.objective = input.objective;
        goal.revision++;
        return goal;
      },
      resume: (agent: NativeAgent) => {
        calls.push('resume:' + agent.id);
        const goal = goals.get(agent.id)!;
        goal.phase = 'active';
        goal.activation = 'armed';
        goal.revision++;
        return goal;
      },
      clear: (agent: NativeAgent) => {
        calls.push('clear:' + agent.id);
        goals.delete(agent.id);
      },
    },
    sessions: { flush: async () => true },
  } as unknown as NativeContext;
  const service = new ReviewResultService(
    f.projects,
    {
      sendReviewResult: async (_project: string, resultId: string, messageId: string) =>
        f.connection.messages().saveReviewResult(resultId, messageId),
      prepareResume: async () => {
        calls.push('prepare-input');
      },
    } as unknown as CommunicationService,
    {
      native,
      epoch: 'unit',
      peek: (_project, session) => agents.get(session),
      openControlled: async (_project, session) => agents.get(session)!,
      async settleReviewer() {
        const goal = goals.get(reviewer.id)!;
        goal.phase = 'paused';
        goal.activation = 'disarmed';
        f.connection.reviews().controlled(f.review.id, '单元审核独立观察', {
          ...quiet,
          processesComplete: reviewerQuiet,
        });
      },
      async inspectMain(_project, _execution, _agent, afterClear) {
        calls.push(afterClear ? 'observe-after-clear' : 'observe-main');
        return quiet;
      },
      async freshExecution() {
        calls.push('fresh-input');
        return { objective: '最新要求及正式退回意见', version: 'unit-current-input' };
      },
      assertWriteScope() {
        calls.push('scope-guard');
      },
    },
  );
  const input = (verdict: 'pass' | 'return') => ({
    operationId: randomUUID(),
    reviewId: f.review.id,
    versionId: f.review.versionId,
    verdict,
    scope: '整票',
    basis: '合成服务用例',
    issues: verdict === 'return' ? ['原范围补充验证'] : [],
    evidencePaths: [],
  });
  return {
    ...f,
    service,
    author,
    auditAgent: reviewer,
    goals,
    calls,
    input,
    setReviewerQuiet: (value: boolean) => {
      reviewerQuiet = value;
    },
    async dispose() {
      await service.close();
      f.close();
    },
  };
}
