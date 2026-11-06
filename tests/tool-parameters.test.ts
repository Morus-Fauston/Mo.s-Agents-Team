import { expect, test } from 'vitest';
import { z } from 'zod';
import { nativeToolParameters } from '../src/host/tool-parameters.ts';
test('DSH参数投影使用逐属性required标记，嵌套对象显式封闭，业务格式仍由Zod校验', () => {
  const schema = z
    .object({
      optional: z.uuid().optional(),
      entry: z
        .object({ title: z.string().min(1), references: z.array(z.string()).default([]) })
        .strict(),
    })
    .strict();
  const projected = nativeToolParameters(schema);
  expect(projected.optional).not.toHaveProperty('required');
  expect(projected.optional).not.toHaveProperty('format');
  expect(projected.entry).toMatchObject({
    type: 'object',
    required: true,
    additionalProperties: false,
    properties: {
      title: { type: 'string', required: true },
      references: { type: 'array', items: { type: 'string' } },
    },
  });
  expect(() => schema.parse({ entry: { title: '' } })).toThrow();
  expect(() => schema.parse({ optional: 'not-a-uuid', entry: { title: '合法标题' } })).toThrow();
});
