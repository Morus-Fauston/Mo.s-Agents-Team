import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { z } from 'zod';
import {
  fixedMaterialReferenceSchema,
  materialReferenceSchema,
  ticketDeliveriesSchema,
} from '../src/contracts/ticket-deliveries';
import type { TicketDelivery } from '../src/contracts/ticket-deliveries';
import { reviewResultSchema } from '../src/contracts/review-results';
import { request } from './request';
import { DeliveryDiff } from './delivery-diff';
import styles from './workbench.module.css';

interface Preview {
  name: string;
  url: string;
  download: string;
  source: '固定送审原件' | '当前材料文件';
}
const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const add = (url: string, values: Record<string, string>) =>
  url + (url.includes('?') ? '&' : '?') + new URLSearchParams(values);

export function liveMaterialPreview(path: string, relative: string): Preview {
  const url = add(path + '/material', { path: relative });
  return { name: relative, url, download: add(url, { download: '1' }), source: '当前材料文件' };
}

export function MaterialPreview({ selected }: { selected: Preview }) {
  const [imageError, setImageError] = useState(false),
    image = /\.(png|jpe?g|webp|gif)$/i.test(selected.name),
    text = useQuery({
      queryKey: ['preview-content', selected.url],
      enabled: !image,
      queryFn: async () =>
        z
          .object({ path: z.string(), content: z.string() })
          .parse(await request(add(selected.url, { preview: 'text' }))),
      retry: false,
    });
  return (
    <section aria-label="材料内容预览" className={styles.materialPreview}>
      <h4>{basename(selected.name)}</h4>
      <p className={styles.description}>
        {selected.source} · <a href={selected.download}>下载原件</a>
      </p>
      {image ? (
        imageError ? (
          <p role="alert">图片原件不可读取或格式不支持，请核对下载原件。</p>
        ) : (
          <img
            className={styles.materialImage}
            src={add(selected.url, { preview: 'image' })}
            alt={`材料原件：${basename(selected.name)}`}
            onError={() => setImageError(true)}
          />
        )
      ) : (
        <>
          {text.isPending && <p role="status">正在读取材料原件…</p>}
          {text.isError && (
            <p role="alert" className={styles.error}>
              {text.error.message}
            </p>
          )}
          {text.data &&
            (/\.m(?:d|arkdown)$/i.test(selected.name) ? (
              <div className={styles.markdown}>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    img: ({ alt }) => <span>{alt ?? '图片引用'}（请从材料入口打开原件）</span>,
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noreferrer noopener">
                        {children}
                      </a>
                    ),
                    table: ({ children }) => (
                      <div className={styles.tableWrap}>
                        <table>{children}</table>
                      </div>
                    ),
                  }}
                >
                  {text.data.content}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className={styles.filePreview}>{text.data.content}</pre>
            ))}
        </>
      )}
    </section>
  );
}

const opinionSchema = z.object({
  result: reviewResultSchema,
  fixed: z.array(fixedMaterialReferenceSchema),
  live: z.array(materialReferenceSchema),
});
const status = (delivery: TicketDelivery) =>
  delivery.result
    ? (delivery.result.verdict === 'pass' ? '审阅通过意见' : '审阅退回意见') +
      (delivery.result.progress.state === 'confirmed' ? ' · 办理已核定' : ' · 办理待核定')
    : {
        pending: '等待审阅',
        'missing-reviewer': '待指定审阅者',
        creating: '正在准备审阅',
        starting: '审阅启动中',
        active: '审阅中',
        unknown: '审阅状态待核对',
        failed: '审阅启动异常',
        decided: '意见记录暂不可读',
        cancelled: '审阅已撤销',
      }[delivery.reviewStatus];

