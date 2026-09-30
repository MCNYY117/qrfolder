/**
 * 零依赖二维码编码器。
 *
 * 只做一件小事：把一段短文本（这里是目录的访问网址）编成二维码矩阵，
 * 再渲染成 SVG 或 PNG。刻意不引入 `qrcode` 之类的库 —— 这个项目的
 * `dependencies` 必须保持为空，见 CLAUDE.md。
 *
 * 实现范围（够用即可，不追求覆盖整个标准）：
 *   - 字节模式（UTF-8），因为网址里可能带中文目录名
 *   - 纠错等级 M（约 15% 冗余，扫码容错与尺寸的常用折中）
 *   - 版本 1–10，字节模式容量 14–213 字节，网址远远够用
 *   - 不实现数字/字母数字/汉字模式，不实现结构化追加
 *
 * 依据 ISO/IEC 18004。矩阵布局（功能图形、蛇形数据填充、掩码评分）
 * 逐条对应标准小节，注释里只写「为什么」。
 *
 * 关于矩阵的表示：用扁平 Uint8Array 而不是 boolean[][]。
 * tsconfig 开了 noUncheckedIndexedAccess，二维数组的每一次 `m[y][x]`
 * 都会变成 `boolean | undefined`，整个文件会被判空代码淹没；
 * 扁平数组配合 getModule / setModule 两个访问器，读起来也更接近
 * 标准里「第 y 行第 x 列」的叙述。
 */

import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------- GF(256)

/**
 * 伽罗华域 GF(256) 的指数/对数表，本原多项式 0x11d。
 *
 * 查表而非现算：纠错码的开销全在乘法上，现算一次要循环 8 次，
 * 查表是两次数组下标。表延长到 512 项，乘法就能直接写 EXP[a + b]，
 * 省掉一次模 255。
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if ((x & 0x100) !== 0) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = at(GF_EXP, i - 255);
}

/** 定长查表读取。越界返回 0 —— 表里全是 0–255，越界只可能来自调用方的逻辑错误 */
function at(table: Uint8Array, index: number): number {
  return table[index] ?? 0;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return at(GF_EXP, at(GF_LOG, a) + at(GF_LOG, b));
}

/** 生成多项式 ∏(x - α^i)，i = 0..degree-1，系数最高次在前 */
function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = Uint8Array.of(1);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      const coefficient = at(poly, j);
      next[j] = at(next, j) ^ coefficient; // 乘 x：整体降一次
      next[j + 1] = at(next, j + 1) ^ gfMul(coefficient, at(GF_EXP, i)); // 乘 α^i
    }
    poly = next;
  }
  return poly;
}

/** 多项式除法的余数，即纠错码字 */
function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const buffer = new Uint8Array(data.length + ecCount);
  buffer.set(data, 0);

  for (let i = 0; i < data.length; i += 1) {
    const factor = at(buffer, i);
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) {
      buffer[i + j] = at(buffer, i + j) ^ gfMul(at(gen, j), factor);
    }
  }
  return buffer.slice(data.length);
}

// ---------------------------------------------------------------- 版本表

type VersionSpec = {
  /** 每个纠错块的纠错码字数 */
  ecPerBlock: number;
  /** [块数, 每块数据码字数]；版本 8 起会把数据切成不等长的两组 */
  groups: readonly (readonly [number, number])[];
};

/** 纠错等级 M、版本 1–10 的参数（ISO/IEC 18004 表 9） */
const VERSIONS_M: readonly VersionSpec[] = [
  { ecPerBlock: 10, groups: [[1, 16]] }, // v1
  { ecPerBlock: 16, groups: [[1, 28]] }, // v2
  { ecPerBlock: 26, groups: [[1, 44]] }, // v3
  { ecPerBlock: 18, groups: [[2, 32]] }, // v4
  { ecPerBlock: 24, groups: [[2, 43]] }, // v5
  { ecPerBlock: 16, groups: [[4, 27]] }, // v6
  { ecPerBlock: 18, groups: [[4, 31]] }, // v7
  { ecPerBlock: 22, groups: [[2, 38], [2, 39]] }, // v8
  { ecPerBlock: 22, groups: [[3, 36], [2, 37]] }, // v9
  { ecPerBlock: 26, groups: [[4, 43], [1, 44]] }, // v10
];

