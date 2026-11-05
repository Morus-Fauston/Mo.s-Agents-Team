import type { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync, lstatSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transaction } from './事务.ts';
import { ProjectError } from '../业务/错误.ts';
import { roleInputSchema, registeredRoleSchema } from '../契约/角色.ts';
import { roleUpdateSchema } from '../契约/角色.ts';
import type { RoleInput, RegisteredRole, RoleUpdate } from '../契约/角色.ts';
export function migrateRoles(db: DatabaseSync): void {
  db.exec(`ALTER TABLE role ADD COLUMN name TEXT NOT NULL DEFAULT '';
 CREATE TABLE role_alias(alias TEXT PRIMARY KEY,role_id TEXT NOT NULL REFERENCES role(id));
 INSERT INTO role_alias(alias,role_id) SELECT code,id FROM role;
 CREATE TABLE role_preparation(code TEXT PRIMARY KEY,id TEXT NOT NULL UNIQUE,request TEXT NOT NULL);
 PRAGMA user_version=2;`);
}
function ensureDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ProjectError('UNSAFE_PATH', `角色资料祖先必须是普通目录：${path}`);
}
function document(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx' });
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ProjectError('UNSAFE_PATH', `角色资料必须是普通文件：${path}`);
}
export class RoleCatalog {
  private readonly db: DatabaseSync;
  private readonly root: string;
  constructor(db: DatabaseSync, root: string) {
    this.db = db;
    this.root = root;
  }
  private fromRow(row: Record<string, unknown>): RegisteredRole {
    const id = String(row.id);
    if (!/^\d+$/.test(id)) throw new ProjectError('INVALID_REGISTRATION', '角色数字ID无效');
    return registeredRoleSchema.parse({
      id,
      code: String(row.code),
      name: row.name || (row.type === 'supervisor' ? '项目主管' : String(row.code)),
      type: String(row.type),
      configuration: JSON.parse(String(row.configuration)),
      allowChildAgents: false,
      aliases: this.db
        .prepare('SELECT alias FROM role_alias WHERE role_id=? ORDER BY alias')
        .all(id)
        .map((a) => String(a.alias)),
      paths: {
        soul: join(this.root, '.TEAM', '角色', id, 'SOUL.md'),
        agent: join(this.root, '.TEAM', '角色', id, 'AGENT.md'),
      },
    });
  }
  list(): RegisteredRole[] {
    return this.db
      .prepare('SELECT * FROM role ORDER BY rowid')
      .all()
      .map((row) => this.fromRow(row));
  }
  get(id: string): RegisteredRole {
    const row = this.db.prepare('SELECT * FROM role WHERE id=?').get(id);
    if (!row) throw new ProjectError('ROLE_NOT_FOUND', '角色未在当前项目登记');
    return this.fromRow(row);
  }
  update(id: string, raw: RoleUpdate): RegisteredRole {
    const input = roleUpdateSchema.parse(raw);
    const previous = this.get(id);
    if (input.name === undefined && input.configuration === undefined)
      throw new ProjectError('EMPTY_ROLE_UPDATE', '没有提供需要修改的角色配置');
    return transaction(this.db, () => {
      this.db
        .prepare('UPDATE role SET name=?,configuration=? WHERE id=?')
        .run(
          input.name ?? previous.name,
          JSON.stringify(input.configuration ?? previous.configuration),
          id,
        );
      return this.get(id);
    });
  }
  register(raw: RoleInput): RegisteredRole {
    const parsed = roleInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new ProjectError('INVALID_ROLE', '请核对角色标识、名称、类型和执行配置');
    const input = parsed.data;
    if (input.allowChildAgents)
      throw new ProjectError(
        'CHILD_AGENTS_UNSUPPORTED',
        '首版不支持原生子Agent，请保持allow_child_agents=false',
      );
    const existing = this.db.prepare('SELECT * FROM role WHERE code=?').get(input.code);
    if (existing) {
      const role = this.fromRow(existing);
      if (
        role.name === input.name &&
        role.type === input.type &&
        JSON.stringify(role.configuration) === JSON.stringify(input.configuration)
      )
        return role;
      throw new ProjectError('ROLE_EXISTS', '角色标识已登记，请通过维护配置修改');
    }
    if (input.type === 'supervisor' && this.list().some((r) => r.type === 'supervisor'))
      throw new ProjectError('ONE_SUPERVISOR', '项目主管已经登记，不创建第二个主管身份');
    if (input.type === 'committer' && this.list().some((r) => r.type === 'committer'))
      throw new ProjectError('ONE_COMMITTER', '项目版本提交角色必须唯一');
    if (this.db.prepare('SELECT role_id FROM role_alias WHERE alias=?').get(input.code))
      throw new ProjectError('ROLE_ALIAS_EXISTS', '此标识仍属于另一个角色的历史地址');
    const request = JSON.stringify(input);
    const id = transaction(this.db, () => {
      const pending = this.db
        .prepare('SELECT id,request FROM role_preparation WHERE code=?')
        .get(input.code);
      if (pending) {
        if (pending.request !== request)
          throw new ProjectError(
            'ROLE_PREPARATION_PENDING',
            '角色资料准备未完成，请使用原输入重试',
          );
        return String(pending.id);
      }
      let id: string;
      do {
        id = String(randomInt(100000000, 999999999));
      } while (
        this.db
          .prepare(
            'SELECT id FROM role WHERE id=? UNION SELECT id FROM role_preparation WHERE id=?',
          )
          .get(id, id)
      );
      this.db
        .prepare('INSERT INTO role_preparation(code,id,request) VALUES(?,?,?)')
        .run(input.code, id, request);
      return id;
    });
    return transaction(this.db, () => {
      ensureDirectory(join(this.root, '.TEAM'));
      ensureDirectory(join(this.root, '.TEAM', '角色'));
      ensureDirectory(join(this.root, '.TEAM', '角色', id));
      document(join(this.root, '.TEAM', '角色', id, 'SOUL.md'), input.soul ?? '');
      document(join(this.root, '.TEAM', '角色', id, 'AGENT.md'), input.agent ?? '');
      this.db
        .prepare('INSERT INTO role(id,code,type,configuration,name) VALUES(?,?,?,?,?)')
        .run(id, input.code, input.type, JSON.stringify(input.configuration), input.name);
      this.db.prepare('INSERT INTO role_alias(alias,role_id) VALUES(?,?)').run(input.code, id);
      this.db.prepare('DELETE FROM role_preparation WHERE code=?').run(input.code);
      return this.get(id);
    });
  }
}
