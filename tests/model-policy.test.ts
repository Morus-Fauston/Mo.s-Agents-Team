import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { initializeProject, connectProject } from '../src/services/project.ts';

test('角色备用默认关闭；会话捕获策略，后改默认不热改；同一故障只占用指定备用一次', () => {
  const f = completionFixture();
  try {
    const c = f.connection,
      role = c.registerRole({
        code: 'FALL',
        type: 'developer',
        name: '单一备用',
        configuration: { provider: 'p', model: 'primary' },
        fallback: { enabled: true, configuration: { provider: 'p', model: 'backup' } },
      });
    const first = c.reserveSession({
      roleId: role.id,
      name: '策略快照',
      purpose: '配置测试',
      cwd: f.root,
    });
    c.updateRole(role.id, {
      configuration: { provider: 'p', model: 'new-primary' },
      fallback: { enabled: false, configuration: null },
    });
    const second = c.reserveSession({
      roleId: role.id,
      name: '后建会话',
      purpose: '默认变化',
      cwd: f.root,
    });
    const policies = c.modelPolicies();
    expect(policies.state(first.id).policy).toEqual({
      enabled: true,
      configuration: { provider: 'p', model: 'backup' },
    });
    expect(policies.state(second.id).policy.enabled).toBe(false);
    c.bindSession(first.id, 'native-first');
    c.bindSession(second.id, 'native-second');
    expect(
      policies.reserveFallback(second.id, {
        failureId: 'failure-1',
        code: 'NO_ADAPTER',
        message: '主配置不可用',
      }),
    ).toBeNull();
    const attempt = policies.reserveFallback(first.id, {
      failureId: 'failure-1',
      code: 'NO_ADAPTER',
      message: '主配置不可用',
    })!;
    expect(attempt.configuration).toEqual({ provider: 'p', model: 'backup' });
    expect(
      policies.reserveFallback(first.id, {
        failureId: 'failure-1',
        code: 'NO_ADAPTER',
        message: '主配置不可用',
      })!.id,
    ).toBe(attempt.id);
    expect(
      policies.reserveFallback(first.id, {
        failureId: 'failure-2',
        code: 'UNAVAILABLE',
        message: '再次失败',
      }),
    ).toBeNull();
    policies.problem(attempt.id, '原生持久接纳不明');
    expect(policies.state(first.id).fallbackState).toBe('unknown');
    expect(
      policies.reserveFallback(first.id, {
        failureId: 'failure-3',
        code: 'UNAVAILABLE',
        message: '不能再遍历',
      }),
    ).toBeNull();
    expect(policies.state(second.id).current.model).toBe('new-primary');
    expect(c.roles().find((r) => r.id === role.id)!.configuration.model).toBe('new-primary');
  } finally {
    f.close();
  }
});

test('已有会话的明确切换校验修订和操作身份，原配置与切换事实不冒充成功请求', () => {
  const f = completionFixture();
  try {
    const c = f.connection,
      policies = c.modelPolicies(),
      old = policies.state(f.session.id),
      input = {
        operationId: randomUUID(),
        expectedRevision: old.revision,
        configuration: { provider: 'p', model: 'explicit' },
        reason: '用户明确选择此会话',
      };
    const change = policies.reserveExplicit(f.session.id, input);
    expect(policies.reserveExplicit(f.session.id, input)).toEqual(change);
    expect(() =>
      policies.reserveExplicit(f.session.id, {
        ...input,
        configuration: { provider: 'p', model: 'forged' },
      }),
    ).toThrow('操作');
    expect(() =>
      policies.reserveExplicit(f.session.id, { ...input, operationId: randomUUID() }),
    ).toThrow('修订');
    expect(policies.state(f.session.id).current).toEqual(old.current);
    policies.confirm(change.id, {
      nativeSessionId: c.session(f.session.id).nativeSessionId!,
      selectionSeq: 12,
      durableAt: new Date().toISOString(),
    });
    expect(policies.state(f.session.id).current).toEqual(input.configuration);
    expect(c.session(f.session.id).configuration).toEqual(old.initial);
    expect(c.requests(f.session.id).every((r) => r.requestConfiguration.model !== 'explicit')).toBe(
      true,
    );
    expect(policies.history(f.session.id)[0]!.status).toBe('confirmed');
  } finally {
    f.close();
  }
});
test('schema14旧会话升级保留原配置且不推断新的备用授权', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-policy-migration-'));
  let c: ReturnType<typeof connectProject> | undefined;
  try {
    initializeProject({ root, name: '升级', supervisor: { provider: 'p', model: 'old' } });
    c = connectProject(root);
    const role = c.roles()[0]!,
      s = c.reserveSession({ roleId: role.id, name: '旧会话', purpose: '升级', cwd: root });
    c.close();
    c = undefined;
    const db = new DatabaseSync(join(root, '.TEAM', '运行数据', 'mat.db'));
    db.exec(
      'ALTER TABLE session DROP COLUMN communication_origin;DROP TABLE worktree_merge_command;DROP TABLE worktree_merge_event;DROP TABLE worktree_merge;DROP TABLE worktree_event;DROP TABLE worktree_record;DROP TABLE local_commit_command;DROP TABLE local_commit_event;DROP TABLE local_commit_arrangement;DROP TABLE model_change;DROP TABLE session_model_state;DROP TABLE role_model_policy;PRAGMA user_version=14',
    );
    db.close();
    c = connectProject(root);
    c.updateRole(role.id, {
      fallback: { enabled: true, configuration: { provider: 'p', model: 'new-backup' } },
    });
    expect(c.modelPolicies().state(s.id)).toMatchObject({
      initial: { provider: 'p', model: 'old' },
      current: { provider: 'p', model: 'old' },
      policy: { enabled: false, configuration: null },
      source: 'initial',
    });
    const next = c.reserveSession({
      roleId: role.id,
      name: '新会话',
      purpose: '升级后',
      cwd: root,
    });
    expect(c.modelPolicies().state(next.id).policy.enabled).toBe(true);
  } finally {
    c?.close();
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('mat-policy-migration-')
    )
      throw new Error('拒绝清理非测试目录');
    rmSync(root, { recursive: true, force: true });
  }
});
