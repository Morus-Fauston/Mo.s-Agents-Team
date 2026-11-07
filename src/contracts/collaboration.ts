import { z } from 'zod';
import { executionConfigurationSchema } from './project.ts';
import { authorSchema } from './workbench.ts';
export const assistantBodySchema = z
  .object({
    roleId: z.string().min(1).optional(),
    sessionId: z.uuid().optional(),
    name: z.string().trim().min(1).max(160),
    purpose: z.string().trim().min(1).max(2000),
    writeScopes: z.array(z.string().min(1)).max(64).default([]),
    configuration: executionConfigurationSchema.optional(),
  })
  .strict();
export const assistantInputSchema = assistantBodySchema
  .extend({ operationId: z.uuid() })
  .superRefine((v, ctx) => {
    if ((v.roleId === undefined) === (v.sessionId === undefined))
      ctx.addIssue({ code: 'custom', message: '选择一个已有角色新开或一个明确会话续用' });
    if (v.sessionId && v.configuration)
      ctx.addIssue({ code: 'custom', message: '续用保留原生配置，不静默换模' });
  });
export const assistantSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  ticketId: z.uuid(),
  executionId: z.uuid(),
  parentSessionId: z.uuid(),
  author: authorSchema,
  roleId: z.string(),
  name: z.string(),
  purpose: z.string(),
  cwd: z.string(),
  writeScopes: z.array(z.string()),
  configuration: executionConfigurationSchema.nullable(),
  reused: z.boolean(),
  requestedSessionId: z.uuid().nullable().default(null),
  sessionId: z.uuid().nullable(),
  nativeSessionId: z.string().nullable(),
  state: z.enum([
    'registered',
    'creating',
    'active',
    'reporting',
    'waiting',
    'error',
    'unknown',
    'completed',
    'terminated',
  ]),
  lastResultId: z.uuid().nullable().default(null),
  faultId: z.uuid().nullable().default(null),
  checklistGrant: z
    .object({
      ids: z.array(z.string().regex(/^C\d{3,}$/)),
      messageId: z.uuid(),
      author: authorSchema,
      createdAt: z.string(),
    })
    .nullable()
    .default(null),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantRecord = z.infer<typeof assistantSchema>;
export const collaborationFaultSchema = z.object({
  id: z.uuid(),
  collaborationId: z.uuid(),
  executionId: z.uuid(),
  parentSessionId: z.uuid(),
  error: z.string(),
  createdAt: z.string(),
  kind: z.enum(['fault', 'control']).default('fault'),
  controlId: z.uuid().optional(),
  controlStatus: z.string().optional(),
});
