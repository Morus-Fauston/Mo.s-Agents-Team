import { z } from 'zod';
import { ProjectError } from '../业务/错误.ts';
type SchemaNode = Record<string, unknown>;
/** DSH author DSL is smaller than JSON Schema. Zod remains authoritative at execution. */
function projectNode(raw: SchemaNode): SchemaNode {
  if (raw.$ref)
    throw new ProjectError('TOOL_SCHEMA_REFERENCE', '工具参数含未展开引用，不能猜测宿主格式');
  const annotations: SchemaNode = {};
  for (const key of ['title', 'description', 'default', 'examples'])
    if (Object.hasOwn(raw, key)) annotations[key] = raw[key];
  if (Array.isArray(raw.anyOf) || Array.isArray(raw.oneOf))
    return { ...annotations, oneOf: ((raw.anyOf ?? raw.oneOf) as SchemaNode[]).map(projectNode) };
  if (Array.isArray(raw.type))
    return { ...annotations, oneOf: raw.type.map((type) => projectNode({ ...raw, type })) };
  switch (raw.type) {
    case 'object':
      return {
        ...annotations,
        type: 'object',
        additionalProperties: raw.additionalProperties === true,
        properties: projectProperties(raw),
      };
    case 'array':
      return { ...annotations, type: 'array', items: projectNode(raw.items as SchemaNode) };
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return {
        ...annotations,
        type: raw.type,
        ...(raw.enum ? { enum: raw.enum } : {}),
        ...(Object.hasOwn(raw, 'const') ? { const: raw.const } : {}),
      };
    default:
      throw new ProjectError('TOOL_SCHEMA_UNSUPPORTED', '参数没有可确认的宿主类型');
  }
}
function projectProperties(raw: SchemaNode): Record<string, SchemaNode> {
  const required = Array.isArray(raw.required) ? raw.required : [];
  return Object.fromEntries(
    Object.entries((raw.properties ?? {}) as Record<string, SchemaNode>).map(([key, value]) => [
      key,
      { ...projectNode(value), ...(required.includes(key) ? { required: true } : {}) },
    ]),
  );
}
export function nativeToolParameters(schema: z.ZodType): Record<string, SchemaNode> {
  return projectProperties(z.toJSONSchema(schema, { io: 'input' }) as SchemaNode);
}
