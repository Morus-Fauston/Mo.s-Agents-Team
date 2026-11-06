import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeProject, connectProject } from '../src/services/project.ts';
const user = { kind: 'user' as const };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mat-workbench-'));
  initializeProject({
    root,
    name: '工作台SQLite验证',
    supervisor: { provider: 'unit', model: 'unit' },
  });
  const connection = connectProject(root),
    workbench = connection.workbench();
  const phase = workbench.createPhase(user, {
    operationId: randomUUID(),
    name: '第一期',
    goal: '独立交付',
    basis: '已确认需求',
    checklist: [{ condition: '用户确认体验', verification: 'manual' }],
  });
  const category = workbench.createCategory(user, {
    operationId: randomUUID(),
    code: 'ENG',
    name: '实现',
  });
  const input = {
    operationId: randomUUID(),
    phaseId: phase.id,
    categoryId: category.id,
    title: '一张票',
    goal: '交付可验证结果',
    included: '明确范围',
    excluded: '不做后续',
    dependencies: [] as string[],
    conditions: [
      { condition: '自动验证', verification: 'automated' as const },
      { condition: '用户确认', verification: 'manual' as const },
    ],
  };
  const ticket = workbench.createTicket(user, input);
  return {
    root,
    connection,
    workbench,
    phase,
    category,
    ticket,
    input,
    close() {
      connection.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('独立期次、类别与票号在事务中分配，重复操作同源去重，计划不产生执行', () => {
  const f = fixture();
  try {
    expect(f.phase.code).toBe('P001');
    expect(f.phase.state).toBe('unopened');
    expect(f.ticket.code).toBe('P001-ENG-001');
    expect(f.ticket.state).toBe('todo');
    expect(f.ticket.currentExecution).toBeNull();
    expect(f.workbench.createTicket(user, f.input)).toEqual(f.ticket);
    expect(() => f.workbench.createTicket(user, { ...f.input, title: '换正文' })).toThrow(
      '操作身份',
    );
    const sp = f.workbench.createPhase(user, {
      operationId: randomUUID(),
      name: '补充',
      goal: '补充目标',
      basis: '明确范围',
      parentId: f.phase.id,
      checklist: [],
    });
    expect(sp.code).toBe('P001SP');
    expect(() =>
      f.workbench.createPhase(user, {
        operationId: randomUUID(),
        name: '第二补充',
        goal: '不应重复',
        basis: '验证',
        parentId: f.phase.id,
        checklist: [],
      }),
    ).toThrow('SP');
    expect(f.connection.sessions()).toEqual([]);
  } finally {
    f.close();
  }
});
test('要求修订、改名和归类不改稳定编号，依赖拒绝自环及循环', () => {
  const f = fixture();
  try {
    const second = f.workbench.createTicket(user, {
      ...f.input,
      operationId: randomUUID(),
      title: '下一票',
      dependencies: [f.ticket.id],
    });
    const updated = f.workbench.updateTicket(user, f.ticket.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      reason: '澄清要求',
      title: '新名称',
      goal: '交付准确结果',
    });
    expect(updated.code).toBe(f.ticket.code);
    expect(updated.revision).toBe(2);
    expect(f.workbench.ticketHistory(f.ticket.id)).toHaveLength(2);
    expect(() =>
      f.workbench.updateTicket(user, f.ticket.id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        reason: '验证循环',
        dependencies: [second.id],
      }),
    ).toThrow('循环');
    expect(() =>
      f.workbench.updateTicket(user, f.ticket.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: '旧版本',
        title: '过时覆盖',
      }),
    ).toThrow('版本');
    expect(f.workbench.getTicket(f.ticket.id).title).toBe('新名称');
  } finally {
    f.close();
  }
});
test('Checklist变化必须有同票Log，同次新Log与结果原子保存，人工项不由成员代填', () => {
  const f = fixture();
  try {
    expect(() =>
      f.workbench.updateChecklist(user, f.ticket.id, {
        operationId: randomUUID(),
        updates: [{ id: 'C001', expectedRevision: 1, checked: true, result: '无依据' }],
      }),
    ).toThrow('Log');
    const changed = f.workbench.updateChecklist(user, f.ticket.id, {
      operationId: randomUUID(),
      updates: [{ id: 'C001', expectedRevision: 1, checked: true, result: '测试已通过' }],
      newLog: {
        title: '验证结果',
        content: '实际命令与结果',
        type: 'verification',
        importance: 'normal',
        references: [],
      },
    });
    expect(changed.checklist[0]!.logId).toBe('L001');
    expect(changed.checklist[0]!.checked).toBe(true);
    expect(f.workbench.logs(f.ticket.id)).toHaveLength(1);
    expect(changed.state).toBe('todo');
    const before = f.workbench.logs(f.ticket.id).length;
    expect(() =>
      f.workbench.updateChecklist(user, f.ticket.id, {
        operationId: randomUUID(),
        updates: [{ id: 'C999', expectedRevision: 1, checked: true, result: '无效项' }],
        newLog: {
          title: '应回滚',
          content: '不应残留',
          type: 'verification',
          importance: 'normal',
          references: [],
        },
      }),
    ).toThrow();
    expect(f.workbench.logs(f.ticket.id)).toHaveLength(before);
  } finally {
    f.close();
  }
});
test('实质变更条件使旧勾选失效，Log归档和正文纠正保留原ID及历史', () => {
  const f = fixture();
  try {
    f.workbench.updateChecklist(user, f.ticket.id, {
      operationId: randomUUID(),
      updates: [{ id: 'C001', expectedRevision: 1, checked: true, result: '旧标准通过' }],
      newLog: {
        title: '旧证据',
        content: '原文',
        type: 'verification',
        importance: 'critical',
        references: [],
      },
    });
    const revised = f.workbench.updateCondition(user, f.ticket.id, 'C001', {
      operationId: randomUUID(),
      expectedRevision: 1,
      condition: '加强后的验证条件',
      verification: 'automated',
      reason: '条件实质变化',
    });
    expect(revised.checklist[0]!.checked).toBe(false);
    expect(revised.checklist[0]!.logId).toBeNull();
    f.workbench.updateLog(user, f.ticket.id, 'L001', {
      operationId: randomUUID(),
      archived: true,
      reason: '标准已替换',
    });
    expect(f.workbench.logs(f.ticket.id)).toHaveLength(0);
    expect(f.workbench.getLog(f.ticket.id, 'L001').content).toBe('原文');
    expect(f.workbench.logs(f.ticket.id, 'archived')).toHaveLength(1);
    f.workbench.updateLog(user, f.ticket.id, 'L001', {
      operationId: randomUUID(),
      archived: false,
      reason: '仍需参考原失败',
    });
    expect(f.workbench.logs(f.ticket.id)).toHaveLength(1);
    expect(f.workbench.logHistory(f.ticket.id, 'L001')).toHaveLength(3);
  } finally {
    f.close();
  }
});
test('测试反馈绑定真实会话背景，重送不新建、不派工、不唤醒且不准自填作者', () => {
  const f = fixture();
  try {
    const role = f.connection.registerRole({
      code: 'DEV',
      name: '开发',
      type: 'developer',
      configuration: { provider: 'unit', model: 'unit' },
    });
    const reserved = f.connection.reserveSession({
      roleId: role.id,
      name: '真实登记夹具',
      purpose: '业务目录单测，非Host证明',
      cwd: f.root,
    });
    f.connection.bindSession(reserved.id, 'unit-native');
    const actor = { kind: 'session' as const, sessionId: reserved.id };
    const input = {
      operationId: randomUUID(),
      title: '反馈来源验证',
      content: '应保存但不触发执行',
    };
    const saved = f.workbench.submitFeedback(actor, input);
    expect(saved.author.sessionId).toBe(reserved.id);
    expect(saved.author.roleId).toBe(role.id);
    expect(saved.executionId).toBeNull();
    expect(f.workbench.submitFeedback(actor, input).id).toBe(saved.id);
    expect(f.workbench.feedback()).toHaveLength(1);
    expect(f.workbench.listTickets()).toHaveLength(1);
    expect(() =>
      f.workbench.submitFeedback(actor, {
        ...input,
        operationId: randomUUID(),
        sender: '伪造主管',
      }),
    ).toThrow();
    expect(f.connection.requests(reserved.id)).toEqual([]);
  } finally {
    f.close();
  }
});

