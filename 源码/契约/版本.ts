import { z } from 'zod';
import { authorSchema, ticketSchema } from './票据.ts';
export const snapshotFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  mode: z.enum(['100644', '100755']),
  objectId: z.string().nullable(),
});
export const snapshotRootSchema = z.object({
  root: z.string(),
  kind: z.enum(['git', 'files']),
  head: z.string().nullable(),
  tree: z.string().nullable(),
  ref: z.string().nullable(),
  files: z.array(snapshotFileSchema),
});
export const workspaceSnapshotSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  fingerprint: z.string(),
  roots: z.array(snapshotRootSchema),
  excluded: z.array(z.string()),
});
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
export type SnapshotRoot = z.infer<typeof snapshotRootSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export interface SnapshotInput {
  cwd: string;
  storage: string;
  additionalRepositories?: string[];
  materialRoots?: string[];
  excluded?: string[];
  maxFiles?: number;
  maxBytes?: number;
}
export interface WorkspaceDiff {
  changes: {
    root: string;
    path: string;
    status: 'added' | 'deleted' | 'modified';
    before: string | null;
    after: string | null;
  }[];
  patch: string;
}
export const deliveryVersionInputSchema = z
  .object({
    operationId: z.uuid(),
    summary: z.string().trim().min(1).max(32768),
    scope: z.string().trim().min(1).max(32768),
    evidencePaths: z.array(z.string().min(1)).max(1000).default([]),
    checklistItemIds: z.array(z.string().min(1)).max(1000).default([]),
  })
  .strict();
export const deliveryVersionSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  executionId: z.uuid(),
  kind: z.enum(['baseline', 'delivery']),
  sequence: z.number().int().nonnegative(),
  actor: authorSchema,
  ticket: ticketSchema,
  summary: z.string(),
  scope: z.string(),
  evidencePaths: z.array(z.string()),
  checklistItemIds: z.array(z.string().min(1)),
  snapshot: workspaceSnapshotSchema,
  createdAt: z.string(),
});
export type DeliveryVersion = z.infer<typeof deliveryVersionSchema>;
export const versionHeaderSchema = deliveryVersionSchema
  .pick({
    id: true,
    executionId: true,
    kind: true,
    sequence: true,
    summary: true,
    scope: true,
    createdAt: true,
  })
  .extend({
    fingerprint: z.string(),
    roots: z.array(
      snapshotRootSchema
        .omit({ files: true })
        .extend({ fileCount: z.number().int().nonnegative() }),
    ),
  });
