import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureMaterialRoot, listMaterials, readMaterial } from '../源码/业务/票据材料.ts';
test('稳定票内材料入口完整回读文件，缺件、越界和链接逃逸明确拒绝', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-materials-'));
  try {
    mkdirSync(join(root, '.TEAM'));
    const materials = ensureMaterialRoot(root, 'P001-ENG-001');
    writeFileSync(join(materials, '结果.md'), '完整结果\n第二行');
    expect(listMaterials(materials, '')[0]!.name).toBe('结果.md');
    expect(readMaterial(materials, '结果.md').toString('utf8')).toBe('完整结果\n第二行');
    expect(() => readMaterial(materials, '缺件.md')).toThrow('不可');
    expect(() => readMaterial(materials, '../其他票/结果.md')).toThrow('范围');
    const outside = join(root, '不属本票');
    mkdirSync(outside);
    writeFileSync(join(outside, '私有.txt'), '不应读取');
    symlinkSync(outside, join(materials, '外部链接'), 'junction');
    expect(() => readMaterial(materials, '外部链接/私有.txt')).toThrow('链接');
    expect(() => ensureMaterialRoot(root, '../外部')).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
