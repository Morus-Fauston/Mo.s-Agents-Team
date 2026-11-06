import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../源码/业务/项目服务.ts';
import { createApplication } from '../源码/接口/应用.ts';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mat-version-record-')),
    root = join(directory, '项目');
  mkdirSync(root);
  const projects = new ProjectService(join(directory, '插件存储')),
    project = projects.create({
      root,
      name: '版本记录',
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
    close() {
      projects.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('版本记录关联原执行并幂等，工作区变化提示不匹配，旧原件和两类差异仍可读', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '成果.txt'), '派工前\n');
    const versions = f.connection.versions(),
      baseline = versions.baseline(f.execution.id),
      actor = { kind: 'session' as const, sessionId: f.session.id };
    writeFileSync(join(f.root, '成果.txt'), '第一次交付\n');
    writeFileSync(join(f.material.path, '证据.txt'), '第一版证据');
    const input = {
        operationId: randomUUID(),
        summary: '第一版执行简报',
        scope: '成果.txt和本次材料',
        evidencePaths: ['证据.txt'],
        checklistItemIds: [f.ticket.checklist[0]!.id],
      },
      first = versions.delivery(actor, f.execution.id, input);
    expect(versions.delivery(actor, f.execution.id, input).id).toBe(first.id);
    expect(versions.check(first.id).matches).toBe(true);
    writeFileSync(join(f.root, '成果.txt'), '修复后交付\n');
    expect(versions.check(first.id).matches).toBe(false);
    expect(versions.file(first.id, 0, '成果.txt').toString()).toBe('第一次交付\n');
    const repair = versions.delivery(actor, f.execution.id, {
      ...input,
      operationId: randomUUID(),
      summary: '返修简报',
    });
    expect(versions.diff(repair.id, 'ticket').patch).toContain('-派工前');
    expect(versions.diff(repair.id, 'repair').patch).toContain('-第一次交付');
    expect(versions.list(f.execution.id).map((record) => record.id)).toEqual([
      baseline.id,
      first.id,
      repair.id,
    ]);
    expect(() =>
      versions.delivery(actor, f.execution.id, { ...input, summary: '重用身份改正文' }),
    ).toThrow('操作身份');
  } finally {
    f.close();
  }
});

test('真实HTTP查询固定版本、旧原件、差异和当前不匹配，不另设送审写入口', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '接口成果.txt'), '原基线\n');
    const versions = f.connection.versions();
    versions.baseline(f.execution.id);
    writeFileSync(join(f.root, '接口成果.txt'), '送审版本\n');
    const delivery = versions.delivery(
        { kind: 'session', sessionId: f.session.id },
        f.execution.id,
        { operationId: randomUUID(), summary: '接口验证', scope: '接口成果.txt' },
      ),
      app = createApplication(f.projects),
      base = `http://localhost/api/projects/${f.connection.snapshot().id}/executions/${f.execution.id}/versions`;
    const headers = await (await app.request(base)).json();
    expect(headers).toHaveLength(2);
    expect(headers[1].id).toBe(delivery.id);
    expect(headers[1].snapshot).toBeUndefined();
    writeFileSync(join(f.root, '接口成果.txt'), '后来修改\n');
    expect(await (await app.request(base + `/${delivery.id}/check`)).json()).toMatchObject({
      matches: false,
    });
    expect(
      await (
        await app.request(
          base + `/${delivery.id}/file?root=0&path=${encodeURIComponent('接口成果.txt')}`,
        )
      ).text(),
    ).toBe('送审版本\n');
    expect(
      await (await app.request(base + `/${delivery.id}/diff?mode=ticket`)).json(),
    ).toMatchObject({ to: delivery.id, mode: 'ticket' });
    expect((await app.request(base + `/${delivery.id}/diff?mode=unknown`)).status).toBe(400);
    expect(
      (await app.request(base + `/${delivery.id}/file?root=0&path=../../outside`)).status,
    ).toBe(409);
    expect(
      (
        await app.request(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
  } finally {
    f.close();
  }
});

test('非原执行者不能创建正式版本，缺基线或已经开始的旧执行不补写历史', () => {
  const f = fixture();
  try {
    const versions = f.connection.versions(),
      input = { operationId: randomUUID(), summary: '不能代交', scope: '临时目录' };
    expect(() => versions.delivery({ kind: 'user' }, f.execution.id, input)).toThrow(
      '原实际执行者',
    );
    expect(() =>
      versions.delivery({ kind: 'session', sessionId: f.session.id }, f.execution.id, input),
    ).toThrow('缺少真实派工基线');
    f.connection
      .executions()
      .starting(f.execution.id, 10, { provider: 'unit', model: 'unit' }, '已进入启动');
    expect(() => versions.baseline(f.execution.id)).toThrow('不能用当前文件补写历史');
    expect(versions.list(f.execution.id)).toHaveLength(0);
  } finally {
    f.close();
  }
});

test('本次材料域缺件不被重建为空快照，已存原件损坏不以当前文件代替', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, '成果.txt'), '必须保留原件');
    const versions = f.connection.versions(),
      baseline = versions.baseline(f.execution.id),
      original = baseline.snapshot.roots[0]!.files.find((file) => file.path === '成果.txt')!;
    writeFileSync(join(versions.storage, 'sha256', original.sha256), '损坏内容');
    expect(() => versions.file(baseline.id, 0, '成果.txt')).toThrow('哈希不符');
    rmSync(f.material.path, { recursive: true, force: true });
    expect(versions.check(baseline.id)).toMatchObject({ matches: null });
    expect(versions.list(f.execution.id)).toHaveLength(1);
  } finally {
    f.close();
  }
});
