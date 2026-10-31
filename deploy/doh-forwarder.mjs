// DoH → UDP53 转发器（M2-OPS-03 Mac 内测专用，deploy/compose.mac-beta.yml 的 dns 服务）。
// 背景：开发 Mac 的代理软件是 TUN fake-IP 模式——容器继承宿主 DNS 后一切 UDP 53 查询
// （含显式 223.5.5.5）都被劫持成 198.18/16 假地址，TCP 53 直接超时；唯一干净通道是 443
// （DoH 实证可用，M0/M2-BE-03 冒烟同款结论）。本服务在容器网络内提供 UDP 53，上游走
// 阿里 DoH JSON API（https://223.5.5.5/resolve，443 不被劫持），让 safeFetch 解析到真实
// 公网地址——SSRF 防护零改动、不写死任何业务 IP。
// 只支持 A 查询；AAAA 一律回空答案（NOERROR、0 条——容器网络本无 IPv6，且压缩写法
// 如 2408:8000::1 去冒号展开会编出错地址，不如明确告知无 AAAA 让上层退回 IPv4）；
// 其它类型回 NOTIMP（上层会退回 IPv4）。
// 用法：node doh-forwarder.mjs [监听端口=53]；健康自检：启动时解析一次 cdnh5.redith.cn。
import dgram from 'node:dgram';

const LISTEN_PORT = Number(process.argv[2] ?? 53);
const DOH_ENDPOINT = process.env.DOH_ENDPOINT ?? 'https://223.5.5.5/resolve';
const SECONDARY_DOH = 'https://1.1.1.1/dns-query'; // 主站失败时兜底（走 443）
const TTL = 30;
const cache = new Map(); // qname|type → { expires, answers }（小缓存，内测流量足够）

const sock = dgram.createSocket('udp4');

function parseQuestion(buf) {
  if (buf.length < 12) return null;
  let p = 12;
  const labels = [];
  while (p < buf.length) {
    const len = buf[p];
    if (len === 0) { p += 1; break; }
    if (len & 0xC0 || p + 1 + len > buf.length) return null;
    labels.push(buf.toString('ascii', p + 1, p + 1 + len));
    p += 1 + len;
  }
  if (labels.length < 2 || p + 4 > buf.length) return null;
  return { name: labels.join('.'), type: buf.readUInt16BE(p), p_end: p + 4 };
}

async function dohQuery(name, type) {
  for (const endpoint of [DOH_ENDPOINT, SECONDARY_DOH]) {
    try {
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type === 28 ? 'AAAA' : 'A'}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/dns-json' } });
      if (!response.ok) continue;
      const data = await response.json();
      const answers = (data.Answer ?? [])
        .filter((item) => item.type === 1)
        .map((item) => ({ type: item.type, data: item.data }));
      if (answers.length) return answers;
    } catch { /* 换下一个 DoH */ }
  }
  return [];
}

function buildReply(query, question, answers) {
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 12);
  header.writeUInt16BE(0x8180, 2); // QR=1 RD=1 RA=1，RCODE=0
  header.writeUInt16BE(answers.length, 6);
  const questionSection = query.subarray(12, question.p_end);
  const parts = [header, questionSection];
  for (const answer of answers) {
    const rdata = Buffer.from(answer.data.split('.').map(Number));
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xC00C, 0);        // name 指针 → question
    rr.writeUInt16BE(answer.type, 2);
    rr.writeUInt16BE(1, 4);             // IN
    rr.writeUInt32BE(TTL, 6);
    rr.writeUInt16BE(rdata.length, 10);
    parts.push(rr, rdata);
  }
  return Buffer.concat(parts);
}

function buildError(query, rcode) {
  // 带上 question 回显（缺 section 会让严格 resolver 报 malformed）
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 12);
  header.writeUInt16BE(0x8180 | rcode, 2);
  const question = parseQuestion(query);
  const section = question ? query.subarray(12, question.p_end) : Buffer.alloc(0);
  return Buffer.concat([header, section]);
}

sock.on('message', async (query, rinfo) => {
  try {
    const question = parseQuestion(query);
    if (!question) return sock.send(buildError(query, 1), rinfo.port, rinfo.address);
    if (question.type !== 1 && question.type !== 28) {
      return sock.send(buildError(query, 4), rinfo.port, rinfo.address); // NOTIMP：非 A/AAAA
    }
    if (question.type === 28) {
      // AAAA 一律空答案（NOERROR、0 条，见文件头注释）；不是 NXDOMAIN——域名存在，只是没有 AAAA
      return sock.send(buildReply(query, question, []), rinfo.port, rinfo.address);
    }
    const key = `${question.name}|${question.type}`;
    const hit = cache.get(key);
    let answers;
    if (hit && hit.expires > Date.now()) answers = hit.answers;
    else {
      answers = await dohQuery(question.name, question.type);
      cache.set(key, { expires: Date.now() + TTL * 1000, answers });
    }
    if (!answers.length) return sock.send(buildError(query, 3), rinfo.port, rinfo.address); // NXDOMAIN
    sock.send(buildReply(query, question, answers), rinfo.port, rinfo.address);
  } catch {
    try { sock.send(buildError(query, 2), rinfo.port, rinfo.address); } catch { /* 对端已关 */ }
  }
});

sock.bind(LISTEN_PORT, () => {
  console.log(`[doh-forwarder] UDP ${LISTEN_PORT} → ${DOH_ENDPOINT}（fake-IP 绕行，仅 Mac 内测）`);
  // 启动自检：解析业务域名应得到公网地址
  dohQuery('cdnh5.redith.cn', 1).then((answers) => {
    const ips = answers.map((a) => a.data).join(', ');
    if (/^198\.1[89]\./.test(ips)) { console.error(`[doh-forwarder] 自检失败（仍是 fake-IP）：${ips}`); process.exit(1); }
    console.log(`[doh-forwarder] 自检通过：cdnh5.redith.cn → ${ips}`);
  }).catch((error) => { console.error(`[doh-forwarder] 自检异常：${error.message}`); process.exit(1); });
});
