/**
 * safePath 的穿越用例集。
 *
 * 用例来源：对运行中的 Caddy 做原始抓包实测得到的真实攻击串，
 * 外加 Windows 特有的绕过路径（尾随点/空格、ADS、保留设备名）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSafe, isInside, UnsafePathError } from '../src/serving/safePath.ts';

const ROOT = path.resolve('/fake/root');
const IS_WINDOWS = process.platform === 'win32';

/** 断言该 pathname 被拒绝 */
function assertRejected(pathname: string, why: string): void {
  assert.throws(
    () => resolveSafe(ROOT, pathname),
    UnsafePathError,
    `应被拒绝但通过了：${pathname}（${why}）`,
  );
}

describe('resolveSafe —— 合法路径', () => {
  test('根路径返回 root 本身', () => {
    assert.equal(resolveSafe(ROOT, '/'), ROOT);
  });

  test('单层目录', () => {
    assert.equal(resolveSafe(ROOT, '/Manuals/'), path.join(ROOT, 'Manuals'));
  });

  test('多层嵌套', () => {
    assert.equal(
      resolveSafe(ROOT, '/a/b/c/'),
      path.join(ROOT, 'a', 'b', 'c'),
    );
  });

  test('中文目录名', () => {
    assert.equal(resolveSafe(ROOT, '/技术文档/'), path.join(ROOT, '技术文档'));
  });

  test('百分号编码的空格', () => {
    assert.equal(
      resolveSafe(ROOT, '/Datasheet%202026/'),
      path.join(ROOT, 'Datasheet 2026'),
    );
  });

  test('中文的百分号编码', () => {
    const encoded = '/' + encodeURIComponent('新公司 NewCo Ltd') + '/';
    assert.equal(resolveSafe(ROOT, encoded), path.join(ROOT, '新公司 NewCo Ltd'));
  });

  test('★ 以两点开头的合法文件名（isInside 写成 startsWith("..") 会误杀）', () => {
    assert.equal(resolveSafe(ROOT, '/..foo'), path.join(ROOT, '..foo'));
    assert.equal(resolveSafe(ROOT, '/a/..bar.txt'), path.join(ROOT, 'a', '..bar.txt'));
  });

  test('单点开头的隐藏文件名在 safePath 层是放行的（由 hideDotfiles 决定是否展示）', () => {
    assert.equal(resolveSafe(ROOT, '/.env'), path.join(ROOT, '.env'));
  });

  test('重复斜杠与末尾斜杠被规范化', () => {
    assert.equal(resolveSafe(ROOT, '//a///b//'), path.join(ROOT, 'a', 'b'));
  });

  test('文件名含点、连字符、括号', () => {
    assert.equal(
      resolveSafe(ROOT, '/v1.2.3-final(1).pdf'),
      path.join(ROOT, 'v1.2.3-final(1).pdf'),
    );
  });
});

describe('resolveSafe —— 路径穿越', () => {
  test('字面 .. 被拒绝', () => {
    assertRejected('/../etc/passwd', 'dot-dot segment');
    assertRejected('/a/../../b', 'dot-dot segment');
    assertRejected('/..', 'dot-dot segment');
  });

  test('单点段被拒绝', () => {
    assertRejected('/./a', 'single dot segment');
  });

  test('★ %2f 夹带的分隔符（能穿过 URL 解析器）', () => {
    assertRejected('/a%2f..%2fb', 'encoded forward slash');
    assertRejected('/..%2fetc%2fpasswd', 'encoded forward slash');
    assertRejected('/%2e%2e%2f%2e%2e%2fwindows', 'encoded dot-dot + slash');
  });

  test('%2e%2e 解码后的 dot-dot 段', () => {
    assertRejected('/%2e%2e/x', 'decoded to ..');
    assertRejected('/a/%2e%2e/%2e%2e/b', 'decoded to ..');
  });

  test('大小写混合的百分号编码', () => {
    assertRejected('/%2E%2E/x', 'uppercase hex');
    assertRejected('/a%2Fb', 'uppercase %2F');
  });

  test('NUL 字节', () => {
    assertRejected('/a%00', 'nul byte');
    assertRejected('/%00.txt', 'nul byte');
  });

  test('非法百分号编码', () => {
    assertRejected('/%c0%ae', 'invalid utf-8 sequence');
    assertRejected('/%zz', 'malformed escape');
  });

  test('超长路径与超长段', () => {
    assertRejected('/' + 'a'.repeat(5000), 'path too long');
    assertRejected('/' + 'a'.repeat(300), 'segment too long');
  });
});

describe('resolveSafe —— Windows 特有绕过', { skip: !IS_WINDOWS }, () => {
  test('反斜杠（原生与编码）', () => {
    assertRejected('/a\\b', 'raw backslash');
    assertRejected('/a%5cb', 'encoded backslash');
    assertRejected('/..%5c..%5cwindows', 'backslash traversal');
  });

  test('★ 尾随空格 —— ".. " 会被文件系统当成 ".."', () => {
    assertRejected('/..%20', 'dot-dot with trailing space');
    assertRejected('/a/..%20', 'dot-dot with trailing space');
  });

  test('★ 尾随点 —— "foo." 与 "foo" 指向同一文件，可绕过黑名单', () => {
    assertRejected('/a.', 'trailing dot');
    assertRejected('/.env.', 'trailing dot on a denied filename');
  });

  test('盘符跳转', () => {
    assertRejected('/C:/windows/win.ini', 'drive letter');
    assertRejected('/c:', 'bare drive letter');
  });

  test('NTFS 交换数据流', () => {
    assertRejected('/file.txt:hidden', 'alternate data stream');
  });

  test('保留设备名', () => {
    assertRejected('/CON', 'reserved device');
    assertRejected('/nul', 'reserved device');
    assertRejected('/COM1', 'reserved device');
    assertRejected('/aux.txt', 'reserved device with extension');
  });
});

describe('isInside', () => {
  test('自身算在内', () => {
    assert.equal(isInside(ROOT, ROOT), true);
  });

  test('子路径算在内', () => {
    assert.equal(isInside(ROOT, path.join(ROOT, 'a', 'b')), true);
  });

  test('★ 前缀相同但并非子目录的兄弟路径不算在内', () => {
    assert.equal(isInside(ROOT, ROOT + 'x'), false);
    assert.equal(isInside(ROOT, ROOT + '-backup'), false);
  });

  test('父目录不算在内', () => {
    assert.equal(isInside(ROOT, path.dirname(ROOT)), false);
    assert.equal(isInside(path.join(ROOT, 'a'), ROOT), false);
  });

  test('以两点开头的兄弟文件名仍算在内', () => {
    assert.equal(isInside(ROOT, path.join(ROOT, '..foo')), true);
  });
});
