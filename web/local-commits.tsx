import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { localCommitSchema } from '../src/contracts/local-commits';
import { request } from './request';
import styles from './workbench.module.css';
const labels = {
  arranged: '已安排，待核对',
  ready: '现场核对已就绪',
  blocked: '待协调',
  unknown: '结果待核定',
  completed: '本地事项已办结',
  cancelled: '原安排已撤销，未表示提交完成',
};
export function LocalCommitDetail({ base, id }: { base: string; id: string }) {
  const [open, setOpen] = useState(false),
    q = useQuery({
      queryKey: ['local-commit', base, id],
      enabled: open,
      refetchInterval: 3000,
      queryFn: async () =>
        z
          .object({ arrangement: localCommitSchema, history: z.array(z.unknown()) })
          .parse(await request(base + `/local-commits/${id}`)),
    }),
    v = q.data?.arrangement;
  return (
    <section>
      <button className={styles.textButton} type="button" onClick={() => setOpen(!open)}>
        {open ? '收起' : '查看'}本地提交依据与结果
      </button>
      {open && (
        <>
          {q.isPending && <p role="status">正在读取原事项…</p>}
          {q.isError && <p role="alert">读取失败：{q.error.message}</p>}
          {v && (
            <>
              <h5>{labels[v.status]}</h5>
              <p>
                {v.kind === 'baseline' ? '初始基线' : '必要本地提交'} · 修订 {v.revision} · {v.id}
              </p>
              <dl>
                <dt>仓库</dt>
                <dd>{v.plan.repository}</dd>
                <dt>原 HEAD</dt>
                <dd>{v.plan.head ?? '无（初始基线）'}</dd>
                <dt>安排依据</dt>
                <dd>{v.basis}</dd>
                <dt>提交说明</dt>
                <dd>{v.commitMessage}</dd>
                <dt>主管实际会话</dt>
                <dd>{v.managerSessionId}</dd>
                <dt>提交实际会话</dt>
                <dd>{v.committerSessionId}</dd>
                <dt>材料目录</dt>
                <dd>{v.materialPath}</dd>
              </dl>
              <details>
                <summary>明确文件范围（{v.plan.files.length}）</summary>
                <ul>
                  {v.plan.files.map((f) => (
                    <li key={f.path}>
                      {f.path} · {f.blob ?? '删除'} · {f.mode ?? '无'}
                      <br />
                      工作文件 SHA256：{f.workingSha256 ?? '不存在'}
                    </li>
                  ))}
                </ul>
              </details>
              <details>
                <summary>预览时工作区差异目录（{v.plan.worktreeChanges.length}）</summary>
                <ul>
                  {v.plan.worktreeChanges.map((f, i) => (
                    <li key={i}>
                      {f.x}
                      {f.y} · {f.path}
                      {f.originalPath && ` ← ${f.originalPath}`}
                    </li>
                  ))}
                </ul>
                <p>此目录包含范围外的既有修改。仅“明确文件范围”获准本次提交。</p>
              </details>
              <p>现场核对：{v.lastInspection?.note ?? '尚未核对'}</p>
              <p>
                Git 对象：{v.lastProof?.commit ?? '尚未取得'} ·{' '}
                {v.lastProof?.state === 'verified'
                  ? '准确范围已核定'
                  : v.lastProof?.state === 'mismatch'
                    ? '与原安排不符'
                    : '尚未核定'}
              </p>
              <p>{v.lastProof?.reason}</p>
              <p>
                原生在途：{v.lastQuiescence?.state === 'confirmed' ? '已核定安静' : '尚未核定'} ·{' '}
                {v.lastQuiescence?.note}
              </p>
              <p>提交者回报：{v.report?.content ?? '尚未回报'}</p>
              <details>
                <summary>原通知接纳记录</summary>
                <ul>
                  {v.notices.map((n) => (
                    <li key={n.id}>
                      {n.kind === 'arrangement' ? '安排' : '回报'} · 修订 {n.revision} ·{' '}
                      {n.state === 'confirmed'
                        ? '已确认持久接纳'
                        : n.state === 'pending'
                          ? '尚待投递'
                          : '接纳待核定'}
                      {n.error && ` · ${n.error}`}
                    </li>
                  ))}
                </ul>
                <p>接纳表示原生输入已保存，不能据此认定已读或已执行。</p>
              </details>
              <details>
                <summary>原事项操作历史</summary>
                <pre>{JSON.stringify(q.data?.history, null, 2)}</pre>
              </details>
              <p>本地事项不等待推送；办结不改变关联业务票、人工验收或固定交付审阅。</p>
            </>
          )}
        </>
      )}
    </section>
  );
}
