import { z } from 'zod';
import { executionConfigurationSchema } from './project.ts';
export const fallbackPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    configuration: executionConfigurationSchema.nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.enabled && !v.configuration)
      ctx.addIssue({ code: 'custom', message: '启用降级必须指定单一备用配置' });
  });
export const explicitModelChangeSchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    configuration: executionConfigurationSchema,
    reason: z.string().trim().min(1).max(4000),
  })
  .strict();
export const modelStateSchema = z.object({
  sessionId: z.string(),
  initial: executionConfigurationSchema,
  current: executionConfigurationSchema,
  policy: fallbackPolicySchema,
  revision: z.number().int().positive(),
  source: z.enum(['initial', 'user', 'fallback']),
  fallbackState: z.enum(['unused', 'attempting', 'selected', 'failed', 'unknown']),
  pendingChangeId: z.uuid().nullable(),
  fallbackChangeId: z.uuid().nullable(),
});
export const modelChangeSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  operationId: z.string(),
  source: z.enum(['user', 'fallback']),
  configuration: executionConfigurationSchema,
  previous: executionConfigurationSchema,
  reason: z.string(),
  failureId: z.string().nullable(),
  failureCode: z.string().nullable(),
  modelFault: z
    .object({
      nativeSessionId: z.string(),
      turnEndSeq: z.number().int().nonnegative(),
      error: z.string(),
    })
    .nullable()
    .default(null),
  status: z.enum(['reserved', 'confirmed', 'failed', 'unknown']),
  nativeSessionId: z.string().nullable(),
  selectionSeq: z.number().int().nonnegative().nullable(),
  durableAt: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>;
export type ModelState = z.infer<typeof modelStateSchema>;
export type ModelChange = z.infer<typeof modelChangeSchema>;
