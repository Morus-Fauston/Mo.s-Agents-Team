import { test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transaction } from '../src/storage/transaction.ts';
test('真实SQLite嵌套事务成功后外层失败仍全部回滚，不能残留一半有效交付', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-completion-transaction-')),
    db = new DatabaseSync(join(root, '事务.sqlite'));
  try {
    db.exec(
      'CREATE TABLE versions(id TEXT PRIMARY KEY);CREATE TABLE reviews(id TEXT PRIMARY KEY);',
    );
    expect(() =>
      transaction(db, () => {
        db.prepare('INSERT INTO versions VALUES(?)').run('delivery');
        transaction(db, () => {
          db.prepare('INSERT INTO reviews VALUES(?)').run('review');
        });
        throw new Error('外层业务失败');
      }),
    ).toThrow('外层业务失败');
    expect(db.prepare('SELECT count(*) AS count FROM versions').get()?.count).toBe(0);
    expect(db.prepare('SELECT count(*) AS count FROM reviews').get()?.count).toBe(0);
    transaction(db, () => {
      db.prepare('INSERT INTO versions VALUES(?)').run('valid');
      try {
        transaction(db, () => {
          db.prepare('INSERT INTO reviews VALUES(?)').run('invalid');
          throw new Error('本次审核安排失败');
        });
      } catch (error) {
        expect((error as Error).message).toBe('本次审核安排失败');
      }
      db.prepare('INSERT INTO reviews VALUES(?)').run('retry');
    });
    expect(db.prepare('SELECT id FROM versions').all()).toEqual([{ id: 'valid' }]);
    expect(db.prepare('SELECT id FROM reviews').all()).toEqual([{ id: 'retry' }]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
