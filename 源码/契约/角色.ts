import { z } from 'zod';
import { executionConfigurationSchema } from './项目.ts';
export const workflowTypeSchema = z.enum([
  'supervisor',
  'developer',
  'investigator',
  'reviewer',
  'committer',
]);
export const roleInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9-]{0,63}$/),
    name: z.string().trim().min(1).max(160),
    type: workflowTypeSchema,
    configuration: executionConfigurationSchema,
    allowChildAgents: z.boolean().default(false),
    soul: z.string().optional(),
    agent: z.string().optional(),
  })
  .strict();
export const registeredRoleSchema = z.object({
  id: z.string().regex(/^\d+$/),
  code: z.string(),
  name: z.string(),
  type: workflowTypeSchema,
  configuration: executionConfigurationSchema,
  allowChildAgents: z.literal(false),
  aliases: z.array(z.string()),
  paths: z.object({ soul: z.string(), agent: z.string() }),
});
export type RoleInput = z.input<typeof roleInputSchema>;
export type RegisteredRole = z.infer<typeof registeredRoleSchema>;
export type WorkflowType = z.infer<typeof workflowTypeSchema>;
export const roleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    configuration: executionConfigurationSchema.optional(),
  })
  .strict();
export type RoleUpdate = z.infer<typeof roleUpdateSchema>;
