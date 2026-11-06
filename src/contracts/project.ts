import { z } from 'zod';
export const executionConfigurationSchema = z
  .object({
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    reasoningEffort: z.string().optional(),
  })
  .strict();
export const initializeSchema = z
  .object({
    root: z.string().min(1),
    name: z.string().trim().min(1).max(160),
    supervisor: executionConfigurationSchema,
  })
  .strict();
const roleSchema = z.object({
  id: z.string().regex(/^\d+$/),
  code: z.string(),
  type: z.string(),
  configuration: executionConfigurationSchema,
  paths: z.object({ soul: z.string(), agent: z.string() }),
});
export const projectSchema = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string(),
  root: z.string(),
  attached: z.boolean(),
  started: z.boolean(),
  roles: z.array(roleSchema),
  paths: z.object({ team: z.string(), database: z.string() }),
});
export const projectEntrySchema = z.union([
  projectSchema,
  z.object({ root: z.string(), unavailable: z.literal(true), error: z.string() }),
]);
export type ExecutionConfiguration = z.infer<typeof executionConfigurationSchema>;
export type InitializeInput = z.infer<typeof initializeSchema>;
export type RoleView = z.infer<typeof roleSchema>;
export type ProjectView = z.infer<typeof projectSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
