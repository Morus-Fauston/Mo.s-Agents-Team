import type { z } from 'zod';
import type { historyTargetSchema } from '../contracts/ticket-deliveries.ts';
import type { ProjectConnection } from './project.ts';
import { ProjectError } from './errors.ts';
type Target = z.infer<typeof historyTargetSchema>;

export function historyTargets(connection: ProjectConnection, entryId: string): Target[] {
  const wb = connection.workbench(),
    history = wb.projectHistory(),
    entry = history.find((row) => row.id === entryId);
  if (!entry) throw new ProjectError('HISTORY_NOT_FOUND', '原项目历史不存在');
  const tickets = wb.listTickets(),
    phases = wb.phases(),
    decisions = connection.decisionRequests().list({ kind: 'user' });
  const fallback = (reference: string): Target => ({
    kind: 'unavailable',
    reference,
    ticketId: null,
    recordId: reference,
    label: '原引用未匹配可读业务记录',
  });
  return [
    ...new Set([entry.objectId, ...entry.references, ...(entry.corrects ? [entry.corrects] : [])]),
  ].map((reference) => {
    const ticket = tickets.find((item) => item.id === reference || item.code === reference);
    if (ticket)
      return {
        kind: 'ticket',
        reference,
        ticketId: ticket.id,
        recordId: ticket.id,
        label: `${ticket.code} · ${ticket.title}`,
      };
    const phase = phases.find((item) => item.id === reference || item.code === reference);
    if (phase)
      return {
        kind: 'phase',
        reference,
        ticketId: null,
        recordId: phase.id,
        label: `${phase.code} · ${phase.name}`,
      };
    const decision = decisions.find((item) => item.id === reference);
    if (decision)
      return {
        kind: 'decision',
        reference,
        ticketId: decision.ticketId,
        recordId: decision.id,
        label: decision.subject,
      };
    if (history.some((item) => item.id === reference))
      return {
        kind: 'history',
        reference,
        ticketId: null,
        recordId: reference,
        label: '原项目历史',
      };
    const pair = /^([^:]+):(L\d+)$/.exec(reference);
    if (pair && tickets.some((item) => item.id === pair[1] || item.code === pair[1])) {
      try {
        const log = wb.getLog(pair[1]!, pair[2]!);
        return {
          kind: 'log',
          reference,
          ticketId: log.ticketId,
          recordId: log.id,
          label: `${log.id} · ${log.title}${log.archived ? ' · 已归档' : ''}`,
        };
      } catch (error) {
        if (!(error instanceof ProjectError) || error.code !== 'WORKBENCH_NOT_FOUND') throw error;
      }
    }
    if (/^[0-9a-f-]{36}$/i.test(reference)) {
      const acceptance = connection.acceptance().historyReference(reference);
      if (acceptance)
        return {
          kind: 'acceptance',
          reference,
          ticketId: acceptance.ticketId,
          recordId: reference,
          label: acceptance.label,
        };
      let versionId = reference;
      const lookups = [
        () => connection.reviews().get(reference).versionId,
        () => connection.reviewResults().get(reference).versionId,
        () => connection.reviews().completion(reference).versionId,
      ];
      for (const read of lookups) {
        try {
          versionId = read();
          break;
        } catch (error) {
          if (
            !(error instanceof ProjectError) ||
            !['REVIEW_NOT_FOUND', 'REVIEW_RESULT_NOT_FOUND', 'COMPLETION_NOT_FOUND'].includes(
              error.code,
            )
          )
            throw error;
        }
      }
      try {
        const version = connection.versions().get(versionId);
        if (
          version.kind === 'delivery' &&
          connection
            .reviews()
            .list(version.executionId)
            .some(
              (review) => review.versionId === version.id && review.ticketId === version.ticket.id,
            )
        )
          return {
            kind: 'delivery',
            reference,
            ticketId: version.ticket.id,
            recordId: version.id,
            label: `${version.ticket.code} · 送审版本 ${version.sequence}`,
          };
      } catch (error) {
        if (!(error instanceof ProjectError) || error.code !== 'VERSION_NOT_FOUND') throw error;
      }
    }
    return fallback(reference);
  });
}
