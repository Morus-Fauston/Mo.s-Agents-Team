import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connectProject } from '../src/services/project.ts';
test('0.1.0数据库升级保留项目角色身份与原规范，升级后能登记会话', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-migration-'));
  const team = join(root, '.TEAM');
  const role = join(team, '角色', '123456789');
  mkdirSync(role, { recursive: true });
  mkdirSync(join(team, '运行数据'));
  writeFileSync(join(team, 'TEAM.md'), '用户原有项目资料');
  writeFileSync(join(role, 'SOUL.md'), '');
  writeFileSync(join(role, 'AGENT.md'), '用户原有角色准则');
  const database = new DatabaseSync(join(team, '运行数据', 'mat.db'));
  database.exec(`CREATE TABLE project(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,attached INTEGER NOT NULL DEFAULT 0 CHECK(attached IN(0,1)),started INTEGER NOT NULL DEFAULT 0 CHECK(started IN(0,1)));
 CREATE TABLE role(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,type TEXT NOT NULL,configuration TEXT NOT NULL);
 CREATE TABLE initialization(singleton INTEGER PRIMARY KEY CHECK(singleton=1),project_id TEXT NOT NULL,role_id TEXT NOT NULL,request TEXT NOT NULL);
 INSERT INTO project VALUES(1,'987654321','升级项目',1,0);PRAGMA user_version=1;`);
  database
    .prepare('INSERT INTO role VALUES(?,?,?,?)')
    .run('123456789', 'SUP', 'supervisor', JSON.stringify({ provider: 'p', model: 'legacy' }));
  database.close();
  const connection = connectProject(root);
  try {
    expect(connection.snapshot().id).toBe('987654321');
    expect(connection.roles()[0]!.id).toBe('123456789');
    expect(connection.roles()[0]!.aliases).toEqual(['SUP']);
    expect(readFileSync(join(team, 'TEAM.md'), 'utf8')).toBe('用户原有项目资料');
    expect(readFileSync(join(role, 'AGENT.md'), 'utf8')).toBe('用户原有角色准则');
    const session = connection.reserveSession({
      roleId: '123456789',
      name: '升级后',
      purpose: '配置验证',
      cwd: root,
    });
    expect(session.configuration.model).toBe('legacy');
    expect(connection.requests(session.id)).toEqual([]);
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});
