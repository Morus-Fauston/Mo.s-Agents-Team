import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/services/project-service.ts';
export function localCommitFixture() {
  const base = resolve('E:/MAT-Test');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'mat-local-commit-')),
    root = join(directory, 'project');
  mkdirSync(root);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(root, '.git', 'test-global');
  const git = (...args: string[]) =>
    execFileSync('git', ['--literal-pathspecs', '-C', root, ...args], {
      env,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'MAT isolated test');
  git('config', 'user.email', 'mat-test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.safecrlf', 'false');
  git('config', 'core.fsmonitor', 'false');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.git', 'test-hooks'));
  git('config', 'core.hooksPath', join(root, '.git', 'test-hooks'));
  git('config', 'core.attributesFile', join(root, '.git', 'test-attributes'));
  writeFileSync(join(root, 'a.txt'), 'local baseline\n');
  writeFileSync(join(root, 'keep.txt'), 'unrelated work\n');
  const projects = new ProjectService(join(directory, 'state'), root),
    project = projects.create({
      root,
      name: '本地提交单元夹具',
      supervisor: { provider: 'unit', model: 'unit' },
    }),
    c = projects.forProject(project.id);
  const manager = c.reserveSession({
    roleId: c.roles()[0]!.id,
    name: '主管',
    purpose: '本地安排',
    cwd: root,
  });
  c.bindSession(manager.id, 'unit-local-manager');
  c.controls().startProject(
    { kind: 'user' },
    { operationId: randomUUID(), reason: '本地提交测试' },
    'unit',
  );
  c.controls().projectReady('unit', manager.id);
  const role = c.registerRole({
      code: 'COM',
      type: 'committer',
      name: '提交',
      configuration: { provider: 'unit', model: 'unit' },
    }),
    worker = c.reserveSession({
      roleId: role.id,
      name: '提交入口',
      purpose: '获准本地事项',
      cwd: root,
    });
  c.bindSession(worker.id, 'unit-local-committer');
  const devRole = c.registerRole({
      code: 'DEV',
      type: 'developer',
      name: '开发',
      configuration: { provider: 'unit', model: 'unit' },
    }),
    developer = c.reserveSession({
      roleId: devRole.id,
      name: '开发入口',
      purpose: '无提交安排权',
      cwd: root,
    });
  c.bindSession(developer.id, 'unit-local-developer');
  return {
    directory,
    root,
    projects,
    project,
    c,
    manager,
    worker,
    developer,
    role,
    git,
    write: (p: string, v: string) => writeFileSync(join(root, p), v),
    close() {
      projects.close();
      if (
        dirname(resolve(directory)) !== base ||
        !basename(directory).startsWith('mat-local-commit-')
      )
        throw new Error('拒绝清理非本夹具目录');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
