import { test, expect, vi } from 'vitest';
import { installLocalCommitTools } from '../src/host/local-commit-tools.ts';
import type { NativeAgent, NativeContext, NativeModules, NativeEvent } from '../src/host/native.ts';
import type { LocalCommitService } from '../src/services/local-commits.ts';
import type { ProjectConnection } from '../src/services/project.ts';
import { randomUUID } from 'node:crypto';
test('本地提交工具拒绝伪造来源、原生调用及核验正文，预览分页保留准确指纹', async () => {
  const events: NativeEvent[] = [],
    owner = {
      id: 'native-manager',
      session: { snapshotEvents: () => events },
    } as unknown as NativeAgent,
    definitions: Record<string, unknown>[] = [];
  const ctx = {
      tools: { register: (d: Record<string, unknown>) => definitions.push(d) },
    } as unknown as NativeContext,
    modules = { defineTool: (d: unknown) => d } as unknown as NativeModules,
    manager = randomUUID(),
    project = randomUUID(),
    connection = { snapshot: () => ({ id: project }) } as unknown as ProjectConnection,
    preview = vi.fn(async () => ({
      repository: 'E:/isolated',
      head: null,
      kind: 'baseline',
      fingerprint: 'f'.repeat(64),
      files: Array.from({ length: 200 }, (_, i) => ({ path: 'file' + i })),
      capturedAt: 'time',
    }));
  installLocalCommitTools(ctx, owner, modules, () => ({ connection, sessionId: manager }), {
    preview,
  } as unknown as LocalCommitService);
  const execute = definitions[0]!.execute as (input: unknown, exec: unknown) => Promise<string>,
    input = {
      action: 'preview',
      preview: { repository: 'E:/isolated', kind: 'baseline', files: ['a.txt'] },
    };
  await expect(execute(input, { agent: { ...owner }, callId: 'native' })).rejects.toThrow(
    '实际调用',
  );
  await expect(execute(input, { agent: owner, callId: 'missing' })).rejects.toThrow('真实原生');
  events.push({ type: 'tool/call', seq: 3, data: { name: 'mat_local_commit', callId: 'native' } });
  await expect(
    execute({ ...input, actor: { kind: 'user' } }, { agent: owner, callId: 'native' }),
  ).rejects.toThrow();
  await expect(
    execute(
      { ...input, report: { expectedRevision: 1, state: 'committed', content: 'fake proof' } },
      { agent: owner, callId: 'native' },
    ),
  ).rejects.toThrow('当前动作');
  const result = JSON.parse(await execute(input, { agent: owner, callId: 'native' }));
  expect(result.fingerprint).toBe('f'.repeat(64));
  expect(result.nextOffset).toBeGreaterThan(0);
  expect(preview).toHaveBeenCalledWith(
    project,
    { kind: 'session', sessionId: manager },
    input.preview,
  );
});
