import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/services/project-service.ts';
function baseFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mat-review-record-')),
    root = join(directory, '项目');
  mkdirSync(root);
  const projects = new ProjectService(join(directory, '插件存储')),
    project = projects.create({
      root,
      name: '交回记录',
      supervisor: { provider: 'unit', model: 'unit' },
    }),
    connection = projects.forProject(project.id),
    wb = connection.workbench(),
    user = { kind: 'user' as const };
  const manager = connection.reserveSession({
    roleId: connection.roles()[0]!.id,
    name: '主管',
    purpose: '测试',
    cwd: root,
  });
  connection.bindSession(manager.id, 'unit-manager');
  connection
    .controls()
    .startProject(user, { operationId: randomUUID(), reason: '测试启动' }, 'unit');
  connection.controls().projectReady('unit', manager.id);
  const phase = wb.createPhase(user, {
    operationId: randomUUID(),
    name: '一期',
    goal: '交付版本',
    basis: '测试',
    checklist: [],
  });
  wb.openPhase(user, phase.id, { operationId: randomUUID(), reason: '测试' });
  const category = wb.createCategory(user, {
      operationId: randomUUID(),
      code: 'VER',
      name: '版本',
    }),
    ticket = wb.createTicket(user, {
      operationId: randomUUID(),
      phaseId: phase.id,
      categoryId: category.id,
      title: '固定版本',
      goal: '原件可回读',
      included: '临时文件',
      excluded: '不运行模型',
      dependencies: [],
      conditions: [{ condition: '有差异', verification: 'automated' }],
    }),
    role = connection.registerRole({
      code: 'DEV',
      name: '开发',
      type: 'developer',
      configuration: { provider: 'unit', model: 'unit' },
    }),
    execution = connection
      .executions()
      .register(
        { kind: 'session', sessionId: manager.id },
        { operationId: randomUUID(), ticket: ticket.id, roleId: role.id, name: '开发', cwd: root },
        'unit',
      ).record;
  const session = connection.reserveSession({
    roleId: role.id,
    name: '真实身份夹具',
    purpose: '版本服务测试',
    cwd: root,
  });
  connection.executions().sessionReserved(execution.id, session.id);
  connection.bindSession(session.id, 'unit-executor');
  connection.executions().sessionPrepared(execution.id, session.id);
  const material = wb.allocateCurrentMaterial(session.id);
  return {
    root,
    projects,
    connection,
    execution,
    session,
    ticket,
    material,
    manager,
    role,
    close() {
      projects.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function completionFixture() {
  const f = baseFixture(),
    reviewer = f.connection.registerRole({
      code: 'AUD',
      name: '审阅',
      type: 'reviewer',
      configuration: { provider: 'unit', model: 'unit' },
    });
  writeFileSync(join(f.root, '成果.txt'), '派工前');
  f.connection.versions().baseline(f.execution.id);
  f.connection
    .executions()
    .starting(f.execution.id, 10, { provider: 'unit', model: 'unit' }, '仅事务夹具');
  f.connection.executions().goalLinked(f.execution.id, {
    id: 'unit-main-goal',
    revision: 1,
    objective: '仅事务夹具',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 2,
  });
  f.connection.executions().goalDurable(f.execution.id);
  const id = randomUUID();
  f.connection.saveRequest({
    id,
    executionId: f.execution.id,
    executionContextVersion: 'unit',
    sessionId: f.session.id,
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
  f.connection.executions().requestObserved(f.session.id, id);
  writeFileSync(join(f.root, '成果.txt'), '交付成果');
  return { ...f, reviewer };
}
