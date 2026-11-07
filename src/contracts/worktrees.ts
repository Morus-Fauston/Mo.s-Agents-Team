import { z } from 'zod';
import { authorSchema } from './workbench.ts';
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const worktreeCreateSchema = z
  .object({
    operationId: z.uuid(),
    ticketId: z.uuid().optional(),
    repository: z.string().min(1).optional(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9/-]*$/)
      .refine((v) => !v.split('/').some((p) => !p || p === '.' || p === '..'))
      .optional(),
    from: z.string().trim().min(1).max(256).optional(),
    basis: z.string().trim().min(1).max(8000),
  })
  .strict();
export const worktreeSourceSchema = z.object({
  repository: z.string(),
  gitDir: z.string(),
  commonDir: z.string(),
  head: oid,
  branch: z.string().nullable(),
  commit: oid,
  indexPaths: z.array(z.string()),
  changes: z.array(
    z.object({
      path: z.string(),
      x: z.string(),
      y: z.string(),
      originalPath: z.string().optional(),
    }),
  ),
});
export const worktreeResultSchema = z.object({
  path: z.string(),
  branch: z.string(),
  baseCommit: oid,
  repositoryRoot: z.string(),
});
export const worktreeCleanupInputSchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    expectedHead: oid,
    basis: z.string().trim().min(1).max(8000),
  })
  .strict();
export const worktreeCleanupSchema = z.object({
  operationId: z.uuid(),
  requestHash: z.string(),
  actor: authorSchema,
  basis: z.string(),
  head: oid,
  nativeSessionId: z.string(),
  nativeCallId: z.string().nullable(),
  state: z.enum(['running', 'unknown', 'failed', 'removed']),
  ranges: z.array(
    z.object({
      id: z.string(),
      callId: z.string(),
      nativeOwner: z.string(),
      state: z.enum(['pending', 'gone', 'unknown']),
      at: z.string(),
      note: z.string(),
    }),
  ),
  process: z
    .object({ exitCode: z.number().int().nullable(), output: z.string(), rangeGone: z.boolean() })
    .nullable(),
  proof: z
    .object({
      removed: z.boolean(),
      registered: z.boolean(),
      branchRetained: z.boolean(),
      head: oid.nullable(),
      observedAt: z.string(),
      retainedEvidence: z.boolean(),
    })
    .nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export const worktreeRecordSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  actor: authorSchema,
  ticketId: z.uuid(),
  executionId: z.uuid().nullable(),
  controlRevision: z.number().int().nullable().default(null),
  nativeCallId: z.string().nullable().default(null),
  ranges: z
    .array(
      z.object({
        id: z.string(),
        callId: z.string(),
        nativeOwner: z.string(),
        state: z.enum(['pending', 'gone', 'unknown']),
        at: z.string(),
        note: z.string(),
      }),
    )
    .default([]),
  creatorSessionId: z.uuid(),
  nativeSessionId: z.string(),
  originalCwd: z.string(),
  basis: z.string(),
  name: z.string(),
  source: worktreeSourceSchema,
  path: z.string().nullable(),
  branch: z.string().nullable(),
  status: z.enum([
    'reserved',
    'creating',
    'ready',
    'unknown',
    'missing',
    'retained',
    'removing',
    'removed',
  ]),
  revision: z.number().int().positive(),
  phases: z.array(z.object({ name: z.string(), at: z.string() })),
  error: z.string().nullable(),
  directoryPublication: z.enum(['pending', 'confirmed', 'unknown']),
  restore: z.object({
    required: z.boolean(),
    confirmed: z.boolean(),
    error: z.string().nullable(),
  }),
  associations: z.array(
    z.object({
      ticketId: z.uuid(),
      executionId: z.uuid(),
      cwd: z.string(),
      head: oid,
      baselineVersionId: z.uuid().nullable().default(null),
      changes: worktreeSourceSchema.shape.changes.default([]),
      indexPaths: z.array(z.string()).default([]),
      author: authorSchema,
      at: z.string(),
    }),
  ),
  lastInspection: z.object({ head: oid, path: z.string(), at: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  retention: z.literal('retain'),
  cleanup: worktreeCleanupSchema.nullable().default(null),
});
export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;
export type WorktreeSource = z.infer<typeof worktreeSourceSchema>;

export const worktreeReconcileSchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(8000),
  })
  .strict();
