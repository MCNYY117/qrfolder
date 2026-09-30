/**
 * 二维码编码器测试。
 *
 * 最关键的一条是「黄金矩阵」：整张码面逐模块写死。
 * 二维码没有中间产物可断言 —— 编码、纠错、交织、填充、掩码、格式信息
 * 任何一步错了，最终都只表现为「扫不出来」。把一整版矩阵钉死在这里，
 * 任何一步回归都会立刻炸在这条断言上。
 *
 * 这两组黄金值是怎么来的：拿 npm 上的 `qrcode` 包生成同样的内容，
 * 逐模块比对到完全一致，再用纯 JS 解码器 `jsqr` 把本实现的 PNG 解回来
 * 验证文本一致。两个包都只在这个验证流程里用过，**不是**本项目的依赖
 * —— 所以这个文件不 import 任何第三方包，`node --test` 在没有 node_modules
 * 的机器上也能跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';

import { encodeQr, isDark, renderQrPng, renderQrSvg } from '../src/util/qrcode.ts';

/** 版本 1，21×21，内容 https://a.b */
const GOLDEN_V1 = [
  '111111100101101111111',
  '100000100101001000001',
  '101110101000101011101',
  '101110101001101011101',
  '101110101010101011101',
  '100000101001001000001',
  '111111101010101111111',
  '000000001010000000000',
  '101111100001001111100',
  '000101000111111111111',
  '100100101100111100110',
  '001100000011110011100',
  '000011100000101011001',
  '000000001000100111101',
  '111111100111010100110',
  '100000101000000111111',
  '101110101111001111001',
  '101110101100111010100',
  '101110101100101100100',
  '100000100000010011100',
  '111111101110101101010',
];

/**
 * 版本 3，29×29，内容 https://files.example.com/Manuals/
 *
 * 这一组是用**独立解码器** jsqr 反解验证过的：把矩阵铺白边放大成位图喂进去，
 * 解出来的文本必须与上面这行完全一致；同时用本实现渲染的 PNG 也解了一遍，
 * 顺带把 PNG 编码那一环也覆盖住。换掉这里的字符串就必须重新生成并重跑这个验证
 * —— 直接拿本实现生成新值等于自己证明自己，回归保护会退化成空转。
 */
const GOLDEN_V3 = [
  '11111110111101110011101111111',
  '10000010101001001000101000001',
  '10111010011110001010101011101',
  '10111010101100110101001011101',
  '10111010011000101001101011101',
  '10000010001011011111101000001',
  '11111110101010101010101111111',
  '00000000100100011110000000000',
  '10110111010001011111001001011',
  '01010100011001110111101110001',
  '10010111101001001110100000110',
  '01001100100100010011110100001',
  '11101111011000100111010001100',
  '00100001111110110001001000111',
  '11000010000101000111010000111',
  '11111101100000100000011100010',
  '00010010011110101110010111010',
  '01011000010100110100100101110',
  '10000110110111110000100110100',
  '00100101101111101110010110100',
  '01111011010001111110111111100',
  '00000000110000001010100011111',
  '11111110100110101101101011010',
  '10000010110001101010100011000',
  '10111010000110010100111110110',
  '10111010101000011001110111001',
  '10111010100100100111010100101',
  '10000010000101111010111001010',
  '11111110111101001011100000010',
];

function snapshot(text: string): string[] {
  const qr = encodeQr(text);
  const rows: string[] = [];
  for (let y = 0; y < qr.size; y += 1) {
    let row = '';
    for (let x = 0; x < qr.size; x += 1) row += isDark(qr, x, y) ? '1' : '0';
    rows.push(row);
  }
  return rows;
}

test('二维码：黄金矩阵（版本 1）', () => {
  assert.deepEqual(snapshot('https://a.b'), GOLDEN_V1);
});

test('二维码：黄金矩阵（版本 3）', () => {
  assert.deepEqual(snapshot('https://files.example.com/Manuals/'), GOLDEN_V3);
});

test('二维码：版本按容量自动选择，边界与标准表一致', () => {
  // 纠错等级 M 的字节模式容量：v1=14 v2=26 v3=42 …… v9=180 v10=213
  const boundaries: [number, number][] = [
    [14, 1],
    [26, 2],
    [27, 3],
    [42, 3],
    [43, 4],
    [62, 4],
    [63, 5],
    [84, 5],
    [85, 6],
    [107, 7],
    [123, 8],
    [153, 9],
    [181, 10],
    [213, 10],
  ];
  for (const [bytes, version] of boundaries) {
    assert.equal(encodeQr('x'.repeat(bytes)).version, version, `${bytes} 字节应当是版本 ${version}`);
  }
});

