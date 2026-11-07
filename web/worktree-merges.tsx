import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { worktreeMergeSchema } from '../src/contracts/worktree-merges';
import { request } from './request';
import styles from './workbench.module.css';
const labels = {
  arranged: '已安排，待核对',
  ready: '原现场已就绪',
  unknown: '结果待核定',
  conflict: '合入未完成，待交接业务冲突',
  repairing: '开发者修正中',
  'awaiting-verification': 'Git 已合入，等待组合核验',
  completed: '合入及组合核验已办结',
  blocked: '待协调，尚未核定合入',
  cancelled: '原安排已撤销，未表示合入完成',
};
export function WorktreeMergeDetail({ base, id }: { base: string; id: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['worktree-merge', base, id],
    enabled: open,
    refetchInterval: 3000,
    queryFn: async () =>
      z
        .object({ arrangement: worktreeMergeSchema, history: z.array(z.unknown()) })
        .parse(await request(base + `/worktree-merges/${id}`)),
  });
  const v = q.data?.arrangement;
  return (
    <section>
      <button type="button" className={styles.textButton} onClick={() => setOpen(!open)}>
        {open ? '收起' : '查看'}跨树合入与组合结果
      </button>
      {open && (
        <>
          {q.isPending && <p role="status">正在读取原合入…</p>}
          {q.isError && <p role="alert">读取失败：{q.error.message}</p>}
          {v && (
            <>
              <h5>{labels[v.status]}</h5>
              <p>{v.basis}</p>
              <dl className={styles.facts}>
                <dt>原安排</dt>
                <dd>
                  {v.id} · 修订 {v.revision}
                </dd>
                <dt>源工作树</dt>
                <dd>{v.preview.plan.source.repository}</dd>
                <dt>源固定版本与意见</dt>
                <dd>
                  {v.preview.source.versionId}
                  <br />
                  {v.preview.source.resultId}
                </dd>
                <dt>明确源 commit</dt>
                <dd>{v.preview.plan.sourceCommit}</dd>
                <dt>目标</dt>
                <dd>
                  {v.preview.plan.target.repository}
                  <br />
                  {v.preview.plan.target.branch}
                </dd>
                <dt>原目标 HEAD</dt>
                <dd>{v.preview.plan.target.head}</dd>
                <dt>合入方式</dt>
                <dd>
                  {
                    {
                      'already-contained': '源提交原已包含，不重复写 Git',
                      'fast-forward': '普通合入，可 fast-forward',
                      merge: '普通双亲 merge，保留历史',
                    }[v.preview.plan.mode]
                  }
                </dd>
                <dt>主管与提交实际会话</dt>
                <dd>
                  {v.managerSessionId}
                  <br />
                  {v.committerSessionId}
                </dd>
                <dt>现场核对</dt>
                <dd>{v.lastInspection?.note ?? '尚未核对'}</dd>
                <dt>Git 独立回读</dt>
                <dd>
                  {v.lastProof?.state === 'verified' ? '原输入与结果已核定' : '尚未核定已合入'}
                  <br />
                  {v.lastProof?.reason}
                  <br />
                  {v.lastProof?.resultHead}
                </dd>
                <dt>原合入已核定记录</dt>
                <dd>
                  {v.integrated ? `${v.integrated.head} · ${v.integrated.observedAt}` : '尚未核定'}
                  <br />
                  后续必要提交回执 {v.correctionReceiptIds.length} 项。
                </dd>
                <dt>原生在途</dt>
                <dd>
                  {v.lastQuiescence?.state === 'confirmed' ? '已核定安静' : '尚未核定'} ·{' '}
                  {v.lastQuiescence?.note}
                </dd>
                <dt>提交者回报</dt>
                <dd>{v.report?.content ?? '尚未回报'}</dd>
              </dl>
              <details>
                <summary>原输入路径及 Git 结果</summary>
                <p>
                  预计变化 {v.preview.plan.changedPaths.length} 项。预核冲突{' '}
                  {v.preview.plan.conflictPaths.length} 项。
                </p>
                <ul>
                  {v.preview.plan.changedPaths.map((path) => (
                    <li key={path}>
                      {path}
                      {v.preview.plan.conflictPaths.includes(path) && ' · 预核冲突'}
                    </li>
                  ))}
                </ul>
                <p>实际 MERGE_HEAD：{v.lastProof?.mergeHeads.join('、') || '无或尚未核对'}。</p>
                <p>实际未解决路径：{v.lastProof?.conflictPaths.join('、') || '无或尚未核对'}。</p>
                <p>结果父提交：{v.lastProof?.parents.join('、') || '尚未核对'}。</p>
              </details>
              <h5>业务冲突修正</h5>
              {v.repair ? (
                <dl className={styles.facts}>
                  <dt>明确修正票与执行</dt>
                  <dd>
                    {v.repair.ticketId}
                    <br />
                    {v.repair.executionId ?? '尚未派工'}
                  </dd>
                  <dt>交接依据</dt>
                  <dd>{v.repair.basis}</dd>
                  <dt>允许范围</dt>
                  <dd>{v.repair.writeScopes.join('、')}</dd>
                  <dt>新固定版本与意见</dt>
                  <dd>
                    {v.repair.version?.versionId ?? '尚未取得'}
                    <br />
                    {v.repair.version?.resultId}
                  </dd>
                  <dt>继续提交树</dt>
                  <dd>{v.repair.expectedTree ?? '尚未核定真实暂存索引'}</dd>
                </dl>
              ) : (
                <p>尚未安排修正。原冲突输入与现场记录保留。</p>
              )}
              <h5>组合核验</h5>
              <p>明确组合票：{v.combinationTicketId}</p>
              {v.combination ? (
                <p>
                  已关联新组合版本 {v.combination.versionId} 与指定意见 {v.combination.resultId}
                  。核验 HEAD：{v.combination.head}。
                </p>
              ) : (
                <p>尚未核定组合通过。源票旧意见和 Git 成功均不能替代此结果。</p>
              )}
              {v.combinationAttempts.length > 0 && (
                <details>
                  <summary>组合尝试与恢复条件（{v.combinationAttempts.length}）</summary>
                  <ul>
                    {v.combinationAttempts.map((a, i) => (
                      <li key={i}>
                        {a.state === 'passed'
                          ? '对应版本通过'
                          : a.state === 'returned'
                            ? '指定审阅退回'
                            : '仍需修正或核对'}{' '}
                        · {a.versionId}
                        <br />
                        意见 {a.resultId}
                        <br />
                        {a.reason}
                        <br />
                        {a.issues.join('；')}
                        <br />
                        依据：{a.basis}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <details>
                <summary>通知及操作历史</summary>
                <ul>
                  {v.notices.map((n) => (
                    <li key={n.id}>
                      {n.kind === 'arrangement' ? '安排' : '结果'} · 修订 {n.revision} ·{' '}
                      {n.state === 'confirmed'
                        ? '已确认持久接纳'
                        : n.state === 'pending'
                          ? '待投递'
                          : '接纳待核定'}
                      {n.error && ` · ${n.error}`}
                    </li>
                  ))}
                </ul>
                <p>通知接纳不表示已读或已执行。</p>
                <pre>{JSON.stringify(q.data?.history, null, 2)}</pre>
              </details>
              <p>默认保留工作树和原记录。办结合入事项不代替业务票最终验收。</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