test('责任适配器按本票和当前辅助授权检查写入，人工项拒绝且失败新Log回滚', () => {
  const f = fixture();
  try {
    const role = f.connection.registerRole({
      code: 'DEV',
      name: '开发',
      type: 'developer',
      configuration: { provider: 'unit', model: 'unit' },
    });
    const reserved = f.connection.reserveSession({
      roleId: role.id,
      name: '责任适配器单测',
      purpose: '不冒称真实派工',
      cwd: f.root,
    });
    f.connection.bindSession(reserved.id, 'unit-scope');
    const actor = { kind: 'session' as const, sessionId: reserved.id };
    const entry = {
      title: '本次记录',
      content: '来源与权限校验',
      type: 'verification',
      importance: 'normal',
      references: [],
    };
    expect(() =>
      f.workbench.appendLog(actor, f.ticket.id, { ...entry, operationId: randomUUID() }),
    ).toThrow('实际执行责任');
    let checklistIds = ['C001'];
    f.workbench.bindExecutionAccess(() => ({
      ticketId: f.ticket.id,
      executionId: 'unit-scope-not-host-proof',
      kind: 'assistant',
      checklistIds,
    }));
    const own = f.workbench.appendLog(actor, f.ticket.id, { ...entry, operationId: randomUUID() });
    f.workbench.updateChecklist(actor, f.ticket.id, {
      operationId: randomUUID(),
      updates: [{ id: 'C001', expectedRevision: 1, checked: true, result: '已验证' }],
      logId: own.id,
    });
    checklistIds = [];
    expect(() =>
      f.workbench.updateChecklist(actor, f.ticket.id, {
        operationId: randomUUID(),
        updates: [{ id: 'C001', expectedRevision: 1, checked: false, result: '授权已撤回' }],
        logId: own.id,
      }),
    ).toThrow('最新系统授权');
    const count = f.workbench.logs(f.ticket.id).length;
    expect(() =>
      f.workbench.updateChecklist(actor, f.ticket.id, {
        operationId: randomUUID(),
        updates: [{ id: 'C002', expectedRevision: 1, checked: true, result: '不能代填' }],
        newLog: entry,
      }),
    ).toThrow('人工验收');
    expect(f.workbench.logs(f.ticket.id)).toHaveLength(count);
    const other = f.workbench.appendLog(user, f.ticket.id, { ...entry, operationId: randomUUID() });
    expect(() =>
      f.workbench.updateLog(actor, f.ticket.id, other.id, {
        operationId: randomUUID(),
        archived: true,
        reason: '不能整理他人',
      }),
    ).toThrow('自己的Log');
  } finally {
    f.close();
  }
});