test('二维码：超出容量时报错而不是静默截断', () => {
  // 静默截断会生成一个「看着正常、扫出来内容不对」的码，比直接报错危险得多
  assert.throws(() => encodeQr('x'.repeat(214)), /too long/);
});

test('二维码：三个定位图形、定时图形与固定深色模块', () => {
  const qr = encodeQr('https://files.example.com/Manuals/');
  const size = qr.size;

  // 定位图形中心 3×3 恒为深色，外圈浅色，再外圈深色
  const corners: [number, number][] = [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ];
  for (const [cx, cy] of corners) {
    assert.ok(isDark(qr, cx, cy), `定位图形中心 (${cx},${cy})`);
    assert.ok(isDark(qr, cx - 1, cy - 1));
    assert.ok(!isDark(qr, cx - 2, cy - 2), '定位图形的浅色环');
    assert.ok(isDark(qr, cx - 3, cy - 3), '定位图形的深色外环');
  }

  // 定时图形：第 6 行 / 第 6 列深浅交替
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(isDark(qr, i, 6), i % 2 === 0, `定时图形 (${i},6)`);
    assert.equal(isDark(qr, 6, i), i % 2 === 0, `定时图形 (6,${i})`);
  }

  // 标准要求固定深色的那个模块
  assert.ok(isDark(qr, 8, size - 8));
});

test('二维码：越界读取一律返回浅色', () => {
  const qr = encodeQr('https://a.b');
  assert.equal(isDark(qr, -1, 0), false);
  assert.equal(isDark(qr, 0, -1), false);
  assert.equal(isDark(qr, qr.size, 0), false);
  assert.equal(isDark(qr, 0, qr.size), false);
});

test('二维码：SVG 可缩放且带静默区', () => {
  const qr = encodeQr('https://a.b');
  const svg = renderQrSvg(qr, { title: 'https://a.b' });

  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('viewBox="0 0 29 29"'), '尺寸 = 21 模块 + 两侧各 4 模块静默区');
  assert.ok(svg.includes('<path d="M'), '深色模块合并成一条路径');
  assert.ok(svg.includes('<title>https://a.b</title>'));
  // 内容里的尖括号不能原样进 SVG
  assert.ok(!renderQrSvg(qr, { title: '<script>' }).includes('<script>'));
});

test('二维码：PNG 结构、CRC 与像素', () => {
  const qr = encodeQr('https://a.b');
  const png = renderQrPng(qr, { scale: 3 });

  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  // 逐块解析，并用 node:zlib 的 crc32 独立复核校验和
  const chunks: { type: string; body: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const body = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      png.readUInt32BE(offset + 8 + length),
      crc32(png.subarray(offset + 4, offset + 8 + length)),
      `${type} 块的 CRC`,
    );
    chunks.push({ type, body });
    offset += 12 + length;
  }
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['IHDR', 'IDAT', 'IEND'],
  );

  const ihdr = chunks[0]?.body;
  assert.ok(ihdr !== undefined);
  // 21 模块 + 两侧各 4 模块静默区 = 29，再放大 3 倍
  assert.equal(ihdr.readUInt32BE(0), 87);
  assert.equal(ihdr.readUInt32BE(4), 87);
  assert.equal(ihdr[8], 8, '位深');
  assert.equal(ihdr[9], 0, '色彩类型 0 = 灰度');

  // 解压回像素，逐点与矩阵比对（每行开头一个过滤器字节）
  const idat = chunks.find((chunk) => chunk.type === 'IDAT')?.body;
  assert.ok(idat !== undefined);
  const raw = inflateSync(idat);
  const stride = 87 + 1;
  assert.equal(raw.length, stride * 87);

  const scale = 3;
  const margin = 4;
  for (let y = 0; y < 87; y += 1) {
    assert.equal(raw[y * stride], 0, `第 ${y} 行的过滤器类型`);
    for (let x = 0; x < 87; x += 1) {
      const dark = isDark(qr, Math.floor(x / scale) - margin, Math.floor(y / scale) - margin);
      assert.equal(raw[y * stride + 1 + x], dark ? 0x00 : 0xff, `像素 (${x},${y})`);
    }
  }
});
