/**
 * 版本号只有一份事实来源：`package.json`。
 *
 * 存在的理由是一次真实的疏漏：`src/main.ts` 的 `VERSION` 是硬编码的常量，
 * 与 `package.json` 的 `version` 各自维护。把 package.json 改成 1.0.0 之后，
 * 服务启动横幅和 `--help` 打出来的仍然是 0.1.0 —— 命令行的输出不经过 tsc、
 * 也不经过任何测试，只有真的跑一次才看得见。
 *
 * 而版本号恰恰是别人报 bug 时唯一能提供的东西：
 * 「我这里是 v0.1.0」如果本身是错的，排查方向从一开始就偏了。
 *
 * 这里用扫源码的方式而不是 import `main.ts`——后者会真的把服务起起来。
 * 同样的手法在 `adminPolicy.test.ts` 里也用了（扫路由字面量）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('src/main.ts 的 VERSION 与 package.json 的 version 一致', () => {
  const source = readFileSync(path.join(APP_DIR, 'src', 'main.ts'), 'utf8');
  const match = source.match(/^const VERSION = '([^']+)';/m);
  assert.ok(match, "src/main.ts 里应当有一行 `const VERSION = '...';`");

  const pkg = JSON.parse(readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')) as {
    version: string;
  };

  assert.equal(
    match[1],
    pkg.version,
    '发版时这两处必须一起改，否则启动横幅会报出一个和实际发布版本对不上的数字',
  );
});