export function TicketDeliveryPanel({
  projectId,
  ticketPath,
  versionId,
}: {
  projectId: string;
  ticketPath: string;
  versionId: string | null;
}) {
  const [chosenId, choose] = useState<string | null>(null),
    [opinionOpen, setOpinionOpen] = useState<string | null>(null),
    [diffOpen, setDiffOpen] = useState<string | null>(null),
    [file, setFile] = useState<{ versionId: string; preview: Preview } | null>(null);
  const query = useQuery({
    queryKey: ['ticket-deliveries', projectId, ticketPath],
    queryFn: async () => ticketDeliveriesSchema.parse(await request(ticketPath + '/deliveries')),
  });
  const chosen =
    chosenId || versionId
      ? query.data?.deliveries.find((row) => row.versionId === (chosenId ?? versionId))
      : (query.data?.currentDelivery ?? null);
  const opinion = useQuery({
    queryKey: ['ticket-delivery-opinion', projectId, ticketPath, opinionOpen],
    enabled: !!opinionOpen,
    queryFn: async () =>
      opinionSchema.parse(await request(ticketPath + '/deliveries/opinion/' + opinionOpen)),
  });
  const changeVersion = (id: string | null) => {
    choose(id);
    setOpinionOpen(null);
    setDiffOpen(null);
    setFile(null);
  };
  const fixed = (delivery: TicketDelivery, ref: z.infer<typeof fixedMaterialReferenceSchema>) => {
    if (!ref.available || ref.rootIndex === null || ref.path === null) return null;
    const url = add(
      `/api/projects/${projectId}/executions/${delivery.executionId}/versions/${delivery.versionId}/file`,
      { root: String(ref.rootIndex), path: ref.path },
    );
    return { name: ref.path, url, download: url, source: '固定送审原件' as const };
  };
  const artifact = (
    ref: z.infer<typeof fixedMaterialReferenceSchema>,
    id: string,
    alternative?: string | null,
  ) => {
    const item = chosen && fixed(chosen, ref),
      preview = item ?? (alternative ? liveMaterialPreview(ticketPath, alternative) : null);
    return (
      <li key={id}>
        {preview && chosen ? (
          <button
            type="button"
            className={styles.textButton}
            onClick={() => setFile({ versionId: chosen.versionId, preview })}
          >
            {basename(preview.name)} · {preview.source}
          </button>
        ) : (
          <span>{ref.absolute} · 未找到可核定原件</span>
        )}
      </li>
    );
  };
  return (
    <section aria-label="正式交付与历史" className={styles.recordRow}>
      <h4>当前正式交付</h4>
      {query.isPending && <p role="status">正在读取正式交付记录…</p>}
      {query.isError && (
        <p role="alert" className={styles.error}>
          {query.error.message}
        </p>
      )}
      {query.data && (
        <>
          {query.data.currentDelivery ? (
            <p>
              {query.data.currentDelivery.summary} · {status(query.data.currentDelivery)}
            </p>
          ) : (
            <p>当前尝试尚无正式交付。</p>
          )}
          {query.data.deliveries.length > 0 && (
            <label>
              选择正式版本{' '}
              <select
                aria-label="选择正式版本"
                value={chosen?.versionId ?? ''}
                onChange={(e) => changeVersion(e.target.value || null)}
              >
                {!query.data.currentDelivery && <option value="">选择一份历史交付</option>}
                {[...query.data.deliveries].reverse().map((row) => (
                  <option key={row.versionId} value={row.versionId}>
                    {row.versionId === query.data.currentDelivery?.versionId ? '当前' : '历史'} ·
                    版本 {row.sequence} · {status(row)} ·{' '}
                    {row.createdAt.slice(0, 16).replace('T', ' ')}
                  </option>
                ))}
              </select>
            </label>
          )}
          {versionId && !chosen && <p role="alert">指定的正式版本不属于本票或不可读。</p>}
          {chosen && (
            <div className={styles.recordRow}>
              <h5>
                {chosen.versionId === query.data.currentDelivery?.versionId
                  ? '当前版本'
                  : '历史版本'}{' '}
                · {chosen.summary}
              </h5>
              <p>{chosen.scope}</p>
              <p>
                {chosen.author.address ?? chosen.author.roleCode} · {status(chosen)}
              </p>
              <details>
                <summary>固定版本来源</summary>
                <p>版本 {chosen.versionId}</p>
                <p>
                  执行 {chosen.executionId} · 完成 {chosen.completionId}
                </p>
                <p>审阅 {chosen.reviewId}</p>
              </details>
              {chosen.reports.length > 0 && (
                <>
                  <h5>固定报告</h5>
                  <ul>{chosen.reports.map((ref, i) => artifact(ref, 'r' + i))}</ul>
                </>
              )}
              {chosen.evidence.length > 0 && (
                <>
                  <h5>作者证据</h5>
                  <ul>{chosen.evidence.map((ref, i) => artifact(ref, 'e' + i))}</ul>
                </>
              )}
              <div className={styles.actions}>
                {chosen.result && (
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => setOpinionOpen(opinionOpen ? null : chosen.result!.id)}
                  >
                    {opinionOpen ? '收起独审意见' : '打开独审意见'}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => setDiffOpen(diffOpen ? null : chosen.versionId)}
                >
                  {diffOpen ? '收起版本差异' : '查看固定版本与代码差异'}
                </button>
              </div>
              {opinionOpen && (
                <section aria-label="正式独审意见">
                  {opinion.isPending && <p role="status">正在读取原意见…</p>}
                  {opinion.isError && (
                    <p role="alert" className={styles.error}>
                      {opinion.error.message}
                    </p>
                  )}
                  {opinion.data && opinion.data.result.versionId === chosen.versionId && (
                    <>
                      <h5>
                        {opinion.data.result.verdict === 'pass' ? '通过' : '退回'} ·{' '}
                        {opinion.data.result.author.address}
                      </h5>
                      <p>{opinion.data.result.scope}</p>
                      <p>{opinion.data.result.basis}</p>
                      {!!opinion.data.result.issues.length && (
                        <ul>
                          {opinion.data.result.issues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      )}
                      {!!opinion.data.fixed.length && (
                        <>
                          <h5>审阅证据</h5>
                          <ul>
                            {opinion.data.fixed.map((ref, i) =>
                              artifact(ref, 'o' + i, opinion.data!.live[i]?.path),
                            )}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                </section>
              )}
              {diffOpen === chosen.versionId && (
                <DeliveryDiff
                  key={chosen.versionId}
                  projectId={projectId}
                  executionId={chosen.executionId}
                  initialVersionId={chosen.versionId}
                />
              )}
              {file?.versionId === chosen.versionId && (
                <MaterialPreview key={file.preview.url} selected={file.preview} />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