const MAX_VERSION = VERSIONS_M.length;

function versionSpec(version: number): VersionSpec {
  const spec = VERSIONS_M[version - 1];
  if (spec === undefined) throw new Error(`qrcode: unsupported version ${version}`);
  return spec;
}

/** 版本 v 的数据码字总数（不含纠错码字） */
function dataCodewords(version: number): number {
  let total = 0;
  for (const [count, length] of versionSpec(version).groups) total += count * length;
  return total;
}

/**
 * 对齐图形中心点（ISO/IEC 18004 附录 E）。
 * 版本 1 没有对齐图形，这是标准规定的，不是漏写。
 */
const ALIGNMENT_CENTERS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** 纠错等级 M 在格式信息里的两位编码 */
const EC_BITS_M = 0b00;

// ---------------------------------------------------------------- 编码

/** 版本 1–9 的字节模式字符计数是 8 位，版本 10 起是 16 位 */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function requiredBits(byteLength: number, version: number): number {
  return 4 + countBits(version) + byteLength * 8;
}

function pickVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (requiredBits(byteLength, version) <= dataCodewords(version) * 8) return version;
  }
  throw new Error(`qrcode: text too long (${byteLength} bytes) for versions 1-${MAX_VERSION}`);
}

function buildDataCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataCodewords(version);
  const maxBits = capacity * 8;
  const bits = new Uint8Array(maxBits);
  let length = 0;

  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i -= 1) {
      bits[length] = (value >>> i) & 1;
      length += 1;
    }
  };

  push(0b0100, 4); // 字节模式
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);

  // 终止符最多 4 位，且不能撑破容量
  for (let i = 0; i < 4 && length < maxBits; i += 1) {
    bits[length] = 0;
    length += 1;
  }
  while (length % 8 !== 0) {
    bits[length] = 0;
    length += 1;
  }

  const codewords = new Uint8Array(capacity);
  for (let i = 0; i < length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | at(bits, i + j);
    codewords[i >> 3] = byte;
  }

  // 剩余容量用 0xEC / 0x11 交替填满（标准规定的填充码字）
  let padIndex = 0;
  for (let i = length >> 3; i < capacity; i += 1) {
    codewords[i] = padIndex % 2 === 0 ? 0xec : 0x11;
    padIndex += 1;
  }

  return codewords;
}

/** 分块 → 逐块算纠错 → 交错排列（标准 8.6 节） */
function buildCodewords(data: Uint8Array, version: number): Uint8Array {
  const spec = versionSpec(version);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  let offset = 0;
  for (const [count, length] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      const chunk = data.subarray(offset, offset + length);
      offset += length;
      dataBlocks.push(chunk);
      ecBlocks.push(rsRemainder(chunk, spec.ecPerBlock));
    }
  }

  const out = new Uint8Array(data.length + dataBlocks.length * spec.ecPerBlock);
  let cursor = 0;

  let longest = 0;
  for (const block of dataBlocks) longest = Math.max(longest, block.length);
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        out[cursor] = at(block, i);
        cursor += 1;
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      out[cursor] = at(block, i);
      cursor += 1;
    }
  }

  return out;
}

// ---------------------------------------------------------------- 矩阵

type Matrix = {
  size: number;
  /** 行优先，1 = 深色 */
  cells: Uint8Array;
  /** 功能图形占用的位置，数据填充与掩码都必须绕开 */
  reserved: Uint8Array;
};

