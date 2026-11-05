import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from './请求';
export function useProjectUpdates(projectId: string) {
  const client = useQueryClient(),
    [state, setState] = useState('正在连接更新…');
  useEffect(() => {
    let source: EventSource | undefined,
      cancelled = false;
    const invalidate = () =>
      client.invalidateQueries({ predicate: (query) => query.queryKey.includes(projectId) });
    void request(`/api/projects/${projectId}/events/cursor`)
      .then((value) => {
        const { cursor } = z.object({ cursor: z.number() }).parse(value);
        if (cancelled) return;
        source = new EventSource(`/api/projects/${projectId}/events?after=${cursor}`);
        source.onopen = () => {
          if (!cancelled) setState('更新连接已建立');
        };
        source.onerror = () => {
          if (!cancelled) setState('更新连接中断，正在按游标重连…');
        };
        source.addEventListener('change', () => {
          void invalidate();
        });
        source.addEventListener('unavailable', () => {
          if (!cancelled) setState('更新暂不可用，可手动刷新');
        });
        void invalidate();
      })
      .catch(() => {
        if (!cancelled) setState('更新连接不可用，可手动刷新');
      });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [projectId, client]);
  return state;
}
