import type { DatabaseSync } from 'node:sqlite';
import type { RequestRecord } from '../契约/装配.ts';
import { ProjectError } from '../业务/错误.ts';
export class RequestCatalog {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  save(record: RequestRecord): void {
    const previous = this.db
      .prepare('SELECT session_id FROM model_request WHERE id=?')
      .get(record.id);
    if (previous && previous.session_id !== record.sessionId)
      throw new ProjectError('REQUEST_OWNER_MISMATCH', '请求记录不能改绑会话');
    this.db
      .prepare(
        'INSERT INTO model_request(id,session_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(record.id, record.sessionId, JSON.stringify(record));
  }
  list(sessionId: string): RequestRecord[] {
    return this.db
      .prepare('SELECT data FROM model_request WHERE session_id=? ORDER BY rowid')
      .all(sessionId)
      .map((row) => JSON.parse(String(row.data)) as RequestRecord);
  }
}
