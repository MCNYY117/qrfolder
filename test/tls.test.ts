/**
 * 域名绑定与证书相关逻辑的单元测试。
 *
 * 这里覆盖的都是**不依赖真实 Caddy** 的部分：Caddyfile 生成、域名与邮箱校验、
 * 证书剩余天数换算。与真实 Caddy 打交道的部分（/adapt、/load、回读复核）
 * 另有集成测试，见 adminFlow.test.ts。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, type Config } from '../src/config/schema.ts';
import { validateConfig, validateDomain, validateEmail } from '../src/config/validate.ts';
import { buildCaddyfile, proxyTarget, STAGING_ACME_CA } from '../src/tls/caddyfile.ts';
import { daysUntil } from '../src/tls/certInfo.ts';

function configWithTls(overrides: Partial<Config['system']['tls']>): Config {
  const config = structuredClone(DEFAULT_CONFIG);
  config.system.host = '127.0.0.1';
  config.system.port = 8082;
  config.system.tls = { ...config.system.tls, ...overrides };
  return config;
}

describe('域名校验', () => {
  test('正常域名通过', () => {
    for (const domain of ['files.example.com', 'example.com', 'a-b.example.com', 'x.y.z.example.co.uk']) {
      assert.equal(validateDomain(domain), null, `${domain} 应当通过`);
    }
  });

  test('大小写与首尾空格会被规整', () => {
    assert.equal(validateDomain('  WWW.Example.COM  '), null);
  });

  test('★ 通配符被拒绝（标准版 Caddy 做不到 DNS 验证）', () => {
    const error = validateDomain('*.example.com');
    assert.notEqual(error, null);
    assert.match(error ?? '', /通配符/);
  });

  test('★ IP 地址被拒绝（证书只签给域名）', () => {
    assert.notEqual(validateDomain('203.0.113.10'), null);
  });

  test('单段主机名被拒绝', () => {
    assert.notEqual(validateDomain('localhost'), null);
  });

  test('非法字符、空层级、连字符开头结尾都被拒绝', () => {
    for (const domain of ['exa mple.com', 'a..b.com', '-a.com', 'a-.com', 'a_b.com', '']) {
      assert.notEqual(validateDomain(domain), null, `${domain} 应当被拒绝`);
    }
  });
});

describe('邮箱校验', () => {
  test('正常邮箱通过', () => {
    assert.equal(validateEmail('admin@example.com'), null);
    assert.equal(validateEmail('a.b+c@sub.example.com'), null);
  });

  test('明显的手滑被拒绝', () => {
    for (const email of ['', 'nope', 'a@b', 'a@@b.com', 'a b@c.com', '@example.com']) {
      assert.notEqual(validateEmail(email), null, `${email} 应当被拒绝`);
    }
  });
});

describe('tls 配置校验', () => {
  function validate(tls: Record<string, unknown>) {
    return validateConfig({ version: 1, system: { tls } });
  }

  test('默认关闭，且默认走测试环境', () => {
    const result = validateConfig({ version: 1 });
    assert.equal(result.config.system.tls.enabled, false);
    assert.equal(result.config.system.tls.staging, true, '默认必须是测试环境，避免撞正式环境配额');
    assert.equal(result.config.system.tls.adminApi, 'http://127.0.0.1:2019');
  });

  test('域名被规整为小写并去重', () => {
    // 同一个域名的不同写法（大小写、重复）应当收敛成一条
    const result = validate({ domains: ['WWW.Example.com', 'www.example.com', 'example.com'] });
    assert.deepEqual(result.config.system.tls.domains, ['www.example.com', 'example.com']);
  });

  test('★ 启用 HTTPS 却不填域名 → 直接报错（不给「保存成功但用不了」的机会）', () => {
    const result = validate({ enabled: true, domains: [] });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.at === 'system.tls.domains'));
  });

  test('关闭时允许不填域名', () => {
    assert.equal(validate({ enabled: false, domains: [] }).ok, true);
  });

  test('★ 管理接口只允许本机地址（它没有任何鉴权）', () => {
    for (const adminApi of ['http://0.0.0.0:2019', 'http://203.0.113.10:2019', 'https://example.com']) {
      const result = validate({ adminApi });
      assert.equal(result.config.system.tls.adminApi, 'http://127.0.0.1:2019', `${adminApi} 应被拒绝`);
      assert.ok(result.issues.some((issue) => issue.at === 'system.tls.adminApi'));
    }
  });

  test('本机地址的几种写法都放行', () => {
    for (const adminApi of ['http://127.0.0.1:2019', 'http://localhost:2019', 'http://[::1]:2019']) {
      const result = validate({ adminApi });
      assert.equal(result.config.system.tls.adminApi, adminApi);
      assert.equal(result.ok, true, `${adminApi} 应当通过：${JSON.stringify(result.issues)}`);
    }
  });

  test('非法邮箱被清空并报 issue', () => {
    const result = validate({ email: 'not-an-email' });
    assert.equal(result.config.system.tls.email, '');
    assert.ok(result.issues.some((issue) => issue.at === 'system.tls.email'));
  });
});

describe('Caddyfile 生成', () => {
  test('★ 只用 LF 换行（CRLF 会让 Caddy 判定「未格式化」并每次报警告）', () => {
    const caddyfile = buildCaddyfile(configWithTls({ domains: ['files.example.com'] }));
    assert.ok(!caddyfile.includes('\r'), '不能出现 CR');
    assert.ok(caddyfile.endsWith('\n'));
  });

  test('★ 缩进只用制表符（Caddy 的规范格式）', () => {
    const caddyfile = buildCaddyfile(configWithTls({ domains: ['files.example.com'] }));
    for (const line of caddyfile.split('\n')) {
      assert.ok(!/^\t* {1,}/.test(line) || !line.startsWith(' '), `缩进使用了空格：${line}`);
    }
    assert.ok(caddyfile.includes('\tadmin '));
  });

  test('单域名：生成站点块、反代与 Server 头处理', () => {
    const caddyfile = buildCaddyfile(
      configWithTls({ domains: ['files.example.com'], email: 'admin@example.com', staging: false }),
    );

    assert.match(caddyfile, /^\{$/m);
    assert.match(caddyfile, /\temail admin@example\.com/);
    assert.match(caddyfile, /^files\.example\.com \{$/m);
    assert.match(caddyfile, /^\treverse_proxy 127\.0\.0\.1:8082$/m);
    // ★ 必须是站点级的 header -Server：header_down 写在站点块里 Caddy 会拒绝加载
    assert.match(caddyfile, /^\theader -Server$/m);
    assert.ok(!caddyfile.includes('header_down'), 'header_down 在站点级是非法的');
    // Caddy 默认就替换 XFF（实测伪造值会被丢弃），显式写会换来一条无谓的适配警告
    assert.ok(!caddyfile.includes('header_up'), '不该出现多余的 header_up');
    assert.ok(!caddyfile.includes(STAGING_ACME_CA), 'staging 关闭时不应出现测试 ACME 目录');
  });

  test('★ 自己接管 80 端口的跳转（Caddy 自动生成的跳转会漏 Server 头）', () => {
    const caddyfile = buildCaddyfile(configWithTls({ domains: ['files.example.com'] }));

    // 关掉自动跳转，改由下面的 :80 块处理
    assert.match(caddyfile, /^\tauto_https disable_redirects$/m);
    // :80 块不写死域名 —— 陌生 Host 打进来也要接住，否则会落到 Caddy 默认处理上并泄露 Server
    assert.match(caddyfile, /^:80 \{$/m);
    assert.match(caddyfile, /^\tredir https:\/\/\{host\}\{uri\} permanent$/m);
  });

  test('★ 每一个会产生响应的块里都要删 Server 头', () => {
    const caddyfile = buildCaddyfile(configWithTls({ domains: ['files.example.com'] }));
    // 三处：站点块、handle_errors（Caddy 自己产生的错误响应）、:80 块。
    // 少任何一处都会在那条路径上泄露 `Server: Caddy` —— 这三种都实测漏过。
    const occurrences = caddyfile.match(/^\s*header -Server$/gm) ?? [];
    assert.equal(occurrences.length, 3, '站点 / handle_errors / :80 都要删 Server 头');
  });

  test('★ 上游挂掉时给访客一张有内容的错误页', () => {
    const caddyfile = buildCaddyfile(configWithTls({ domains: ['files.example.com'] }));

    // handle_errors 必须在站点块**内部**：放到顶层 Caddy 会报
    // 「parsed 'handle_errors' as a site address」
    assert.match(caddyfile, /^\thandle_errors \{$/m);
    assert.match(caddyfile, /^\t\trespond "/m);
    // Caddy 默认的 502 响应体是空的，手机上就是一片白
    assert.match(caddyfile, /服务暂时不可用/);
    // 状态码由占位符填，不能写死
    assert.match(caddyfile, /\{http\.error\.status_code\}/);

    // ★ HTML 里一个双引号都不能有，否则会提前结束 Caddyfile 的字符串
    const respondArg = /respond "([^"]*)"/.exec(caddyfile)?.[1] ?? '';
    assert.ok(respondArg.length > 100, '应能提取到完整的 HTML 字符串');
    assert.ok(!respondArg.includes('"'), 'HTML 里的属性必须用单引号');
  });

  test('多域名写进同一行（签进同一张证书）', () => {
    const caddyfile = buildCaddyfile(configWithTls({ domains: ['files.example.com', 'example.com'] }));
    assert.match(caddyfile, /^files\.example\.com, example\.com \{$/m);
  });

  test('staging 打开时使用测试环境 ACME 目录', () => {
    const caddyfile = buildCaddyfile(configWithTls({ domains: ['a.example.com'], staging: true }));
    assert.ok(caddyfile.includes(`acme_ca ${STAGING_ACME_CA}`));
  });

  test('管理接口地址来自配置', () => {
    const caddyfile = buildCaddyfile(
      configWithTls({ domains: ['a.example.com'], adminApi: 'http://127.0.0.1:2999' }),
    );
    assert.match(caddyfile, /\tadmin 127\.0\.0\.1:2999/);
  });

  test('没有域名时拒绝生成（而不是产出一份空配置）', () => {
    assert.throws(() => buildCaddyfile(configWithTls({ domains: [] })), /域名/);
  });

  test('★ 同一份配置生成的结果字节级一致（Caddy 才会短路掉重复加载）', () => {
    const a = buildCaddyfile(configWithTls({ domains: ['files.example.com'] }));
    const b = buildCaddyfile(configWithTls({ domains: ['files.example.com'] }));
    assert.equal(a, b);
  });

  test('★ 监听 0.0.0.0 时反代目标要换成回环地址（0.0.0.0 连不上）', () => {
    const config = configWithTls({ domains: ['a.example.com'] });
    config.system.host = '0.0.0.0';
    assert.equal(proxyTarget(config), '127.0.0.1:8082');

    config.system.host = '::';
    assert.equal(proxyTarget(config), '127.0.0.1:8082');

    config.system.host = '127.0.0.1';
    assert.equal(proxyTarget(config), '127.0.0.1:8082');
  });
});

describe('证书剩余天数', () => {
  const now = new Date('2026-09-23T00:00:00Z');

  test('常规换算', () => {
    assert.equal(daysUntil('Sep 23 00:00:00 2026 GMT', now), 0);
    assert.equal(daysUntil('Sep 24 00:00:00 2026 GMT', now), 1);
    assert.equal(daysUntil('Dec 22 00:00:00 2026 GMT', now), 90);
  });

  test('不足一天向下取整', () => {
    assert.equal(daysUntil('Sep 23 23:59:59 2026 GMT', now), 0);
  });

  test('已过期为负数', () => {
    assert.equal(daysUntil('Sep 22 00:00:00 2026 GMT', now), -1);
  });

  test('无法解析的时间返回 0 而不是 NaN', () => {
    assert.equal(daysUntil('不是时间', now), 0);
    assert.equal(daysUntil('', now), 0);
  });
});