test('期次开放、主管清单与历史同源留痕，不能任意赋票状态或用清单完成代替票据', () => {
  const f = fixture();
  try {
    const before = f.workbench.projectHistory().length,
      input = { operationId: randomUUID(), reason: '用户明确开放本期范围' };
    f.workbench.openPhase(user, f.phase.id, input);
    f.workbench.openPhase(user, f.phase.id, input);
    expect(f.workbench.projectHistory()).toHaveLength(before + 1);
    expect(f.workbench.getPhase(f.phase.id).state).toBe('opened');
    expect(() =>
      f.workbench.updateTicket(user, f.ticket.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: '不允许',
        state: 'completed',
      }),
    ).toThrow();
    const task = f.workbench.createTask(user, {
      operationId: randomUUID(),
      level: 'long',
      title: '已确认目标',
      basis: '明确输入',
      ticketIds: [f.ticket.id],
    });
    expect(() =>
      f.workbench.updateTask(user, task.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: '不能绕过',
        state: 'checked',
        basis: '原票尚未完成',
      }),
    ).toThrow('关联票据尚未完成');
    const note = f.workbench.addHistory(user, {
      operationId: randomUUID(),
      content: '待核实的跨票判断',
      references: [f.ticket.id],
    });
    const correction = f.workbench.addHistory(user, {
      operationId: randomUUID(),
      content: '纠正原判断，保留原记录',
      corrects: note.id,
      references: [f.ticket.id],
    });
    expect(
      f.workbench
        .projectHistory()
        .some((entry) => entry.id === note.id && entry.reason === '待核实的跨票判断'),
    ).toBe(true);
    expect(correction.corrects).toBe(note.id);
  } finally {
    f.close();
  }
});