function createMatrix(size: number): Matrix {
  return { size, cells: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function getModule(matrix: Matrix, x: number, y: number): boolean {
  return matrix.cells[y * matrix.size + x] === 1;
}

/** 画功能图形：写值的同时把它标记为「已占用」，数据填充与掩码都必须绕开 */
function setModule(matrix: Matrix, x: number, y: number, dark: boolean): void {
  const index = y * matrix.size + x;
  matrix.cells[index] = dark ? 1 : 0;
  matrix.reserved[index] = 1;
}

/**
 * 只写值，不动占用标记。
 *
 * 数据填充与掩码必须用这个而不是 setModule —— 用后者会把数据模块也标成
 * 「已占用」，于是掩码阶段认为无处可掩，整张码面就成了未掩码的原始数据，
 * 扫描器一律读不出来（而且码面看上去完全正常，极难排查）。
 */
function putModule(matrix: Matrix, x: number, y: number, dark: boolean): void {
  matrix.cells[y * matrix.size + x] = dark ? 1 : 0;
}

function isReserved(matrix: Matrix, x: number, y: number): boolean {
  return matrix.reserved[y * matrix.size + x] === 1;
}

/** 定位图形：以中心点为准画 9×9，最外圈（dist=4）就是分隔符 */
function drawFinder(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setModule(matrix, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(matrix: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setModule(matrix, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** 格式信息：5 位数据 + 10 位 BCH(15,5)，最后与 0x5412 异或（标准 8.9 节） */
function formatBits(mask: number): number {
  const data = (EC_BITS_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** 版本信息（版本 7 起才有）：6 位版本号 + 12 位 BCH(18,6) */
function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

function bitOf(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function drawFormatBits(matrix: Matrix, mask: number): void {
  const size = matrix.size;
  const bits = formatBits(mask);

  // 第一份：绕着左上角定位图形
  for (let i = 0; i <= 5; i += 1) setModule(matrix, 8, i, bitOf(bits, i));
  setModule(matrix, 8, 7, bitOf(bits, 6));
  setModule(matrix, 8, 8, bitOf(bits, 7));
  setModule(matrix, 7, 8, bitOf(bits, 8));
  for (let i = 9; i < 15; i += 1) setModule(matrix, 14 - i, 8, bitOf(bits, i));

  // 第二份：右上角竖排 8 位 + 左下角横排 7 位
  for (let i = 0; i < 8; i += 1) setModule(matrix, size - 1 - i, 8, bitOf(bits, i));
  for (let i = 8; i < 15; i += 1) setModule(matrix, 8, size - 15 + i, bitOf(bits, i));

  // 固定的深色模块，标准要求恒为深色
  setModule(matrix, 8, size - 8, true);
}

function drawVersionBits(matrix: Matrix, version: number): void {
  if (version < 7) return;
  const size = matrix.size;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setModule(matrix, a, b, bitOf(bits, i));
    setModule(matrix, b, a, bitOf(bits, i));
  }
}

function drawFunctionPatterns(matrix: Matrix, version: number): void {
  const size = matrix.size;

  // 定时图形先画，随后定位图形会覆盖掉它两端多余的格子
  for (let i = 0; i < size; i += 1) {
    setModule(matrix, 6, i, i % 2 === 0);
    setModule(matrix, i, 6, i % 2 === 0);
  }

  drawFinder(matrix, 3, 3);
  drawFinder(matrix, size - 4, 3);
  drawFinder(matrix, 3, size - 4);

  const centers = ALIGNMENT_CENTERS[version - 1] ?? [];
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      // 三个角已被定位图形占据
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = centers[j];
      const cy = centers[i];
      if (cx === undefined || cy === undefined) continue;
      drawAlignment(matrix, cx, cy);
    }
  }

  // 先用占位值把格式/版本信息区标记为「已占用」，数据填充时才不会写进去。
  // 真正的内容等选完掩码再重画。
  drawFormatBits(matrix, 0);
  drawVersionBits(matrix, version);
}

// ---------------------------------------------------------------- 掩码

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 掩码只作用于数据区。功能图形必须原样保留，否则格式信息会被抹掉 */
function applyMask(matrix: Matrix, mask: number): void {
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (!isReserved(matrix, x, y) && maskBit(mask, x, y)) {
        putModule(matrix, x, y, !getModule(matrix, x, y));
      }
    }
  }
}

const FINDER_LIKE_A = '10111010000';
const FINDER_LIKE_B = '00001011101';

/** 把第 index 行（或列）拍成 '0'/'1' 字符串，规则 1/3/4 用字符串处理比下标遍历干净 */
function lineToString(matrix: Matrix, index: number, vertical: boolean): string {
  let out = '';
  for (let i = 0; i < matrix.size; i += 1) {
    out += getModule(matrix, vertical ? index : i, vertical ? i : index) ? '1' : '0';
  }
  return out;
}

/**
 * 掩码评分（标准 8.8.2 的四条规则），分数越低越好。
 * 选掩码不改变能否解码，只影响扫描器能否稳定识别。
 */
function penaltyScore(matrix: Matrix): number {
  const size = matrix.size;
  const lines: string[] = [];
  for (let i = 0; i < size; i += 1) {
    lines.push(lineToString(matrix, i, false));
    lines.push(lineToString(matrix, i, true));
  }

  let score = 0;

  // 规则 1：同色连续 5 个以上，每多一个加 1 分
  for (const line of lines) {
    for (const run of line.matchAll(/0{5,}|1{5,}/g)) {
      const segment = run[0];
      if (segment !== undefined) score += 3 + (segment.length - 5);
    }
  }

  // 规则 3：出现类似定位图形的 1:1:3:1:1 组合，每次 40 分
  for (const line of lines) {
    for (let i = 0; i + 11 <= size; i += 1) {
      if (line.startsWith(FINDER_LIKE_A, i) || line.startsWith(FINDER_LIKE_B, i)) score += 40;
    }
  }

  // 规则 2：2×2 同色方块，每块 3 分
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = getModule(matrix, x, y);
      if (
        color === getModule(matrix, x + 1, y) &&
        color === getModule(matrix, x, y + 1) &&
        color === getModule(matrix, x + 1, y + 1)
      ) {
        score += 3;
      }
    }
  }

  // 规则 4：深色比例每偏离 50% 达 5%，记 10 分
  let dark = 0;
  for (const line of lines) dark += line.split('1').length - 1;
  dark >>= 1; // 行与列各统计了一遍
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;

  return score;
}

// ---------------------------------------------------------------- 对外接口

export type QrCode = {
  /** 边长（模块数），等于 version * 4 + 17 */
  size: number;
  version: number;
  /** 行优先的模块矩阵，1 = 深色。请用 isDark() 读取 */
  cells: Uint8Array;
};

/** 读取某个模块是否为深色。越界一律当作浅色 */
export function isDark(qr: QrCode, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) return false;
  return qr.cells[y * qr.size + x] === 1;
}

export type EncodeOptions = {
  /**
   * 强制使用某个掩码（0–7）。
   *
   * 正常调用不要传 —— 掩码自动选优。留这个口子是为了测试：
   * 只有把掩码钉死成参考实现的取值，两个矩阵才能逐模块对比，
   * 否则光是掩码不同就会让数据区一半的模块对不上。
   */
  mask?: number;
};

export function encodeQr(text: string, options: EncodeOptions = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;

  const codewords = buildCodewords(buildDataCodewords(bytes, version), version);
  const matrix = createMatrix(size);
  drawFunctionPatterns(matrix, version);

  // 数据填充：自右下角起每次两列、蛇形上下往返；第 6 列是定时图形，跳过。
  // 填充完若还有空位（版本 2–6 的 7 个剩余位），保持浅色即可，标准如此。
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        // 方向由列号决定，与标准里 (right + 1) & 2 的判定等价
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isReserved(matrix, x, y) || bitIndex >= totalBits) continue;
        const byte = at(codewords, bitIndex >>> 3);
        putModule(matrix, x, y, ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0);
        bitIndex += 1;
      }
    }
  }

  // 逐个试 8 种掩码，取罚分最低的。掩码是异或，再异或一次即还原，不必复制矩阵。
  let bestMask = 0;
  if (options.mask !== undefined && options.mask >= 0 && options.mask <= 7) {
    bestMask = Math.floor(options.mask);
  } else {
    let bestScore = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask += 1) {
      applyMask(matrix, mask);
      drawFormatBits(matrix, mask);
      const score = penaltyScore(matrix);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
      }
      applyMask(matrix, mask);
    }
  }
  applyMask(matrix, bestMask);
  drawFormatBits(matrix, bestMask);

  return { size, version, cells: matrix.cells };
}

