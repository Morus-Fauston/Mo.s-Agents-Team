import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { RecoveryCheckpoint, RecoveryPreview } from '../contracts/controls.ts';
import type { ExecutionRecord } from '../contracts/execution.ts';
import type { ProjectConnection } from './project.ts';
import { canonicalDirectory, canonicalWriteScope, withinPath } from './write-scopes.ts';
import { ProjectError } from './errors.ts';
import { ticketRequirementsHash } from '../storage/acceptance-catalog.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (rows: RecoveryCheckpoint['files']) =>
  [...rows].sort((a, b) => a.path.localeCompare(b.path, 'en'));

export function recoveryPaths(connection: ProjectConnection, execution: ExecutionRecord) {
  if (
    canonicalDirectory(execution.cwd) !== execution.cwd ||
    execution.writeScopes.some(
      (path) => canonicalWriteScope(path) !== path || !withinPath(execution.cwd, path),
    )
  )
    throw new ProjectError('RECOVERY_SCOPE_CHANGED', '原声明路径实际身份已变化，不能用新位置代替');
  const materials = connection
    .workbench()
    .materialDomains(execution.ticketId)
    .filter((domain) => domain.referenceId === execution.id)
    .map((domain) => domain.path);
  return {
    paths: [...execution.writeScopes, ...materials],
    excluded: [dirname(connection.snapshot().paths.database)],
  };
}

export function buildRecoveryCheckpoint(
  connection: ProjectConnection,
  execution: ExecutionRecord,
  files: RecoveryCheckpoint['files'],
  norms: RecoveryCheckpoint['norms'],
): RecoveryCheckpoint {
  const ticket = connection.workbench().getTicket(execution.ticketId);
  return {
    files: sorted(files),
    norms: sorted(norms),
    cwd: execution.cwd,
    writeScopes: [...execution.writeScopes].sort(),
    requirements: hash({
      definition: ticketRequirementsHash(ticket),
      materialRoot: ticket.materialRoot,
    }),
    dependencyVersionIds: connection
      .executions()
      .resolveDependencies(ticket.dependencies)
      .map((item) => item.deliveryId),
  };
}

export function compareRecovery(
  executionId: string,
  expectedRevision: number,
  stoppedControlId: string,
  before: RecoveryCheckpoint | undefined,
  after: RecoveryCheckpoint,
  paths: string[],
  offset = 0,
): RecoveryPreview {
  const compare = (left: RecoveryCheckpoint['files'], right: RecoveryCheckpoint['files']) => {
    const old = new Map(left.map((row) => [row.path, row.sha256])),
      next = new Map(right.map((row) => [row.path, row.sha256]));
    return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((path) => {
      const before = old.get(path) ?? null,
        after = next.get(path) ?? null;
      return before === after ? [] : [{ path, before, after }];
    });
  };
  const files = before
      ? compare(
          before.files.filter((row) => paths.some((root) => withinPath(root, row.path))),
          after.files,
        )
      : [],
    norms = before ? compare(before.norms, after.norms) : [],
    requirementsChanged = !!before && before.requirements !== after.requirements,
    scopeChanged =
      !!before &&
      (before.cwd !== after.cwd || hash(before.writeScopes) !== hash(after.writeScopes)),
    dependencyChanged =
      !!before && hash(before.dependencyVersionIds) !== hash(after.dependencyVersionIds);
  return {
    executionId,
    expectedRevision,
    stoppedControlId,
    fingerprint: hash({ executionId, expectedRevision, stoppedControlId, before, after }),
    hasChanges:
      !before ||
      !!files.length ||
      !!norms.length ||
      requirementsChanged ||
      scopeChanged ||
      dependencyChanged,
    baselineMissing: !before,
    requirementsChanged,
    scopeChanged,
    dependencyChanged,
    fileCount: files.length,
    files: files.slice(offset, offset + 40),
    norms,
  };
}
