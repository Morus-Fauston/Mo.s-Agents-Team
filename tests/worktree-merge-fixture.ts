import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { localCommitFixture } from './local-commit-fixture.ts';
import { inspectWorktreeSource } from '../src/services/local-git.ts';
/** Real E-drive Git plus synthetic native receipts, only for service/catalog tests. */
export async function worktreeMergeFixture(commitSourceBeforeReview = true) {
  const f = localCommitFixture(),
    c = f.c,
    wb = c.workbench(),
    user = { kind: 'user' as const },
    manager = { kind: 'session' as const, sessionId: f.manager.id };
  try {
    f.write('.git/info/exclude', '.TEAM/\n.agents/\n');
    f.git('add', '--', 'a.txt', 'keep.txt');
    f.git('commit', '-m', 'approved fixture baseline');
    const phase = wb.createPhase(user, {
      operationId: randomUUID(),
      name: '合入服务',
      goal: '正式版本绑定',
      basis: '合成原生回执的服务夹具',
    });
    wb.openPhase(user, phase.id, { operationId: randomUUID(), reason: '仅单元' });
    const category = wb.createCategory(user, {
      operationId: randomUUID(),
      code: 'MER',
      name: '合入',
    });
    const ticket = (title: string) =>
      wb.createTicket(user, {
        operationId: randomUUID(),
        phaseId: phase.id,
        categoryId: category.id,
        title,
        goal: '固定版本与Git对应',
        included: '本例源码',
        excluded: '不声明实际模型/设备通过',
        conditions: [{ condition: '固定源码', verification: 'automated' }],
      });
    const sourceTicket = ticket('源整票'),
      combinationTicket = ticket('组合验证'),
      sourcePath = join(f.root, '.agents/worktrees/source');
    const sourceWorktree = c.worktrees().reserve(
      manager,
      {
        operationId: randomUUID(),
        ticketId: sourceTicket.id,
        repository: f.root,
        name: 'source',
        basis: '仅单元原生适配夹具',
      },
      await inspectWorktreeSource(f.root),
      'unit-local-manager',
      f.root,
      sourcePath,
    );
    f.git('worktree', 'add', '-b', 'source', sourcePath, 'HEAD');
    c.worktrees().ready(
      sourceWorktree.id,
      sourcePath,
      'source',
      f.git('-C', sourcePath, 'rev-parse', 'HEAD'),
      true,
    );
    writeFileSync(join(sourcePath, 'a.txt'), 'reviewed source fixture\n');
    if (commitSourceBeforeReview) {
      f.git('-C', sourcePath, 'add', '--', 'a.txt');
      f.git('-C', sourcePath, 'commit', '-m', 'source before reviewed version');
    }
    const sourceCommit = f.git('-C', sourcePath, 'rev-parse', 'HEAD');
    const execution = c.executions().register(
      manager,
      {
        operationId: randomUUID(),
        ticket: sourceTicket.id,
        roleId: f.developer.roleId,
        name: '源主执行夹具',
        cwd: sourcePath,
        worktreeId: sourceWorktree.id,
        writeScopes: [sourcePath],
      },
      'unit',
    ).record;
    const sourceSession = c.reserveSession({
      roleId: f.developer.roleId,
      name: '源主',
      purpose: '合成原生回执，不冒充实际执行',
      cwd: sourcePath,
    });
    c.executions().sessionReserved(execution.id, sourceSession.id);
    c.bindSession(sourceSession.id, 'unit-merge-source');
    c.executions().sessionPrepared(execution.id, sourceSession.id);
    wb.allocateCurrentMaterial(sourceSession.id);
    const baseline = c.versions().baseline(execution.id);
    c.worktrees().associate(manager, sourceWorktree.id, execution.id, sourceCommit);
    c.worktrees().baselineLinked(sourceWorktree.id, execution.id, baseline.id, sourceCommit);
    c.executions().starting(execution.id, 10, { provider: 'unit', model: 'unit' }, '仅服务夹具');
    c.executions().goalLinked(execution.id, {
      id: 'unit-merge-source-goal',
      revision: 1,
      objective: '仅服务夹具',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 1,
      maxGoalRounds: 2,
    });
    c.executions().goalDurable(execution.id);
    const requestId = randomUUID();
    c.saveRequest({
      id: requestId,
      executionId: execution.id,
      executionContextVersion: 'unit',
      sessionId: sourceSession.id,
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
    c.executions().requestObserved(sourceSession.id, requestId);
    wb.updateChecklist({ kind: 'session', sessionId: sourceSession.id }, sourceTicket.id, {
      operationId: randomUUID(),
      updates: [{ id: 'C001', expectedRevision: 1, checked: true, result: '仅单元合成检查' }],
      newLog: {
        title: '夹具结果',
        content: '本测试只验证版本与权限，不代表真实SDK',
        type: 'verification',
        references: [],
      },
    });
    const reviewerRole = c.registerRole({
        code: 'REV',
        name: '审阅',
        type: 'reviewer',
        configuration: { provider: 'unit', model: 'unit' },
      }),
      reviews = c.reviews();
    reviews.configure(user, { operationId: randomUUID(), reviewerRoleId: reviewerRole.id });
    const completion = reviews.complete(sourceSession.id, {
      operationId: randomUUID(),
      summary: '源固定版本夹具',
      scope: '本例源码',
      checklistItemIds: ['C001'],
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
      note: '仅合成原生回执，不作为真实通过证据',
    };
    reviews.authorPaused(
      completion.reviewId,
      'unit-merge-source-goal',
      'unit-merge-source',
      true,
      quiet,
    );
    const reviewer = c.reserveSession({
      roleId: reviewerRole.id,
      name: '指定独审',
      purpose: '单元夹具',
      cwd: sourceTicket.materialRoot,
    });
    reviews.sessionReserved(completion.reviewId, reviewer.id);
    c.bindSession(reviewer.id, 'unit-merge-review');
    reviews.sessionPrepared(completion.reviewId, reviewer.id, 'unit-merge-review');
    wb.allocateCurrentMaterial(reviewer.id);
    reviews.materialPrepared(completion.reviewId);
    reviews.armWait(completion.reviewId);
    reviews.goalLinked(
      completion.reviewId,
      {
        id: 'unit-merge-review-goal',
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
        verdict: 'pass',
        scope: '本例固定版本',
        basis: '仅合成审阅状态，不声明真实审阅',
        issues: [],
        evidencePaths: [],
      },
    );
    reviews.controlled(completion.reviewId, '仅合成停稳', quiet);
    reviews.closeAfterResult(completion.reviewId, 'unit-merge-review-goal', 'unit-merge-review');
    c.reviewResults().progress(result.id, 'reviewCleanup', {
      state: 'confirmed',
      note: '仅合成审核收尾',
      at: new Date().toISOString(),
    });
    c.reviewResults().authorObserved(result.id, quiet);
    c.reviewResults().progress(result.id, 'authorGoalClear', {
      state: 'confirmed',
      note: '仅合成Goal回执',
      at: new Date().toISOString(),
    });
    c.reviewResults().closeMain(result.id);
    return {
      ...f,
      managerActor: manager,
      sourceTicket,
      combinationTicket,
      sourcePath,
      sourceWorktree: c.worktrees().get(user, sourceWorktree.id),
      sourceSession,
      sourceCommit,
      sourceExecution: c.executions().get(execution.id),
      sourceVersion: c.versions().get(completion.versionId),
      sourceResult: c.reviewResults().get(result.id),
    };
  } catch (error) {
    f.close();
    throw error;
  }
}
