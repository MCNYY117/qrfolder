/**
 * IPv4 / IPv6 CIDR 解析与匹配。
 *
 * ★ 最容易踩的坑：Node 在双栈 socket 上会把 127.0.0.1 报成 ::ffff:127.0.0.1。
 *   不做归一化的话，`127.0.0.1/32` 这条白名单永远匹配不上 ——
 *   运维会以为是配置文件写错了，而不是代码 bug。
 *
 * 另一个坑：绝不能用字符串前缀匹配（`ip.startsWith('10.0.0.')`），
 * 那在 /0、非 8 倍数掩码、IPv6 压缩形式下全错。
 */

import net from 'node:net';

export type Cidr = {
  version: 4 | 6;
  /** 网络地址（主机位已置零） */
  base: bigint;
  /** 前缀长度 */
  bits: number;
  /** 原始输入，供后台回显 */
  source: string;
};

/**
 * 归一化 IP：
 *   - 去掉方括号与 zone id（fe80::1%eth0）
 *   - 把 IPv4-mapped IPv6（::ffff:a.b.c.d）还原为 IPv4
 */
export function normalizeIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);

  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);

  if (ip.toLowerCase().startsWith('::ffff:')) {
    const rest = ip.slice('::ffff:'.length);
    if (net.isIP(rest) === 4) return rest;
  }
  return ip;
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const zone = ip.indexOf('%');
  const addr = zone >= 0 ? ip.slice(0, zone) : ip;

  const doubleColon = addr.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColon >= 0) {
    const h = addr.slice(0, doubleColon);
    const t = addr.slice(doubleColon + 2);
    head = h === '' ? [] : h.split(':');
    tail = t === '' ? [] : t.split(':');
  } else {
    head = addr.split(':');
    tail = [];
  }

  // 末尾可能内嵌 IPv4，如 ::ffff:192.168.1.1（归一化后通常已不会走到这里）
  const expand = (groups: string[]): string[] => {
    const out: string[] = [];
    for (const g of groups) {
      if (g.includes('.')) {
        const v4 = ipv4ToBigInt(g);
        if (v4 === null) return [];
        out.push(((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16));
      } else {
        out.push(g);
      }
    }
    return out;
  };

  head = expand(head);
  tail = expand(tail);

  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;

  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail];
  let value = 0n;
  for (const g of groups) {
    const n = Number.parseInt(g === '' ? '0' : g, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    value = (value << 16n) | BigInt(n);
  }
  return value;
}

export function ipToBigInt(ip: string): { version: 4 | 6; value: bigint } | null {
  const normalized = normalizeIp(ip);
  const version = net.isIP(normalized);
  if (version === 4) {
    const value = ipv4ToBigInt(normalized);
    return value === null ? null : { version: 4, value };
  }
  if (version === 6) {
    const value = ipv6ToBigInt(normalized);
    return value === null ? null : { version: 6, value };
  }
  return null;
}

/**
 * 解析单条 CIDR。无 `/` 时按单机处理（/32 或 /128）。
 * 输入非法返回 null，绝不抛异常 —— 配置里的错误值不应让服务起不来。
 */
export function parseCidr(input: string): Cidr | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const slash = trimmed.lastIndexOf('/');
  const ipPart = slash >= 0 ? trimmed.slice(0, slash) : trimmed;

  const parsed = ipToBigInt(ipPart);
  if (parsed === null) return null;

  const maxBits = parsed.version === 4 ? 32 : 128;
  let bits = maxBits;
  if (slash >= 0) {
    const raw = trimmed.slice(slash + 1).trim();
    if (!/^\d+$/.test(raw)) return null;
    bits = Number(raw);
  }
  if (bits < 0 || bits > maxBits) return null;

  const hostBits = BigInt(maxBits - bits);
  const base = (parsed.value >> hostBits) << hostBits;

  return { version: parsed.version, base, bits, source: trimmed };
}

export function matchesCidr(cidr: Cidr, ip: string): boolean {
  const parsed = ipToBigInt(ip);
  if (parsed === null || parsed.version !== cidr.version) return false;

  const maxBits = cidr.version === 4 ? 32 : 128;
  const hostBits = BigInt(maxBits - cidr.bits);
  const masked = (parsed.value >> hostBits) << hostBits;
  return masked === cidr.base;
}

export function ipInAny(cidrs: readonly Cidr[], ip: string): boolean {
  return cidrs.some((cidr) => matchesCidr(cidr, ip));
}

/** 批量解析，静默丢弃非法项（调用方可通过返回值数量差异提示用户） */
export function parseCidrList(inputs: readonly string[]): Cidr[] {
  const out: Cidr[] = [];
  for (const input of inputs) {
    const cidr = parseCidr(input);
    if (cidr !== null) out.push(cidr);
  }
  return out;
}

/** 校验一组 CIDR 字符串，返回其中非法的项 */
export function findInvalidCidrs(inputs: readonly string[]): string[] {
  return inputs.filter((input) => input.trim() !== '' && parseCidr(input) === null);
}
