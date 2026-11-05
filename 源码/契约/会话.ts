import { z } from 'zod';
import { executionConfigurationSchema } from './项目.ts';
import { workflowTypeSchema } from './角色.ts';
export const sessionInputSchema = z
  .object({
    roleId: z.string().regex(/^\d+$/),
    name: z.string().trim().min(1).max(160),
    purpose: z.string().trim().min(1).max(2000),
    cwd: z.string().min(1),
    configuration: executionConfigurationSchema.optional(),
  })
  .strict();
export const sessionSchema = z.object({
  id: z.string(),
  ordinal: z.number().int().positive(),
  roleId: z.string(),
  roleType: workflowTypeSchema,
  name: z.string(),
  purpose: z.string(),
  cwd: z.string(),
  configuration: executionConfigurationSchema,
  skillSourceRoot: z.string().nullable(),
  nativeSessionId: z.string().nullable(),
  status: z.enum(['creating', 'bound', 'failed', 'closed']),
  error: z.string().nullable(),
  addresses: z.object({ readable: z.string(), numeric: z.string() }),
});
export type SessionInput = z.infer<typeof sessionInputSchema>;
export type SessionRecord = z.infer<typeof sessionSchema>;
