import { test, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installWorktreeMergeTools } from '../src/host/worktree-merge-tools.ts';
import { observeLocalCommit } from '../src/host/local-commit-quiescence.ts';
import { messageIdentity } from '../src/services/message-presentation.ts';
import type { NativeAgent, NativeContext, NativeModules, NativeEvent } from '../src/host/native.ts';
import type { ProjectConnection } from '../src/services/project.ts';
import type { WorktreeMergeService } from '../src/services/worktree-merges.ts';

test('合入工具来源与操作身份取实际原生调用，不接受正文proof，预核和大目录分页', async () => {
  const events: NativeEvent[] = [],
    owner = {
      id: 'native-manager',
      session: { snapshotEvents: () => events },
    } as unknown as NativeAgent;
  let execute: (raw: unknown, exec: unknown) => Promise<string>;
  const ctx = {
    tools: {
      register: (d: { execute: typeof execute }) => {
        execute = d.execute;
      },
    },
  } as unknown as NativeContext;
  const modules = { defineTool: (d: unknown) => d } as unknown as NativeModules,
    manager = randomUUID(),
    project = randomUUID();
  const connection = { snapshot: () => ({ id: project }) } as unknown as ProjectConnection;
  const preview = vi.fn(async () => ({
    fingerprint: 'f'.repeat(64),
    plan: {
      mode: 'merge',
      conflictPaths: [],
      changedPaths: Array.from({ length: 2000 }, (_, i) => 'file-' + i),
      objectDirectory: 'not-for-pagination',
      capturedAt: 'not-for-pagination',
    },
  }));
  const arrange = vi.fn(async () => ({
    id: randomUUID(),
    revision: 1,
    status: 'arranged',
    lastInspection: null,
    lastProof: null,
    lastQuiescence: null,
    repair: null,
    combination: null,
    notices: [],
  }));
  installWorktreeMergeTools(ctx, owner, modules, () => ({ connection, sessionId: manager }), {
    preview,
    arrange,
  } as unknown as WorktreeMergeService);
  const base = {
    targetRepository: 'E:/isolated',
    sourceWorktreeId: randomUUID(),
    sourceVersionId: randomUUID(),
    sourceResultId: randomUUID(),
    sourceCommit: 'a'.repeat(40),
  };
  const input = { action: 'preview', preview: base };
  await expect(execute!(input, { agent: { ...owner }, callId: 'native' })).rejects.toThrow(
    '实际调用',
  );
  await expect(execute!(input, { agent: owner, callId: 'missing' })).rejects.toThrow('真实原生');
  events.push({ type: 'tool/call', seq: 3, data: { name: 'mat_merge', callId: 'native' } });
  await expect(
    execute!({ ...input, proof: { state: 'verified' } }, { agent: owner, callId: 'native' }),
  ).rejects.toThrow();
  await expect(
    execute!(
      { ...input, report: { expectedRevision: 1, state: 'merged', content: 'fake' } },
      { agent: owner, callId: 'native' },
    ),
  ).rejects.toThrow('当前动作');
  const result = JSON.parse(await execute!(input, { agent: owner, callId: 'native' }));
  expect(result.nextOffset).toBeGreaterThan(0);
  expect(result.fingerprint).toBe('f'.repeat(64));
  expect(result.content).not.toContain('not-for-pagination');
  expect(preview).toHaveBeenCalledWith(project, { kind: 'session', sessionId: manager }, base);
  events.push({ type: 'tool/call', seq: 4, data: { name: 'mat_merge', callId: 'arrange' } });
  const arrangement = {
    ...base,
    sessionId: randomUUID(),
    expectedFingerprint: 'f'.repeat(64),
    combinationTicketId: randomUUID(),
    basis: '实际来源',
  };
  await execute!({ action: 'arrange', arrange: arrangement }, { agent: owner, callId: 'arrange' });
  expect(arrange).toHaveBeenCalledWith(
    project,
    { kind: 'session', sessionId: manager },
    { ...arrangement, operationId: messageIdentity('mat-merge:native-manager:4:arrange') },
  );
});

test('合入安静观察只排除自身真实mat_merge调用，不能排除伪造或另一工具的callId', () => {
  const events: NativeEvent[] = [
    { type: 'tool/call', seq: 3, data: { name: 'mat_merge', callId: 'report' } },
  ];
  const agent = {
    id: 'native',
    status: 'running',
    inbox: { nextStep: [] },
    session: { snapshotEvents: () => events },
  } as unknown as NativeAgent;
  const ctx = {
    jobs: { list: () => [] },
    goals: { get: () => undefined },
  } as unknown as NativeContext;
  const value = { native: { nativeSessionId: agent.id, epoch: 'unit', boundary: 0, ranges: [] } };
  expect(observeLocalCommit(ctx, agent, agent.id, 'unit', true, value, 'report').state).toBe(
    'unknown',
  );
  expect(
    observeLocalCommit(ctx, agent, agent.id, 'unit', true, value, 'report', 'mat_merge').state,
  ).toBe('confirmed');
  expect(
    observeLocalCommit(ctx, agent, agent.id, 'unit', true, value, 'fake', 'mat_merge').state,
  ).toBe('unknown');
  events.push({ type: 'tool/call', seq: 4, data: { name: 'pwsh', callId: 'parallel' } });
  expect(
    observeLocalCommit(ctx, agent, agent.id, 'unit', true, value, 'report', 'mat_merge').state,
  ).toBe('unknown');
});
