import type { DatabaseSync } from 'node:sqlite';
const depths = new WeakMap<DatabaseSync, number>();
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  const depth = depths.get(db) ?? 0,
    savepoint = 'mat_nested_' + depth;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  depths.set(db, depth + 1);
  try {
    const result = action();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(
      depth === 0
        ? 'ROLLBACK'
        : `ROLLBACK TO SAVEPOINT ${savepoint};RELEASE SAVEPOINT ${savepoint}`,
    );
    throw error;
  } finally {
    if (depth === 0) depths.delete(db);
    else depths.set(db, depth);
  }
}
