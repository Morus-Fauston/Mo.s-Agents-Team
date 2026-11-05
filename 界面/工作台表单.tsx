import { useRef, useState } from 'react';
import type { ReactNode, FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { request } from './请求';
import styles from './工作台.module.css';
export type WorkbenchCommand = (
  path: string,
  body: Record<string, unknown>,
  method?: string,
) => Promise<unknown>;
export function useWorkbenchCommand(projectId: string): WorkbenchCommand {
  const client = useQueryClient(),
    operations = useRef(new Map<string, string>());
  const mutation = useMutation({
    mutationFn: async (input: { path: string; body: Record<string, unknown>; method: string }) => {
      const key = JSON.stringify(input);
      let operationId = operations.current.get(key);
      if (!operationId) {
        operationId = crypto.randomUUID();
        operations.current.set(key, operationId);
      }
      const value = await request(input.path, { ...input.body, operationId }, input.method);
      operations.current.delete(key);
      await client.invalidateQueries({ predicate: (query) => query.queryKey.includes(projectId) });
      return value;
    },
  });
  return (path, body, method = 'POST') => mutation.mutateAsync({ path, body, method });
}
export function WorkbenchForm({
  title,
  trigger,
  children,
  onSubmit,
  description = '保存记录不会自动派工或改变票据完成事实。',
}: {
  title: string;
  trigger: string;
  children: ReactNode;
  onSubmit: (data: FormData) => Promise<unknown>;
  description?: string;
}) {
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const openedSubmit = useRef(onSubmit);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      await openedSubmit.current(data);
      setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败，输入已保留');
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!pending) {
          setOpen(value);
          if (value) {
            openedSubmit.current = onSubmit;
            setError(null);
          }
        }
      }}
    >
      <Dialog.Trigger className={styles.button}>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.configDialog}>
          <Dialog.Title className={styles.dialogTitle}>{title}</Dialog.Title>
          <Dialog.Description className={styles.description}>{description}</Dialog.Description>
          <form className={styles.form} onSubmit={(event) => void submit(event)}>
            <fieldset disabled={pending} className={styles.fieldset}>
              {children}
            </fieldset>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <Dialog.Close type="button" className={styles.button} disabled={pending}>
                取消
              </Dialog.Close>
              <button type="submit" className={styles.primary} disabled={pending}>
                {pending ? '正在保存…' : '保存'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export const text = (data: FormData, name: string) => String(data.get(name) ?? '');
export const lines = (value: string) =>
  value.split(/\r?\n/).filter((line) => line.trim().length > 0);
export function VerificationSelect({ value = 'automated' }: { value?: string }) {
  return (
    <label>
      验证方式
      <select aria-label="验证方式" name="verification" defaultValue={value}>
        <option value="automated">自动化验证</option>
        <option value="manual">用户人工确认</option>
        <option value="review">独立审阅</option>
      </select>
    </label>
  );
}
