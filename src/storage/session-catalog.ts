import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { realpathSync, lstatSync } from 'node:fs';
import { isAbsolute as absolutePath } from 'node:path';
import { transaction } from './transaction.ts';
import { RoleCatalog } from './role-catalog.ts';
import { sessionInputSchema, sessionSchema } from '../contracts/sessions.ts';
import type { SessionInput, SessionRecord } from '../contracts/sessions.ts';
import { ProjectError } from '../services/errors.ts';
export function migrateSessions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL UNIQUE,role_id TEXT NOT NULL REFERENCES role(id),role_type TEXT NOT NULL,role_code TEXT NOT NULL,name TEXT NOT NULL,purpose TEXT NOT NULL,cwd TEXT NOT NULL,configuration TEXT NOT NULL,native_session_id TEXT UNIQUE,status TEXT NOT NULL CHECK(status IN('creating','bound','failed','closed')),error TEXT);
 ALTER TABLE project ADD COLUMN skill_source_root TEXT;
 ALTER TABLE session ADD COLUMN skill_source_root TEXT;
 CREATE TABLE model_request(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES session(id),data TEXT NOT NULL);
 PRAGMA user_version=3;`);
}
export class SessionCatalog {
  private readonly db: DatabaseSync;
  private readonly roles: RoleCatalog;
  constructor(db: DatabaseSync, roles: RoleCatalog) {
    this.db = db;
    this.roles = roles;
  }
  private fromRow(row: Record<string, unknown>): SessionRecord {
    return sessionSchema.parse({
      id: String(row.id),
      ordinal: Number(row.ordinal),
      roleId: String(row.role_id),
      roleType: String(row.role_type),
      name: String(row.name),
      purpose: String(row.purpose),
      cwd: String(row.cwd),
      configuration: JSON.parse(String(row.configuration)),
      skillSourceRoot: row.skill_source_root === null ? null : String(row.skill_source_root),
      nativeSessionId: row.native_session_id === null ? null : String(row.native_session_id),
      status: String(row.status),
      error: row.error === null ? null : String(row.error),
      communicationState: String(row.communication_state ?? 'active'),
      addresses: {
        readable: `${String(row.role_code)}#${Number(row.ordinal)}`,
        numeric: `${String(row.role_id)}#${Number(row.ordinal)}`,
      },
    });
  }
  list(): SessionRecord[] {
    return this.db
      .prepare('SELECT * FROM session ORDER BY ordinal')
      .all()
      .map((row) => this.fromRow(row));
  }
  get(id: string): SessionRecord {
    const row = this.db.prepare('SELECT * FROM session WHERE id=?').get(id);
    if (!row) throw new ProjectError('SESSION_NOT_FOUND', '会话未在当前项目登记');
    return this.fromRow(row);
  }
  reserve(raw: SessionInput): SessionRecord {
    const input = sessionInputSchema.parse(raw);
    const role = this.roles.get(input.roleId);
    if (!absolutePath(input.cwd)) throw new ProjectError('INVALID_CWD', '工作目录必须为绝对路径');
    const cwd = realpathSync(input.cwd);
    if (!lstatSync(cwd).isDirectory()) throw new ProjectError('INVALID_CWD', '工作目录不是目录');
    return transaction(this.db, () => {
      const ordinal = Number(
        this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS next FROM session').get()?.next,
      );
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO session(id,ordinal,role_id,role_type,role_code,name,purpose,cwd,configuration,status) VALUES(?,?,?,?,?,?,?,?,?,'creating')`,
        )
        .run(
          id,
          ordinal,
          role.id,
          role.type,
          role.code,
          input.name,
          input.purpose,
          cwd,
          JSON.stringify(input.configuration ?? role.configuration),
        );
      this.db
        .prepare(
          'UPDATE session SET skill_source_root=(SELECT skill_source_root FROM project WHERE singleton=1) WHERE id=?',
        )
        .run(id);
      return this.get(id);
    });
  }
  bind(id: string, nativeSessionId: string): SessionRecord {
    return transaction(this.db, () => {
      const record = this.get(id);
      if (record.status !== 'creating')
        throw new ProjectError('SESSION_ALREADY_BOUND', '会话已经办理，不重复绑定');
      this.db
        .prepare("UPDATE session SET native_session_id=?,status='bound' WHERE id=?")
        .run(nativeSessionId, id);
      return this.get(id);
    });
  }
  fail(id: string, error: string): SessionRecord {
    this.get(id);
    this.db.prepare("UPDATE session SET status='failed',error=? WHERE id=?").run(error, id);
    return this.get(id);
  }
  executionError(id: string, error: string | null): void {
    this.get(id);
    this.db.prepare('UPDATE session SET error=? WHERE id=?').run(error, id);
  }
  communicationState(id: string, state: SessionRecord['communicationState']): void {
    this.get(id);
    if (!['active', 'paused', 'terminated', 'archived'].includes(state))
      throw new ProjectError('INVALID_COMMUNICATION_STATE', '无效的通信门禁状态');
    this.db.prepare('UPDATE session SET communication_state=? WHERE id=?').run(state, id);
  }
  close(id: string): void {
    this.get(id);
    this.db.prepare("UPDATE session SET status='closed' WHERE id=?").run(id);
  }
}
