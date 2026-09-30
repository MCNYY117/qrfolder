/**
 * 判断本机某个端口有没有服务在监听。
 *
 * Node 没有「查询端口占用」的 API，所以走「连一下试试」：
 * 连得上说明有人在听，ECONNREFUSED 说明没有。
 *
 * 用在「域名与证书」页上显示 80 / 443 的状态 —— 这两个端口没起来，
 * 证书验证必然失败，而失败会消耗 Let's Encrypt 的配额，值得提前提醒。
 */

import net from 'node:net';

export function isPortListening(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
