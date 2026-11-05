import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectProject, initializeProject, ProjectError, resolveProjectRoot } from './项目.ts';
import type { InitializeInput, ProjectConnection, ProjectView } from './项目.ts';
import type { ProjectEntry } from '../契约/项目.ts';
export class ProjectService {
  private readonly connections = new Map<string, ProjectConnection>();
  private readonly failures = new Map<string, string>();
  private readonly registry: string;
  private roots: string[];
  private closed = false;
  constructor(stateDirectory: string) {
    mkdirSync(stateDirectory, { recursive: true });
    this.registry = join(stateDirectory, '项目目录.json');
    const saved: unknown = existsSync(this.registry)
      ? JSON.parse(readFileSync(this.registry, 'utf8'))
      : [];
    if (!Array.isArray(saved) || saved.some((root) => typeof root !== 'string'))
      throw new ProjectError('INVALID_REGISTRY', '插件项目目录登记损坏，请核对原文件');
    this.roots = [...new Set(saved as string[])];
    for (const root of this.roots) {
      let connection: ProjectConnection | undefined;
      try {
        connection = connectProject(root);
        this.requireUniqueIdentity(connection.snapshot());
        this.connections.set(root, connection);
      } catch (error) {
        connection?.close();
        this.failures.set(root, String(error));
      }
    }
  }
  private requireUniqueIdentity(project: ProjectView): void {
    for (const connection of this.connections.values()) {
      const existing = connection.snapshot();
      if (existing.id === project.id && existing.root !== project.root)
        throw new ProjectError(
          'PROJECT_ID_ALREADY_ATTACHED',
          '同一项目身份已经绑定另一个宿主根，请核对迁移或工作树关联，不复制项目登记',
        );
    }
  }
  forProject(id: string): ProjectConnection {
    this.requireOpen();
    for (const connection of this.connections.values())
      if (connection.snapshot().id === id) return connection;
    throw new ProjectError('PROJECT_NOT_FOUND', '项目未接入当前插件');
  }
  private requireOpen(): void {
    if (this.closed) throw new ProjectError('SERVICE_CLOSED', '项目服务已经关闭');
  }
  list(): ProjectEntry[] {
    this.requireOpen();
    return this.roots.map((root) => {
      const connection = this.connections.get(root);
      return connection
        ? connection.snapshot()
        : { root, unavailable: true, error: this.failures.get(root) ?? '项目未连接' };
    });
  }
  attach(inputRoot: string): ProjectView {
    this.requireOpen();
    const root = resolveProjectRoot(inputRoot);
    const existing = this.connections.get(root);
    if (existing) return existing.snapshot();
    const connection = connectProject(root);
    try {
      this.requireUniqueIdentity(connection.snapshot());
      const next = [...new Set([...this.roots, root])];
      const temporary = `${this.registry}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(next, null, 2), { flag: 'wx', encoding: 'utf8' });
      renameSync(temporary, this.registry);
      this.roots = next;
      this.connections.set(root, connection);
      this.failures.delete(root);
      return connection.snapshot();
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  create(input: InitializeInput): ProjectView {
    this.requireOpen();
    initializeProject(input);
    return this.attach(input.root);
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      for (const connection of this.connections.values()) connection.close();
      this.connections.clear();
    }
  }
}
