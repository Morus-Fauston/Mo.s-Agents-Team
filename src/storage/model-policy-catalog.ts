import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  explicitModelChangeSchema,
  fallbackPolicySchema,
  modelChangeSchema,
  modelStateSchema,
} from '../contracts/model-policy.ts';
import type { FallbackPolicy, ModelChange, ModelState } from '../contracts/model-policy.ts';
import type { ExecutionConfiguration } from '../contracts/project.ts';
import type { SessionCatalog } from './session-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
const stamp = () => new Date().toISOString();
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function migrateModelPolicies(db: DatabaseSync) {
  db.exec(`CREATE TABLE role_model_policy(role_id TEXT PRIMARY KEY REFERENCES role(id),data TEXT NOT NULL);
 CREATE TABLE session_model_state(session_id TEXT PRIMARY KEY REFERENCES session(id),data TEXT NOT NULL);
 CREATE TABLE model_change(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES session(id),operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,data TEXT NOT NULL);
 PRAGMA user_version=15;`);
  for (const row of db.prepare('SELECT id,configuration FROM session').all()) {
    const configuration = JSON.parse(String(row.configuration));
    const value = {
      sessionId: String(row.id),
      initial: configuration,
      current: configuration,
      policy: { enabled: false, configuration: null },
      revision: 1,
      source: 'initial',
      fallbackState: 'unused',
      pendingChangeId: null,
      fallbackChangeId: null,
    };
    db.prepare('INSERT INTO session_model_state(session_id,data) VALUES(?,?)').run(
      String(row.id),
      JSON.stringify(value),
    );
  }
}
export function captureModelPolicy(
  db: DatabaseSync,
  sessionId: string,
  configuration: ExecutionConfiguration,
  policy: FallbackPolicy,
) {
  const value: ModelState = {
    sessionId,
    initial: configuration,
    current: configuration,
    policy: fallbackPolicySchema.parse(policy),
    revision: 1,
    source: 'initial',
    fallbackState: 'unused',
    pendingChangeId: null,
    fallbackChangeId: null,
  };
  db.prepare('INSERT INTO session_model_state(session_id,data) VALUES(?,?)').run(
    sessionId,
    JSON.stringify(value),
  );
}
export class ModelPolicyCatalog {
  private readonly db: DatabaseSync;
  private readonly sessions: SessionCatalog;
  constructor(db: DatabaseSync, sessions: SessionCatalog) {
    this.db = db;
    this.sessions = sessions;
  }
  state(sessionId: string): ModelState {
    this.sessions.get(sessionId);
    const row = this.db
      .prepare('SELECT data FROM session_model_state WHERE session_id=?')
      .get(sessionId);
    if (!row) throw new ProjectError('MODEL_STATE_MISSING', '会话配置来源缺失，不能猜测备用策略');
    return modelStateSchema.parse(JSON.parse(String(row.data)));
  }
  get(id: string): ModelChange {
    const row = this.db.prepare('SELECT data FROM model_change WHERE id=?').get(id);
    if (!row) throw new ProjectError('MODEL_CHANGE_MISSING', '配置切换记录不存在');
    return modelChangeSchema.parse(JSON.parse(String(row.data)));
  }
  history(sessionId: string): ModelChange[] {
    this.sessions.get(sessionId);
    return this.db
      .prepare('SELECT id FROM model_change WHERE session_id=? ORDER BY rowid')
      .all(sessionId)
      .map((row) => this.get(String(row.id)));
  }
  private saveState(s: ModelState) {
    this.db
      .prepare('UPDATE session_model_state SET data=? WHERE session_id=?')
      .run(JSON.stringify(s), s.sessionId);
  }
  private saveChange(c: ModelChange) {
    c.updatedAt = stamp();
    this.db.prepare('UPDATE model_change SET data=? WHERE id=?').run(JSON.stringify(c), c.id);
  }
  private reserve(
    s: ModelState,
    source: ModelChange['source'],
    operationId: string,
    configuration: ExecutionConfiguration,
    reason: string,
    requestHash: string,
    failure?: { failureId: string; code: string },
    modelFault: ModelChange['modelFault'] = null,
  ): ModelChange {
    if (s.pendingChangeId)
      throw new ProjectError('MODEL_CHANGE_PENDING', '原配置切换尚未核定，不能覆盖或再次尝试');
    const c: ModelChange = {
      id: randomUUID(),
      sessionId: s.sessionId,
      operationId,
      source,
      configuration,
      previous: s.current,
      reason,
      failureId: failure?.failureId ?? null,
      failureCode: failure?.code ?? null,
      modelFault,
      status: 'reserved',
      nativeSessionId: null,
      selectionSeq: null,
      durableAt: null,
      error: null,
      createdAt: stamp(),
      updatedAt: stamp(),
    };
    this.db
      .prepare(
        'INSERT INTO model_change(id,session_id,operation_id,request_hash,data) VALUES(?,?,?,?,?)',
      )
      .run(c.id, c.sessionId, c.operationId, requestHash, JSON.stringify(c));
    s.pendingChangeId = c.id;
    s.revision++;
    if (source === 'fallback') {
      s.fallbackState = 'attempting';
      s.fallbackChangeId = c.id;
    }
    this.saveState(s);
    return c;
  }
  reserveExplicit(
    sessionId: string,
    raw: unknown,
    modelFault: ModelChange['modelFault'] = null,
  ): ModelChange {
    const input = explicitModelChangeSchema.parse(raw),
      h = hash({ sessionId, input });
    return transaction(this.db, () => {
      const old = this.db
        .prepare('SELECT id,request_hash FROM model_change WHERE operation_id=?')
        .get(input.operationId);
      if (old) {
        if (old.request_hash !== h)
          throw new ProjectError('MODEL_CHANGE_CONFLICT', '操作身份已使用但切换内容不同');
        return this.get(String(old.id));
      }
      const s = this.state(sessionId);
      if (s.revision !== input.expectedRevision)
        throw new ProjectError('MODEL_REVISION_CHANGED', '会话配置修订已经变化');
      if (hash(s.current) === hash(input.configuration))
        throw new ProjectError('MODEL_CONFIGURATION_UNCHANGED', '指定配置与当前记录相同，无需切换');
      return this.reserve(
        s,
        'user',
        input.operationId,
        input.configuration,
        input.reason,
        h,
        undefined,
        modelFault,
      );
    });
  }
  reserveFallback(
    sessionId: string,
    failure: { failureId: string; code: string; message: string },
  ): ModelChange | null {
    return transaction(this.db, () => {
      const s = this.state(sessionId),
        op = 'fallback:' + sessionId + ':' + failure.failureId;
      const old = this.db.prepare('SELECT id FROM model_change WHERE operation_id=?').get(op);
      if (old) return this.get(String(old.id));
      const session = this.sessions.get(sessionId);
      if (
        session.status !== 'bound' ||
        session.communicationState !== 'active' ||
        !s.policy.enabled ||
        !s.policy.configuration ||
        s.fallbackState !== 'unused' ||
        s.pendingChangeId ||
        hash(s.current) === hash(s.policy.configuration)
      )
        return null;
      return this.reserve(
        s,
        'fallback',
        op,
        s.policy.configuration,
        failure.message,
        hash({ sessionId, failure }),
        failure,
      );
    });
  }
  confirm(
    id: string,
    proof: { nativeSessionId: string; selectionSeq: number; durableAt: string },
  ): ModelChange {
    return transaction(this.db, () => {
      const c = this.get(id),
        s = this.state(c.sessionId);
      if (c.status === 'confirmed') return c;
      if (!['reserved', 'unknown'].includes(c.status) || s.pendingChangeId !== id)
        throw new ProjectError('MODEL_CHANGE_SUPERSEDED', '原切换已失效，不能办理当前配置');
      if (
        this.sessions.get(c.sessionId).nativeSessionId !== proof.nativeSessionId ||
        !Number.isSafeInteger(proof.selectionSeq) ||
        proof.selectionSeq < 0 ||
        !Number.isFinite(Date.parse(proof.durableAt))
      )
        throw new ProjectError('MODEL_CHANGE_PROOF', '原生切换身份或持久证据不符');
      Object.assign(c, proof, { status: 'confirmed', error: null });
      this.saveChange(c);
      s.current = c.configuration;
      s.source = c.source;
      s.pendingChangeId = null;
      s.revision++;
      s.fallbackState = c.source === 'fallback' ? 'selected' : 'unused';
      if (c.source === 'user') s.fallbackChangeId = null;
      this.saveState(s);
      return c;
    });
  }
  selected(id: string, proof: { nativeSessionId: string; selectionSeq: number }): ModelChange {
    return transaction(this.db, () => {
      const c = this.get(id),
        s = this.state(c.sessionId);
      if (c.status === 'confirmed') return c;
      if (
        s.pendingChangeId !== id ||
        !['reserved', 'unknown'].includes(c.status) ||
        this.sessions.get(c.sessionId).nativeSessionId !== proof.nativeSessionId ||
        !Number.isSafeInteger(proof.selectionSeq) ||
        proof.selectionSeq < 0
      )
        throw new ProjectError('MODEL_CHANGE_PROOF', '原生配置选择不属于原会话待核对操作');
      Object.assign(c, proof);
      this.saveChange(c);
      return c;
    });
  }
  problem(id: string, note: string, definite = false): ModelChange {
    return transaction(this.db, () => {
      const c = this.get(id),
        s = this.state(c.sessionId);
      if (c.status === 'confirmed' || s.pendingChangeId !== id) return c;
      c.status = definite ? 'failed' : 'unknown';
      c.error = note;
      this.saveChange(c);
      s.revision++;
      if (c.source === 'fallback') s.fallbackState = definite ? 'failed' : 'unknown';
      if (definite) s.pendingChangeId = null;
      this.saveState(s);
      return c;
    });
  }
  fallbackFailed(sessionId: string, note: string) {
    const s = this.state(sessionId);
    if (s.fallbackState !== 'selected') return;
    s.fallbackState = 'failed';
    s.revision++;
    this.saveState(s);
    const c = s.fallbackChangeId ? this.get(s.fallbackChangeId) : null;
    if (c) {
      c.error = note;
      this.saveChange(c);
    }
  }
}
