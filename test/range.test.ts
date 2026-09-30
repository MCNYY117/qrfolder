import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Stats } from 'node:fs';
import { parseRange, contentDisposition, buildEtag } from '../src/serving/sendFile.ts';

const SIZE = 100;

describe('parseRange', () => {
  test('没有 Range 头 → 全量', () => {
    assert.deepEqual(parseRange(undefined, SIZE), { kind: 'none' });
  });

  test('非 bytes 单位 → 忽略', () => {
    assert.deepEqual(parseRange('items=0-9', SIZE), { kind: 'none' });
  });

  test('常规区间', () => {
    assert.deepEqual(parseRange('bytes=0-9', SIZE), { kind: 'satisfiable', start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=50-59', SIZE), { kind: 'satisfiable', start: 50, end: 59 });
  });

  test('开放右端 bytes=N-', () => {
    assert.deepEqual(parseRange('bytes=90-', SIZE), { kind: 'satisfiable', start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=0-', SIZE), { kind: 'satisfiable', start: 0, end: 99 });
  });

  test('★ 后缀区间 bytes=-N 取最后 N 字节', () => {
    assert.deepEqual(parseRange('bytes=-10', SIZE), { kind: 'satisfiable', start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-1', SIZE), { kind: 'satisfiable', start: 99, end: 99 });
  });

  test('★ 后缀区间超出文件长度 → 收敛为整个文件', () => {
    assert.deepEqual(parseRange('bytes=-999', SIZE), { kind: 'satisfiable', start: 0, end: 99 });
  });

  test('★ 右端越界要收敛，不是 416（RFC 7233 明确要求）', () => {
    assert.deepEqual(parseRange('bytes=0-99999999', SIZE), { kind: 'satisfiable', start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=90-99999999', SIZE), { kind: 'satisfiable', start: 90, end: 99 });
  });

  test('★ 只有左端越界才 416', () => {
    assert.deepEqual(parseRange('bytes=100-', SIZE), { kind: 'unsatisfiable' });
    assert.deepEqual(parseRange('bytes=150-200', SIZE), { kind: 'unsatisfiable' });
  });

  test('最后一个字节可取', () => {
    assert.deepEqual(parseRange('bytes=99-99', SIZE), { kind: 'satisfiable', start: 99, end: 99 });
  });

  test('起点大于终点 → 416', () => {
    assert.deepEqual(parseRange('bytes=5-2', SIZE), { kind: 'unsatisfiable' });
  });

  test('★ 多段请求退化为全量（而非报错）', () => {
    assert.deepEqual(parseRange('bytes=0-9,20-29', SIZE), { kind: 'none' });
  });

  test('语法不合法 → 忽略 Range，发全量', () => {
    assert.deepEqual(parseRange('bytes=abc', SIZE), { kind: 'none' });
    assert.deepEqual(parseRange('bytes=', SIZE), { kind: 'none' });
    assert.deepEqual(parseRange('bytes=-', SIZE), { kind: 'none' });
    assert.deepEqual(parseRange('bytes=1-2-3', SIZE), { kind: 'none' });
  });

  test('bytes=-0 → 416（请求了 0 个字节）', () => {
    assert.deepEqual(parseRange('bytes=-0', SIZE), { kind: 'unsatisfiable' });
  });
});

describe('contentDisposition', () => {
  test('纯 ASCII 文件名', () => {
    const v = contentDisposition('attachment', 'manual.pdf');
    assert.match(v, /^attachment; filename="manual\.pdf"; filename\*=UTF-8''manual\.pdf$/);
  });

  test('★ 中文文件名必须双写 filename 与 filename*', () => {
    const v = contentDisposition('attachment', '产品手册.pdf');
    assert.match(v, /filename="[^"]*\.pdf"/, '应含 ASCII 回退形式');
    assert.match(v, /filename\*=UTF-8''%E4%BA%A7%E5%93%81%E6%89%8B%E5%86%8C\.pdf/, '应含 RFC 5987 形式');
  });

  test('★ RFC 5987 要求转义撇号、括号、星号', () => {
    const v = contentDisposition('inline', "a'b(c)*d.txt");
    assert.ok(v.includes('%27'), '撇号应被转义');
    assert.ok(v.includes('%28') && v.includes('%29'), '括号应被转义');
    assert.ok(v.includes('%2A'), '星号应被转义');
  });

  test('双引号与反斜杠不能破坏头部结构', () => {
    const v = contentDisposition('attachment', 'a"b\\c.txt');
    const asciiPart = /filename="([^"]*)"/.exec(v)?.[1] ?? '';
    assert.ok(!asciiPart.includes('"'));
    assert.ok(!asciiPart.includes('\\'));
  });

  test('inline 模式', () => {
    assert.ok(contentDisposition('inline', 'a.pdf').startsWith('inline;'));
  });
});

describe('buildEtag', () => {
  const stat = { size: 448, mtimeMs: 1758610023000 } as unknown as Stats;

  test('形如 "<sizeHex>-<mtimeHex>"', () => {
    assert.equal(buildEtag(stat), `"${(448).toString(16)}-${Math.floor(1758610023000).toString(16)}"`);
  });

  test('同一文件两次调用结果一致', () => {
    assert.equal(buildEtag(stat), buildEtag(stat));
  });

  test('大小变化会产生不同 ETag', () => {
    const other = { size: 449, mtimeMs: 1758610023000 } as unknown as Stats;
    assert.notEqual(buildEtag(stat), buildEtag(other));
  });
});
