import type { NativeMessage } from './原生接口.ts';
/** Permission is scoped to one admitted native turn, never reconstructed from history. */
export class ExplicitSkillGrants {
  private turn: number | undefined;
  private readonly names = new Set<string>();
  accept(turn: number, messages: NativeMessage[]): void {
    if (!Number.isInteger(turn) || turn < 1)
      throw new Error('宿主没有提供有效的当前轮次，拒绝建立显式Skill许可');
    if (this.turn !== turn) {
      this.names.clear();
      this.turn = turn;
    }
    for (const message of messages) {
      if (message.role !== 'user' || message.source.kind !== 'user') continue;
      for (const block of message.content) {
        if (block.type !== 'text' || block.text === undefined) continue;
        for (const match of block.text.matchAll(
          /(?:^|[^\w$-])\$([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/gu,
        ))
          this.names.add(match[1]!);
      }
    }
  }
  has(name: string): boolean {
    return this.names.has(name);
  }
}
