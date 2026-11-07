import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { versionHeaderSchema } from '../src/contracts/versions';
import { request } from './request';
import styles from './workbench.module.css';
import { ResearchVersion } from './research';
const diffSchema = z.object({
  from: z.string(),
  to: z.string(),
  mode: z.enum(['ticket', 'repair']),
  changes: z.array(
    z.object({
      root: z.string(),
      path: z.string(),
      status: z.enum(['added', 'deleted', 'modified']),
    }),
  ),
  patch: z.string(),
});
const checkSchema = z.object({ matches: z.boolean().nullable(), error: z.string().nullable() });
export function DeliveryDiff({
  projectId,
  executionId,
  initialVersionId = '',
}: {
  projectId: string;
  executionId: string;
  initialVersionId?: string;
}) {
  const base = `/api/projects/${projectId}/executions/${executionId}/versions`,
    versions = useQuery({
      queryKey: ['versions', projectId, executionId],
      queryFn: async () => z.array(versionHeaderSchema).parse(await request(base)),
    });
  const [selected, setSelected] = useState(initialVersionId),
    [mode, setMode] = useState<'ticket' | 'repair'>('ticket'),
    [showDiff, setShowDiff] = useState(false),
    chosen = versions.data?.find((version) => version.id === selected) ?? versions.data?.at(-1);
  const diff = useQuery({
    queryKey: ['version-diff', projectId, executionId, chosen?.id, mode],
    enabled: showDiff && chosen?.kind === 'delivery',
    queryFn: async () => diffSchema.parse(await request(`${base}/${chosen!.id}/diff?mode=${mode}`)),
  });
  const check = useQuery({
    queryKey: ['version-check', projectId, executionId, chosen?.id],
    enabled: false,
    queryFn: async () => checkSchema.parse(await request(`${base}/${chosen!.id}/check`)),
  });
  if (versions.isPending) return <p role="status">正在读取固定版本…</p>;
  if (versions.isError) return <p role="alert">{versions.error.message}</p>;
  if (!chosen) return <p>尚无派工快照。既有执行缺少基线时不会用当前目录补写历史。</p>;
  return (
    <section aria-label="交付版本与差异">
      <h4>交付版本与差异</h4>
      <label>
        固定版本{' '}
        <select
          aria-label="固定版本"
          value={chosen.id}
          onChange={(event) => {
            setSelected(event.target.value);
            setShowDiff(false);
          }}
        >
          {versions.data.map((version) => (
            <option key={version.id} value={version.id}>
              {version.kind === 'baseline' ? '派工基线' : `送审版本 ${version.sequence}`} ·{' '}
              {version.createdAt}
            </option>
          ))}
        </select>
      </label>
      <p>{chosen.summary}</p>
      <p>版本ID：{chosen.id}</p>
      <p>指纹：{chosen.fingerprint}</p>
      {chosen.kind === 'delivery' && chosen.ticketKind === 'research' && (
        <ResearchVersion projectId={projectId} executionId={executionId} versionId={chosen.id} />
      )}
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>范围</th>
              <th>类型</th>
              <th>文件</th>
              <th>HEAD参考</th>
            </tr>
          </thead>
          <tbody>
            {chosen.roots.map((root) => (
              <tr key={root.root}>
                <td>{root.root}</td>
                <td>{root.kind === 'git' ? 'Git工作区' : '内容哈希原件'}</td>
                <td>{root.fileCount}</td>
                <td>{root.head ?? '无HEAD'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.actions}>
        <button
          className={styles.button}
          type="button"
          disabled={check.isFetching}
          onClick={() => void check.refetch()}
        >
          核对当前工作区
        </button>
        <button
          className={styles.button}
          type="button"
          disabled={chosen.kind !== 'delivery'}
          onClick={() => {
            setMode('ticket');
            setShowDiff(true);
          }}
        >
          整票差异
        </button>
        <button
          className={styles.button}
          type="button"
          disabled={
            chosen.kind !== 'delivery' ||
            !versions.data.some(
              (version) => version.kind === 'delivery' && version.sequence < chosen.sequence,
            )
          }
          onClick={() => {
            setMode('repair');
            setShowDiff(true);
          }}
        >
          返修差异
        </button>
      </div>
      {check.isError && <p role="alert">{check.error.message}</p>}
      {check.data && (
        <p role={check.data.matches === true ? 'status' : 'alert'}>
          {check.data.matches === true
            ? '当前工作区与所选固定版本一致。'
            : check.data.matches === false
              ? '版本不匹配：当前工作区已变化。下列差异仍来自所选固定版本，不替当前内容背书。'
              : `当前工作区无法完整核对：${check.data.error}`}
        </p>
      )}
      {chosen.kind === 'baseline' && (
        <p>派工基线已固定，尚未选择正式送审版本。完成交回由Chat办理。</p>
      )}
      {showDiff && chosen.kind === 'delivery' && (
        <>
          <h5>{mode === 'ticket' ? '派工基线 → 所选送审版本' : '上次送审 → 所选送审版本'}</h5>
          {diff.isPending && <p role="status">正在读取固定差异…</p>}
          {diff.isError && <p role="alert">{diff.error.message}</p>}
          {diff.data && (
            <>
              <p>
                共{diff.data.changes.length}个文件变化 · {diff.data.from} → {diff.data.to}
              </p>
              <ul>
                {diff.data.changes.map((file) => (
                  <li key={file.root + '/' + file.path}>
                    {file.status === 'added' ? '新增' : file.status === 'deleted' ? '删除' : '修改'}
                    ：{file.root} · {file.path}
                  </li>
                ))}
              </ul>
              <pre className={styles.filePreview}>
                {diff.data.patch || '两个固定版本没有文件差异。'}
              </pre>
            </>
          )}
        </>
      )}
    </section>
  );
}
