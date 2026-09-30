/**
 * 探测对外正在服用的那张证书。
 *
 * 做法的取舍：**连本机 443 并带上 SNI**，而不是去连公网域名。
 * 原因是这台机器在 NAT 后面（网卡是内网地址），阿里云 EIP 不支持发夹回环 ——
 * 实测从服务器自己连自己的公网 IP + 端口是不通的。连本机 443 带 SNI，
 * Caddy 会按 SNI 选出该域名对应的证书，拿到的就是**真正在对外服务的那一张**。
 *
 * ★ 三个必须留意的点：
 *
 *   1. **绝对不要设置 `ALPNProtocols: ['acme-tls/1']`。** 443 同时承载 ACME 的
 *      TLS-ALPN 验证，用这个 ALPN 去连，Caddy 会返回**验证用的临时自签证书**，
 *      于是页面会显示一张「颁发者很奇怪、几小时后就过期」的假证书。
 *
 *   2. **必须 `rejectUnauthorized: false`。** 证书还没签下来、或者用的是
 *      Caddy 内部 CA / Let's Encrypt 测试环境时，校验不通过会直接抛错，
 *      那样就只能看到「失败」而看不到证书本身。
 *
 *   3. **证书只能在连接还开着的时候取。** `getPeerCertificate()` 之后要立刻关闭连接。
 */

import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

export type CertificateInfo = {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** 距到期还有多少天（向下取整）；已过期是负数 */
  daysLeft: number;
  /** 证书覆盖的域名（SAN） */
  altNames: string[];
};

/**
 * 三态结果。
 *
 * 一定要把「连不上」和「连上了但没证书」分开：证书还没签发下来、
 * 与 Caddy 根本没在跑，对使用者是两件完全不同的事 —— 前者等一会儿就好，
 * 后者要去启动服务。混成一个「失败」只会让人无从下手。
 */
export type ProbeResult =
  /** TCP 都连不上：Caddy 多半没在跑 */
  | { state: 'unreachable'; detail: string }
  /**
   * 端口上有服务，但它说的不是 TLS。
   *
   * 这一条单独分出来，是因为它**最容易被误判成「证书没签下来」**：
   * 把 QRFolder 自己的监听端口改成 443（纯 HTTP）之后，
   * 探测得到的报错是 ERR_SSL_WRONG_VERSION_NUMBER —— 对着纯 HTTP 服务说 TLS 就是这个错。
   * 如果混进「证书尚未签发」，人就会去反复申请证书，而真正该做的是把 443 让给 Caddy。
   */
  | { state: 'not-tls'; detail: string }
  /** TCP 通了但 TLS 握手失败：证书尚未签发，或验证没通过 */
  | { state: 'no-certificate'; detail: string }
  | { state: 'ok'; certificate: CertificateInfo };

/** 距到期天数，向下取整。抽成纯函数是为了能拿构造的时间戳做单元测试 */
export function daysUntil(validTo: string, now: Date): number {
  const end = new Date(validTo).getTime();
  if (!Number.isFinite(end)) return 0;
  return Math.floor((end - now.getTime()) / 86_400_000);
}

export function describeCertificate(cert: X509Certificate, now: Date): CertificateInfo {
  return {
    subject: cert.subject.replace(/\n/g, ' '),
    issuer: cert.issuer.replace(/\n/g, ' '),
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    daysLeft: daysUntil(cert.validTo, now),
    altNames: (cert.subjectAltName ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^DNS:/, ''))
      .filter((name) => name !== ''),
  };
}

/** 连不上主机（而不是握手失败）的错误码 */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT']);

/**
 * 「对端根本不在说 TLS」的错误码。
 * ERR_SSL_WRONG_VERSION_NUMBER 是 Node 在收到 HTTP 明文响应时的典型报错。
 */
const NOT_TLS_CODES = new Set([
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  'ERR_SSL_HTTP_REQUEST',
]);

export type ProbeOptions = {
  host: string;
  port: number;
  /** SNI，必须是域名而不是 IP —— 否则 Caddy 无法据此选证书 */
  servername: string;
  timeoutMs?: number;
  /** 便于测试注入时间 */
  now?: Date;
};

export function probeCertificate(options: ProbeOptions): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const now = options.now ?? new Date();

  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket | null = null;

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(result);
    };

    try {
      socket = tls.connect(
        {
          host: options.host,
          port: options.port,
          servername: options.servername,
          // 见文件头第 2 点：证书可能是自签或测试环境的，校验会挡在前面
          rejectUnauthorized: false,
          timeout: timeoutMs,
        },
        () => {
          try {
            const peer = socket?.getPeerCertificate(false);
            if (peer === undefined || Object.keys(peer).length === 0 || peer.raw === undefined) {
              finish({
                state: 'no-certificate',
                detail: 'TLS 握手完成，但对端没有提供证书 —— 该域名的证书很可能还没签发下来',
              });
              return;
            }
            finish({ state: 'ok', certificate: describeCertificate(new X509Certificate(peer.raw), now) });
          } catch (error) {
            finish({ state: 'no-certificate', detail: `解析证书失败：${String(error)}` });
          }
        },
      );
    } catch (error) {
      finish({ state: 'unreachable', detail: String(error) });
      return;
    }

    socket.on('timeout', () => {
      finish({ state: 'unreachable', detail: `连接超时（${timeoutMs} 毫秒）` });
    });

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? '';
      if (UNREACHABLE_CODES.has(code)) {
        finish({ state: 'unreachable', detail: `${code}：本机 443 端口没有服务在监听` });
        return;
      }
      if (NOT_TLS_CODES.has(code)) {
        finish({
          state: 'not-tls',
          detail: `${code}：443 上有服务在监听，但它说的是纯 HTTP 而不是 HTTPS`,
        });
        return;
      }
      // 其余多半是握手阶段被中止 —— 证书还没签下来时就是这个现象
      finish({
        state: 'no-certificate',
        detail: `${code === '' ? 'TLS 握手失败' : code}：证书尚未签发或验证未通过`,
      });
    });
  });
}
