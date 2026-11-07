import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localCommitFixture } from './local-commit-fixture.ts';
import {
  captureWorkspace,
  inspectWorkspace,
  readSnapshotFile,
} from '../src/services/workspace-snapshot.ts';

test('合入修正快照只接受明确原HEAD、MERGE_HEAD和真实index，普通快照仍拒绝冲突', () => {
  const f = localCommitFixture();
  try {
    f.git('add', '--', 'a.txt', 'keep.txt');
    f.git('commit', '-m', 'base');
    f.git('branch', 'source');
    f.write('a.txt', 'target\n');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'target');
    const head = f.git('rev-parse', 'HEAD');
    f.git('switch', 'source');
    f.write('a.txt', 'source\n');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'source');
    const source = f.git('rev-parse', 'HEAD');
    f.git('switch', 'main');
    expect(() => f.git('merge', '--no-edit', '--', source)).toThrow();
    const before = readFileSync(join(f.root, '.git/index'));
    const input = { cwd: f.root, storage: join(f.directory, 'snapshot') };
    expect(() => captureWorkspace(input)).toThrow(/未合并索引/);
    f.write('a.txt', 'reviewable resolution\n');
    const mergeRepair = {
      repository: f.root,
      expectedHead: head,
      expectedMergeHeads: [source],
      expectedIndexFingerprint: createHash('sha256').update(before).digest('hex'),
    };
    const snapshot = captureWorkspace({ ...input, mergeRepair });
    expect(snapshot.roots[0]?.indexState).toEqual({
      head,
      mergeHeads: [source],
      indexFingerprint: mergeRepair.expectedIndexFingerprint,
    });
    expect(readSnapshotFile(snapshot, 0, 'a.txt', input.storage).toString()).toBe(
      'reviewable resolution\n',
    );
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(before);
    expect(inspectWorkspace({ ...input, mergeRepair }).fingerprint).toBe(snapshot.fingerprint);
    expect(() =>
      inspectWorkspace({ ...input, mergeRepair: { ...mergeRepair, expectedHead: source } }),
    ).toThrow(/修正现场/);
    expect(() =>
      inspectWorkspace({ ...input, mergeRepair: { ...mergeRepair, expectedMergeHeads: [head] } }),
    ).toThrow(/修正现场/);
    f.git('add', '--', 'a.txt');
    expect(() => inspectWorkspace({ ...input, mergeRepair })).toThrow(/修正现场/);
  } finally {
    f.close();
  }
}, 60000);
