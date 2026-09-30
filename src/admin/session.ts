/**
 * 无状态会话：`v2.<base64url(payload)>.<base64url(hmac)>`
 *
 * 不存服务端。好处：重启不掉线、不占内存、无并发清理问题。
 * 撤销手段是轮换 sessionSecret（后台提供该按钮，并明确标注会让所有人登出）；
 * 单个账号的撤销靠「票据里只存账号 id，权限每次现查」——见 SessionPayload.a 的注释。
 *
 * ★ 版本号从 v1 升到 v2，是加了账号身份这件事**必须**做的，不是为了好看：
 *   旧版本的 verifySession 会忽略它不认识的字段，于是一张带 `a` 的 v1 票据
 *   会被旧代码当成普通管理员接受。一旦回滚到旧版本，所有子管理员会被静默
 *   提升成超级管理员。版本号一对不上，旧版本对新票据一律返回 null。
 *   代价是升级时所有人重新登录一次，值得。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type SessionKind = 'admin' | 'site' | 'dir';

export type SessionPayload = {
  /** 会话种类 */
  k: SessionKind;
  /**
   * 管理员账号 id（k === 'admin' 时必填）。
   *
   * 刻意**不把角色和权限写进票据**：票据是无状态的、默认 12 小时有效，
   * 写进去就等于「改了权限要等票据过期才生效」。只带 id，权限每次从内存配置里
   * 现查，撤销才能立刻生效，删掉的账号下一跳就失效。
   */
  a?: string;
  /** 目录 id（k === 'dir' 时存在） */
  d?: string;
  /** 过期时间（Unix 秒） */
  exp: number;
  /** 绑定的来源 IP（可选） */
  ip?: string;
};

export const SESSION_COOKIE = 'qrfolder_session';
export const CSRF_FIELD = '_csrf';

const TOKEN_VERSION = 'v2';

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${TOKEN_VERSION}.${body}.${sign(body, secret)}`;
}

/**
 * 校验会话令牌。
 * 返回 null 表示无效 —— 调用方一律当作「未登录」处理，不区分失败原因。
 */
export function verifySession(
  token: string | undefined,
  secret: string,
  clientIp: string,
  bindToIp: boolean,
): SessionPayload | null {
  if (typeof token !== 'string' || secret === '') return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;

  const bodyB64 = parts[1] ?? '';
  const givenSig = parts[2] ?? '';
  if (bodyB64 === '' || givenSig === '') return null;

  const expected = Buffer.from(sign(bodyB64, secret), 'utf8');
  const given = Buffer.from(givenSig, 'utf8');
  // ★ timingSafeEqual 在长度不等时抛 RangeError，必须先比长度。
  //   否则攻击者发任意长度的伪造签名就能让服务器抛异常、刷爆日志。
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Partial<SessionPayload>;
  if (typeof record.exp !== 'number' || record.exp * 1000 <= Date.now()) return null;
  if (record.k !== 'admin' && record.k !== 'site' && record.k !== 'dir') return null;

  // 管理员票据必须带账号 id。少了它就不知道是谁 —— 放过去等于发了一张
  // 没有主体的通行证，调用方只能当超级管理员处理，那正是最坏的结果。
  if (record.k === 'admin' && typeof record.a !== 'string') return null;

  if (bindToIp && typeof record.ip === 'string' && record.ip !== clientIp) return null;

  return {
    k: record.k,
    exp: record.exp,
    // ★ 白名单式重建：这里没列出的字段会被**静默丢掉**。
    //   新增票据字段时必须同步加进来，否则签名验过了、字段却不见了。
    ...(typeof record.a === 'string' ? { a: record.a } : {}),
    ...(typeof record.d === 'string' ? { d: record.d } : {}),
    ...(typeof record.ip === 'string' ? { ip: record.ip } : {}),
  };
}
