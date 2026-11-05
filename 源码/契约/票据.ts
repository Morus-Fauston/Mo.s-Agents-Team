import { z } from 'zod';
export const ticketStates = [
  'todo',
  'in-progress',
  'blocked',
  'awaiting-review',
  'review-passed',
  'awaiting-acceptance',
  'completed',
  'archived',
] as const;
export const ticketStateSchema = z.enum(ticketStates);
export const verificationSchema = z.enum(['automated', 'manual', 'review']);
export const logTypeSchema = z.enum([
  'progress',
  'discovery',
  'judgment',
  'verification',
  'problem',
  'continuation',
]);
export const importanceSchema = z.enum(['normal', 'important', 'critical']);
export const operationSchema = z.object({ operationId: z.uuid() });
const text = z.string().refine((value) => value.trim().length > 0, '内容不能为空');
const title = z.string().trim().min(1).max(160);
export const conditionInputSchema = z
  .object({ condition: text, verification: verificationSchema })
  .strict();
export const phaseInputSchema = operationSchema
  .extend({
    name: title,
    goal: text,
    basis: text,
    note: z.string().default(''),
    parentId: z.uuid().optional(),
    checklist: z.array(conditionInputSchema).default([]),
  })
  .strict();
export const categoryInputSchema = operationSchema
  .extend({ code: z.string().regex(/^[A-Z]{1,16}$/), name: title })
  .strict();
export const ticketInputSchema = operationSchema
  .extend({
    phaseId: z.uuid(),
    categoryId: z.uuid(),
    title,
    goal: text,
    included: text,
    excluded: z.string(),
    dependencies: z.array(z.uuid()).default([]),
    conditions: z.array(conditionInputSchema).min(1),
    supplementOf: z.uuid().optional(),
  })
  .strict();
export const ticketUpdateSchema = operationSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    reason: text,
    phaseId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    title: title.optional(),
    goal: text.optional(),
    included: text.optional(),
    excluded: z.string().optional(),
    dependencies: z.array(z.uuid()).optional(),
  })
  .strict();
export const logInputSchema = z
  .object({
    title,
    content: text,
    type: logTypeSchema.default('progress'),
    importance: importanceSchema.default('normal'),
    references: z.array(z.string().min(1)).default([]),
    corrects: z
      .string()
      .regex(/^L\d{3,}$/)
      .optional(),
  })
  .strict();
export const appendLogSchema = operationSchema.extend(logInputSchema.shape).strict();
export const logUpdateSchema = operationSchema
  .extend({
    reason: text,
    type: logTypeSchema.optional(),
    importance: importanceSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export const checklistUpdateSchema = operationSchema
  .extend({
    updates: z
      .array(
        z
          .object({
            id: z.string().regex(/^C\d{3,}$/),
            expectedRevision: z.number().int().positive(),
            checked: z.boolean(),
            result: text,
          })
          .strict(),
      )
      .min(1),
    logId: z
      .string()
      .regex(/^L\d{3,}$/)
      .optional(),
    newLog: logInputSchema.optional(),
  })
  .strict();
export const conditionUpdateSchema = operationSchema
  .extend(conditionInputSchema.shape)
  .extend({ expectedRevision: z.number().int().positive(), reason: text })
  .strict();
export const feedbackInputSchema = operationSchema
  .extend({
    title,
    content: text,
    scenario: z.string().optional(),
    expected: z.string().optional(),
    references: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const authorSchema = z.object({
  kind: z.enum(['user', 'session']),
  sessionId: z.string().nullable(),
  roleId: z.string().nullable(),
  roleCode: z.string().nullable(),
  roleType: z.string().nullable(),
  address: z.string().nullable(),
});
export type WorkbenchActor = { kind: 'user' } | { kind: 'session'; sessionId: string };
export type RecordAuthor = z.infer<typeof authorSchema>;
export const checklistItemSchema = conditionInputSchema.extend({
  id: z.string(),
  revision: z.number(),
  checked: z.boolean(),
  result: z.string(),
  logId: z.string().nullable(),
  author: authorSchema.nullable(),
  updatedAt: z.string().nullable(),
});
export const phaseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  goal: z.string(),
  basis: z.string(),
  note: z.string(),
  parentId: z.string().nullable(),
  state: z.enum(['unopened', 'opened', 'closing', 'closed']),
  checklist: z.array(checklistItemSchema),
  author: authorSchema,
  createdAt: z.string(),
  revision: z.number(),
});
export const categorySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  author: authorSchema,
  createdAt: z.string(),
});
export const ticketSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  phaseId: z.uuid(),
  categoryId: z.uuid(),
  title: z.string(),
  goal: z.string(),
  included: z.string(),
  excluded: z.string(),
  dependencies: z.array(z.string()),
  supplementOf: z.string().nullable(),
  state: ticketStateSchema,
  revision: z.number(),
  checklist: z.array(checklistItemSchema),
  author: authorSchema,
  createdAt: z.string(),
  currentExecution: z.string().nullable(),
  materialRoot: z.string(),
});
export const logSchema = logInputSchema.omit({ corrects: true }).extend({
  id: z.string(),
  ticketId: z.uuid(),
  corrects: z.string().nullable(),
  archived: z.boolean(),
  archiveReason: z.string().nullable(),
  author: authorSchema,
  createdAt: z.string(),
  executionId: z.string().nullable(),
});
export const feedbackSchema = feedbackInputSchema.omit({ operationId: true }).extend({
  id: z.string(),
  author: authorSchema,
  createdAt: z.string(),
  executionId: z.string().nullable(),
  background: z.object({
    configuration: z.record(z.string(), z.unknown()).nullable(),
    requestId: z.string().nullable(),
    nativeSessionId: z.string().nullable(),
  }),
});
export const historyEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  objectId: z.string(),
  actor: authorSchema,
  at: z.string(),
  reason: z.string(),
  references: z.array(z.string()),
  corrects: z.string().nullable(),
});
export const supervisorTaskSchema = z.object({
  id: z.uuid(),
  level: z.enum(['long', 'short']),
  title: z.string(),
  parentId: z.string().nullable(),
  state: z.enum(['unchecked', 'held', 'checked']),
  basis: z.string(),
  ticketIds: z.array(z.string()),
  author: authorSchema,
  createdAt: z.string(),
  revision: z.number(),
});
export type PhaseRecord = z.infer<typeof phaseSchema>;
export type TicketRecord = z.infer<typeof ticketSchema>;
export type LogRecord = z.infer<typeof logSchema>;
export type ChecklistItem = z.infer<typeof checklistItemSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type SupervisorTask = z.infer<typeof supervisorTaskSchema>;
export const materialDomainSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  sessionId: z.uuid(),
  roleId: z.string(),
  roleCode: z.string(),
  address: z.string(),
  kind: z.enum(['main', 'assistant', 'review']),
  referenceId: z.string(),
  relativePath: z.string(),
  path: z.string(),
  available: z.boolean(),
  error: z.string().nullable(),
});
export type MaterialDomain = z.infer<typeof materialDomainSchema>;