test('材料分配契约按具体执行分域，同次沿用而新尝试不覆盖，缺域不静默重建', () => {
  const f = fixture();
  try {
    const role = f.connection.registerRole({
      code: 'DEV',
      name: '开发',
      type: 'developer',
      configuration: { provider: 'unit', model: 'unit' },
    });
    const sessions = [1, 2].map((n) => {
      const session = f.connection.reserveSession({
        roleId: role.id,
        name: '材料契约单测' + n,
        purpose: '责任适配器夹具，非实际派工证明',
        cwd: f.root,
      });
      f.connection.bindSession(session.id, 'unit-material-' + n);
      return session;
    });
    expect(() => f.workbench.allocateCurrentMaterial(sessions[0]!.id)).toThrow('实际执行');
    const ids = new Map(sessions.map((session) => [session.id, randomUUID()]));
    f.workbench.bindExecutionAccess((sessionId) =>
      ids.has(sessionId)
        ? {
            ticketId: f.ticket.id,
            executionId: ids.get(sessionId)!,
            kind: 'main',
            checklistIds: [],
          }
        : undefined,
    );
    const first = f.workbench.allocateCurrentMaterial(sessions[0]!.id),
      second = f.workbench.allocateCurrentMaterial(sessions[1]!.id);
    expect(first.roleId).toBe(second.roleId);
    expect(first.path).not.toBe(second.path);
    writeFileSync(join(first.path, '原始结果.txt'), '原文保留');
    expect(f.workbench.allocateCurrentMaterial(sessions[0]!.id).id).toBe(first.id);
    ids.set(sessions[0]!.id, randomUUID());
    const next = f.workbench.allocateCurrentMaterial(sessions[0]!.id);
    expect(next.path).not.toBe(first.path);
    expect(existsSync(join(first.path, '原始结果.txt'))).toBe(true);
    expect(f.workbench.materialDomains(f.ticket.id)).toHaveLength(3);
    const reviewerRole = f.connection.registerRole({
        code: 'REV',
        name: '独审',
        type: 'reviewer',
        configuration: { provider: 'unit', model: 'unit' },
      }),
      reviewer = f.connection.reserveSession({
        roleId: reviewerRole.id,
        name: '独审分域契约单测',
        purpose: '责任适配器夹具，非实际独审证明',
        cwd: f.root,
      });
    f.connection.bindSession(reviewer.id, 'unit-material-review');
    f.workbench.bindExecutionAccess((sessionId) =>
      sessionId === reviewer.id
        ? {
            ticketId: f.ticket.id,
            executionId: ids.get(sessions[0]!.id)!,
            reviewId: 'unit-review-reference',
            kind: 'review',
            checklistIds: [],
          }
        : ids.has(sessionId)
          ? {
              ticketId: f.ticket.id,
              executionId: ids.get(sessionId)!,
              kind: 'main',
              checklistIds: [],
            }
          : undefined,
    );
    const audit = f.workbench.allocateCurrentMaterial(reviewer.id);
    expect(audit.relativePath.startsWith('审阅/')).toBe(true);
    expect(audit.path).not.toBe(next.path);
    expect(f.workbench.allocateCurrentMaterial(reviewer.id).id).toBe(audit.id);
    expect(relative(f.root, next.path).startsWith('..')).toBe(false);
    expect(next.path).not.toBe(f.root);
    rmSync(next.path, { recursive: true });
    expect(
      f.workbench.materialDomains(f.ticket.id).find((domain) => domain.id === next.id)!.available,
    ).toBe(false);
    expect(() => f.workbench.allocateCurrentMaterial(sessions[0]!.id)).toThrow('未悄悄重建');
    expect(existsSync(next.path)).toBe(false);
  } finally {
    f.close();
  }
});

