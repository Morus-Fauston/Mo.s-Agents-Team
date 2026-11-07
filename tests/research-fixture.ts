import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
export function researchFixture() {
  const f = completionFixture(),
    c = f.connection,
    wb = c.workbench(),
    user = { kind: 'user' as const };
  const ticket = wb.createTicket(user, {
    operationId: randomUUID(),
    phaseId: f.ticket.phaseId,
    categoryId: f.ticket.categoryId,
    kind: 'research',
    researchBody: '# 背景\n核对已给证据。\n\n# 交付\n报告和未确认边界。',
    title: '研究票',
    goal: '回答问题并保留来源强度',
    included: '原材料',
    excluded: '不声称运行环境已验证',
    conditions: [{ condition: '报告解释每题覆盖和未确认边界', verification: 'review' }],
  });
  const role = c.registerRole({
    code: 'INV',
    type: 'investigator',
    name: '调查',
    configuration: { provider: 'unit', model: 'unit' },
  });
  const execution = c.executions().register(
    { kind: 'session', sessionId: f.manager.id },
    {
      operationId: randomUUID(),
      ticket: ticket.id,
      roleId: role.id,
      name: '调查夹具',
      cwd: f.root,
      writeScopes: [],
    },
    'unit',
  ).record;
  const session = c.reserveSession({
    roleId: role.id,
    name: '研究主执行',
    purpose: '事务与版本测试，不代表真实模型',
    cwd: f.root,
  });
  c.executions().sessionReserved(execution.id, session.id);
  c.bindSession(session.id, 'unit-research');
  c.executions().sessionPrepared(execution.id, session.id);
  const material = wb.allocateCurrentMaterial(session.id);
  c.versions().baseline(execution.id);
  c.executions().starting(execution.id, 10, { provider: 'unit', model: 'unit' }, '研究夹具');
  c.executions().goalLinked(execution.id, {
    id: 'unit-research-goal',
    revision: 1,
    objective: '研究夹具',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 2,
  });
  c.executions().goalDurable(execution.id);
  return { ...f, ticket, role, execution, session, material };
}
