import { z } from 'zod';
export async function request(path: string, body?: unknown, method = 'POST'): Promise<unknown> {
  const response = await fetch(
    path,
    body === undefined
      ? undefined
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ message: z.string() }).safeParse(data);
    throw new Error(error.success ? error.data.message : '操作未成功，请稍后重试');
  }
  return data;
}