test('迟到的Checklist结果必须匹配所读条件修订，票内与期次都拒绝旧版本', () => {
  const f = fixture();
  try {
    f.workbench.updateCondition(user, f.ticket.id, 'C001', {
      operationId: randomUUID(),
      expectedRevision: 1,
      condition: '变更后的准确条件',
      verification: 'automated',
      reason: '旧证据已经失效',
    });
    const entry = {
      title: '旧条件证据',
      content: '旧结果不能套在新条件上',
      type: 'verification',
      importance: 'normal',
      references: [],
    };
    expect(() =>
      f.workbench.updateChecklist(user, f.ticket.id, {
        operationId: randomUUID(),
        updates: [{ id: 'C001', checked: true, result: '无条件版本的旧提交' }],
        newLog: entry,
      }),
    ).toThrow();
    expect(() =>
      f.workbench.updateChecklist(user, f.ticket.id, {
        operationId: randomUUID(),
        updates: [{ id: 'C001', expectedRevision: 1, checked: true, result: '迟到旧结果' }],
        newLog: entry,
      }),
    ).toThrow('条件版本');
    expect(f.workbench.logs(f.ticket.id)).toHaveLength(0);
    expect(f.workbench.getTicket(f.ticket.id).checklist[0]!.checked).toBe(false);
    const current = f.workbench.updateChecklist(user, f.ticket.id, {
      operationId: randomUUID(),
      updates: [{ id: 'C001', expectedRevision: 2, checked: true, result: '新条件已经重新验证' }],
      newLog: { ...entry, title: '新条件证据' },
    });
    expect(current.checklist[0]!.checked).toBe(true);
    f.workbench.maintainPhaseChecklist(user, f.phase.id, {
      operationId: randomUUID(),
      action: 'condition',
      id: 'C001',
      expectedRevision: 1,
      condition: '新的期次条件',
      verification: 'manual',
      reason: '必须重新确认',
    });
    expect(() =>
      f.workbench.maintainPhaseChecklist(user, f.phase.id, {
        operationId: randomUUID(),
        action: 'result',
        id: 'C001',
        expectedRevision: 1,
        checked: true,
        result: '旧结果',
        reason: '过时提交',
      }),
    ).toThrow('条件版本');
    expect(f.workbench.getPhase(f.phase.id).checklist[0]!.checked).toBe(false);
  } finally {
    f.close();
  }
});
test('已勾选主管清单变更票据关联时也按最终状态检查，不借省略state绕过', () => {
  const f = fixture();
  try {
    const task = f.workbench.createTask(user, {
      operationId: randomUUID(),
      level: 'short',
      title: '已核对的独立事项',
      basis: '单测夹具明确结果',
      ticketIds: [],
    });
    f.workbench.updateTask(user, task.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      state: 'checked',
      reason: '独立事项已核对',
      basis: '已有直接结果',
    });
    expect(() =>
      f.workbench.updateTask(user, task.id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        ticketIds: [f.ticket.id],
        reason: '加入未完成工作',
        basis: '不能保持原有完成结论',
      }),
    ).toThrow('关联票据尚未完成');
    expect(f.workbench.getTask(task.id).ticketIds).toEqual([]);
  } finally {
    f.close();
  }
});
