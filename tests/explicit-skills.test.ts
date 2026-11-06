import { expect, test } from 'vitest';
import { ExplicitSkillGrants } from '../src/host/explicit-skills.ts';
const message = (text: string, kind = 'user') => ({
  id: 'fixture',
  role: 'user',
  source: { kind },
  content: [{ type: 'text', text }],
});
test('显式许可只来自当前已接纳用户输入，准确匹配名称且下一轮失效', () => {
  const grants = new ExplicitSkillGrants();
  grants.accept(1, [message('请使用 $manual')]);
  expect(grants.has('manual')).toBe(true);
  grants.accept(1, []);
  expect(grants.has('manual')).toBe(true);
  grants.accept(2, [message('本轮只读取配置')]);
  expect(grants.has('manual')).toBe(false);
  grants.accept(3, [message('$manual-extra')]);
  expect(grants.has('manual')).toBe(false);
  expect(grants.has('manual-extra')).toBe(true);
  grants.accept(4, [message('$manual_suffix')]);
  expect(grants.has('manual')).toBe(false);
  grants.accept(5, [message('$manual', 'mat-message')]);
  expect(grants.has('manual')).toBe(false);
  grants.accept(6, [message('`$manual`，以及 $other。')]);
  expect(grants.has('manual')).toBe(true);
  expect(grants.has('other')).toBe(true);
});