// ---------------------------------------------------------------- 渲染

export type RenderOptions = {
  /** 静默区宽度（模块数）。标准要求至少 4，低于 4 很多扫描器会认不出 */
  margin?: number;
  /** SVG 的 title，也是 PNG 唯一能带的说明文字 */
  title?: string;
};

function quietMargin(options: RenderOptions): number {
  return options.margin === undefined || options.margin < 0 ? 4 : options.margin;
}

type Run = { start: number; length: number };

/** 把一行的连续深色模块合并成横条，节点数少一个数量级 */
function runsOfRow(qr: QrCode, y: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let x = 0; x <= qr.size; x += 1) {
    const dark = x < qr.size && isDark(qr, x, y);
    if (dark && start < 0) start = x;
    if (!dark && start >= 0) {
      runs.push({ start, length: x - start });
      start = -1;
    }
  }
  return runs;
}

export function renderQrSvg(qr: QrCode, options: RenderOptions = {}): string {
  const margin = quietMargin(options);
  const extent = qr.size + margin * 2;
  const parts: string[] = [];

  for (let y = 0; y < qr.size; y += 1) {
    for (const run of runsOfRow(qr, y)) {
      parts.push(`M${run.start + margin} ${y + margin}h${run.length}v1h-${run.length}z`);
    }
  }

  // 尺寸交给 viewBox，外面想放多大就多大，不必重算路径
  const label = options.title === undefined ? '' : `<title>${escapeXml(options.title)}</title>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}"` +
    ` viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges" role="img">${label}` +
    `<rect width="${extent}" height="${extent}" fill="#ffffff"/>` +
    `<path d="${parts.join('')}" fill="#000000"/></svg>`
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = at32(CRC_TABLE, (c ^ byte) & 0xff) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function at32(table: Uint32Array, index: number): number {
  return table[index] ?? 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export type PngOptions = RenderOptions & {
  /** 每个模块放大成多少像素。8 已经足够清晰，文件仍只有几 KB */
  scale?: number;
};

/**
 * 手写 PNG 编码器。
 *
 * 用 8 位灰度（色彩类型 0）而不是 1 位：1 位要处理行内位打包与行末补齐，
 * 代码多一倍，而灰度图经 deflate 之后大小几乎一样 —— 大片同色区域压得极好。
 */
export function renderQrPng(qr: QrCode, options: PngOptions = {}): Buffer {
  const margin = quietMargin(options);
  const scale = options.scale === undefined || options.scale < 1 ? 8 : Math.floor(options.scale);
  const extent = qr.size + margin * 2;
  const pixels = extent * scale;
  const stride = pixels + 1; // 每行开头一个过滤器类型字节

  const raw = Buffer.alloc(stride * pixels, 0xff);
  for (let row = 0; row < pixels; row += 1) raw[row * stride] = 0; // 过滤器：无

  for (let y = 0; y < qr.size; y += 1) {
    for (const run of runsOfRow(qr, y)) {
      const from = (run.start + margin) * scale;
      const to = (run.start + run.length + margin) * scale;
      for (let row = (y + margin) * scale; row < (y + margin + 1) * scale; row += 1) {
        raw.fill(0x00, row * stride + 1 + from, row * stride + 1 + to);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pixels, 0);
  ihdr.writeUInt32BE(pixels, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 0; // 色彩类型：灰度
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 过滤方法
  ihdr[12] = 0; // 非隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
