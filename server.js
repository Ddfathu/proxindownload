import net from 'net';
import dns from 'dns';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const TCP_DOMAIN = process.env.RAILWAY_TCP_PROXY_DOMAIN || '';
const TCP_PORT = process.env.RAILWAY_TCP_PROXY_PORT || '';

let PROXY_SERVER_INFO = {
  domain: TCP_DOMAIN,
  port: TCP_PORT,
  ip: '',
  fullProxy: ''
};

function updateRailwayProxyIP() {
  if (TCP_DOMAIN) {
    dns.lookup(TCP_DOMAIN, (err, address) => {
      if (!err && address) {
        PROXY_SERVER_INFO.ip = address;
        PROXY_SERVER_INFO.fullProxy = `${address}:${TCP_PORT}`;
      } else {
        PROXY_SERVER_INFO.ip = TCP_DOMAIN;
        PROXY_SERVER_INFO.fullProxy = `${TCP_DOMAIN}:${TCP_PORT}`;
      }
    });
  } else {
    PROXY_SERVER_INFO.fullProxy = 'TCP Proxy Not Set';
  }
}
updateRailwayProxyIP();
setInterval(updateRailwayProxyIP, 1000 * 60 * 30);

let DNS_CONFIG = {
  mode: 'DOH',
  activeName: 'Cloudflare DoH (Official)',
  dohUrl: 'https://cloudflare-dns.com/dns-query',
  udpServer: '1.1.1.1',
  udpPort: 53
};

const PRESETS = {
  'cf-doh': { name: 'Cloudflare DoH (Official)', type: 'DOH', url: 'https://cloudflare-dns.com/dns-query' },
  'google-doh': { name: 'Google DoH', type: 'DOH', url: 'https://dns.google/dns-query' },
  'quad9-doh': { name: 'Quad9 DoH', type: 'DOH', url: 'https://dns.quad9.net/dns-query' },
  'adguard-doh': { name: 'AdGuard DoH', type: 'DOH', url: 'https://dns.adguard-dns.com/dns-query' },
  'cf-udp': { name: 'Cloudflare UDP (1.1.1.1)', type: 'UDP', host: '1.1.1.1', port: 53 },
  'google-udp': { name: 'Google UDP (8.8.8.8)', type: 'UDP', host: '8.8.8.8', port: 53 }
};

const activeConnections = new Map();
const activeDownloadTasks = new Map();
let connectionIdCounter = 0;
let taskIdCounter = 0;
let globalTotalBytesIn = 0;
let globalTotalBytesOut = 0;

const dnsCache = new Map();

async function resolveDomain(hostname) {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && (now - cached.time < 1000 * 60 * 10)) return cached.ip;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return hostname;

  if (DNS_CONFIG.mode === 'DOH') {
    try {
      const url = new URL(DNS_CONFIG.dohUrl);
      url.searchParams.set('name', hostname);
      url.searchParams.set('type', 'A');
      const res = await fetch(url.toString(), {
        headers: { 'Accept': 'application/dns-json' },
        signal: AbortSignal.timeout(1800)
      });
      const data = await res.json();
      if (data.Answer && data.Answer.length > 0) {
        const aRecord = data.Answer.find(ans => ans.type === 1);
        if (aRecord && aRecord.data) {
          dnsCache.set(hostname, { ip: aRecord.data, time: now });
          return aRecord.data;
        }
      }
    } catch (_) {}
  }

  if (DNS_CONFIG.mode === 'UDP' && DNS_CONFIG.udpServer) {
    try {
      const resolver = new dns.Resolver();
      resolver.setServers([`${DNS_CONFIG.udpServer}:${DNS_CONFIG.udpPort || 53}`]);
      return await new Promise((resolve, reject) => {
        resolver.resolve4(hostname, (err, addresses) => {
          if (!err && addresses && addresses.length > 0) {
            dnsCache.set(hostname, { ip: addresses[0], time: now });
            resolve(addresses[0]);
          } else reject(err);
        });
      });
    } catch (_) {}
  }

  return new Promise((resolve) => {
    dns.lookup(hostname, (err, address) => {
      const ip = (!err && address) ? address : '104.16.123.96';
      dnsCache.set(hostname, { ip, time: now });
      resolve(ip);
    });
  });
}

setInterval(() => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(DOWNLOAD_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 1000 * 60 * 60 * 24) fs.unlinkSync(filePath);
    });
  } catch (_) {}
}, 1000 * 60 * 60);

// Header PC Desktop Chrome Lengkap (Anti-Throttling)
function getPcHeaders(targetUrl, extraHeaders = {}) {
  let host = '';
  try { host = new URL(targetUrl).hostname; } catch (_) {}
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
    'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Referer': host ? `https://${host}/` : 'https://www.google.com/',
    ...extraHeaders
  };
}

// 32-Thread Parallel Downloader Engine
async function startRemoteDownload(targetUrl, customName) {
  const taskId = ++taskIdCounter;
  let filename = customName || path.basename(new URL(targetUrl).pathname) || `video_${Date.now()}`;
  if (!filename.includes('.')) filename += '.mp4';
  filename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(DOWNLOAD_DIR, filename);

  const THREADS = 32;

  const task = {
    id: taskId,
    url: targetUrl,
    filename,
    downloadedBytes: 0,
    totalBytes: 0,
    progress: 0,
    speed: '0 KB/s',
    status: 'DOWNLOADING (32 THREADS)',
    error: null
  };
  activeDownloadTasks.set(taskId, task);

  let lastDownloaded = 0;
  const speedInterval = setInterval(() => {
    const diff = task.downloadedBytes - lastDownloaded;
    task.speed = formatBytes(diff) + '/s';
    lastDownloaded = task.downloadedBytes;
  }, 1000);

  try {
    const headRes = await fetch(targetUrl, {
      method: 'GET',
      headers: getPcHeaders(targetUrl, { 'Range': 'bytes=0-0' })
    });

    let totalBytes = 0;
    const contentRange = headRes.headers.get('content-range');
    const contentLength = headRes.headers.get('content-length');

    if (contentRange) {
      const match = contentRange.match(/\/(\d+)/);
      if (match) totalBytes = parseInt(match[1], 10);
    } else if (contentLength) {
      totalBytes = parseInt(contentLength, 10);
    }

    // Jika server menolak multi-thread, pakai stream tunggal ber-header PC
    if (!totalBytes || (headRes.status !== 206 && !contentRange)) {
      task.status = 'DOWNLOADING (TURBO STREAM)';
      const streamRes = await fetch(targetUrl, { headers: getPcHeaders(targetUrl) });
      if (!streamRes.ok) throw new Error(`HTTP Error ${streamRes.status}`);

      const len = streamRes.headers.get('content-length');
      if (len) task.totalBytes = parseInt(len, 10);

      const fileStream = fs.createWriteStream(destPath);
      const reader = streamRes.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        task.downloadedBytes += value.length;
        if (task.totalBytes > 0) {
          task.progress = Math.floor((task.downloadedBytes / task.totalBytes) * 100);
        }
      }
      fileStream.end();
      clearInterval(speedInterval);
      task.status = 'COMPLETED';
      task.progress = 100;
      return;
    }

    task.totalBytes = totalBytes;

    const fileFd = fs.openSync(destPath, 'w');
    fs.ftruncateSync(fileFd, totalBytes);
    fs.closeSync(fileFd);

    const chunkSize = Math.ceil(totalBytes / THREADS);
    const chunkPromises = [];
    const threadProgress = new Array(THREADS).fill(0);

    for (let i = 0; i < THREADS; i++) {
      const start = i * chunkSize;
      const end = Math.min((i + 1) * chunkSize - 1, totalBytes - 1);

      const downloadChunk = async () => {
        const res = await fetch(targetUrl, {
          headers: getPcHeaders(targetUrl, { 'Range': `bytes=${start}-${end}` })
        });

        if (!res.ok && res.status !== 206) throw new Error(`Part ${i} err: ${res.status}`);

        const reader = res.body.getReader();
        let currentOffset = start;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunkBuf = Buffer.from(value);

          const fd = fs.openSync(destPath, 'r+');
          fs.writeSync(fd, chunkBuf, 0, chunkBuf.length, currentOffset);
          fs.closeSync(fd);

          currentOffset += chunkBuf.length;
          threadProgress[i] += chunkBuf.length;

          task.downloadedBytes = threadProgress.reduce((a, b) => a + b, 0);
          task.progress = Math.floor((task.downloadedBytes / task.totalBytes) * 100);
        }
      };
      chunkPromises.push(downloadChunk());
    }

    await Promise.all(chunkPromises);
    clearInterval(speedInterval);
    task.status = 'COMPLETED';
    task.progress = 100;
  } catch (err) {
    clearInterval(speedInterval);
    task.status = 'FAILED';
    task.error = err.message;
    if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  }
}

// Server Core TCP
const server = net.createServer({
  noDelay: true,
  allowHalfOpen: false,
  pauseOnConnect: false
}, (clientSocket) => {
  clientSocket.setNoDelay(true);
  clientSocket.setKeepAlive(true, 5000);
  clientSocket.setMaxListeners(0);

  const connId = ++connectionIdCounter;
  const rawIp = clientSocket.remoteAddress || 'Unknown';
  const clientIp = rawIp.replace('::ffff:', '');
  const startTime = Date.now();

  const connData = {
    id: connId,
    clientIp,
    type: 'INITIALIZING',
    target: 'pending',
    startTime,
    bytesIn: 0,
    bytesOut: 0
  };

  let isFirstPacket = true;
  let targetSocket = null;

  const bridgeSockets = (sockA, sockB) => {
    sockA.on('data', (d) => {
      connData.bytesIn += d.length;
      globalTotalBytesIn += d.length;
    });
    sockB.on('data', (d) => {
      connData.bytesOut += d.length;
      globalTotalBytesOut += d.length;
    });

    sockA.pipe(sockB, { end: true });
    sockB.pipe(sockA, { end: true });

    const cleanup = () => {
      activeConnections.delete(connId);
      sockA.destroy();
      sockB.destroy();
    };

    sockA.on('error', cleanup);
    sockB.on('error', cleanup);
    sockA.on('close', cleanup);
    sockB.on('close', cleanup);
  };

  clientSocket.on('data', async (chunk) => {
    if (isFirstPacket) {
      isFirstPacket = false;
      const dataStr = chunk.toString('utf-8');

      if (dataStr.startsWith('GET /') || dataStr.startsWith('POST /')) {
        const firstLine = dataStr.split('\r\n')[0];
        const [method, fullPath] = firstLine.split(' ');
        const urlObj = new URL(fullPath, 'http://localhost');
        const pathname = urlObj.pathname;

        if (pathname === '/api/stats') {
          const activeList = Array.from(activeConnections.values())
            .filter(c => !c.target.includes('railway.com') && !c.target.includes('up.railway.app'))
            .map(c => ({
              id: c.id,
              clientIp: c.clientIp,
              type: c.type,
              target: c.target,
              uptime: Math.floor((Date.now() - c.startTime) / 1000),
              bytesIn: formatBytes(c.bytesIn),
              bytesOut: formatBytes(c.bytesOut)
            }));

          let storageFiles = [];
          try {
            const files = fs.readdirSync(DOWNLOAD_DIR);
            storageFiles = files.map(file => {
              const stat = fs.statSync(path.join(DOWNLOAD_DIR, file));
              return {
                name: file,
                size: formatBytes(stat.size),
                time: new Date(stat.mtimeMs).toLocaleTimeString('id-ID')
              };
            });
          } catch (_) {}

          const resBody = JSON.stringify({
            proxyInfo: PROXY_SERVER_INFO,
            dnsConfig: DNS_CONFIG,
            totalActive: new Set(activeList.map(c => c.clientIp)).size,
            globalTotalIn: formatBytes(globalTotalBytesIn),
            globalTotalOut: formatBytes(globalTotalBytesOut),
            connections: activeList,
            storageFiles,
            downloadTasks: Array.from(activeDownloadTasks.values()).map(t => ({
              ...t,
              downloaded: formatBytes(t.downloadedBytes),
              total: formatBytes(t.totalBytes)
            }))
          });

          clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: ${Buffer.byteLength(resBody)}\r\nConnection: close\r\n\r\n${resBody}`);
          clientSocket.end();
          return;
        }

        if (pathname === '/api/start-download' && method === 'POST') {
          try {
            const bodyStr = dataStr.split('\r\n\r\n')[1] || '{}';
            const body = JSON.parse(bodyStr);
            if (body.url) {
              startRemoteDownload(body.url, body.filename);
              const resBody = JSON.stringify({ success: true });
              clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${resBody.length}\r\nConnection: close\r\n\r\n${resBody}`);
            } else {
              throw new Error('URL diperlukan');
            }
          } catch (e) {
            const errBody = JSON.stringify({ success: false, error: e.message });
            clientSocket.write(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${errBody.length}\r\nConnection: close\r\n\r\n${errBody}`);
          }
          clientSocket.end();
          return;
        }

        if (pathname === '/api/delete-file' && method === 'POST') {
          try {
            const bodyStr = dataStr.split('\r\n\r\n')[1] || '{}';
            const { name } = JSON.parse(bodyStr);
            const safePath = path.join(DOWNLOAD_DIR, path.basename(name));
            if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
            const resBody = JSON.stringify({ success: true });
            clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${resBody.length}\r\nConnection: close\r\n\r\n${resBody}`);
          } catch (e) {
            const errBody = JSON.stringify({ success: false, error: e.message });
            clientSocket.write(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${errBody.length}\r\nConnection: close\r\n\r\n${errBody}`);
          }
          clientSocket.end();
          return;
        }

        if (pathname.startsWith('/files/')) {
          const rawFilename = decodeURIComponent(pathname.replace('/files/', ''));
          const safeFilePath = path.join(DOWNLOAD_DIR, path.basename(rawFilename));

          if (!fs.existsSync(safeFilePath)) {
            clientSocket.write(`HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found`);
            clientSocket.end();
            return;
          }

          const stat = fs.statSync(safeFilePath);
          const totalSize = stat.size;
          const range = dataStr.match(/Range:\s*bytes=(\d+)-(\d*)/i);

          if (range) {
            const start = parseInt(range[1], 10);
            const end = range[2] ? parseInt(range[2], 10) : totalSize - 1;
            const chunksize = (end - start) + 1;

            clientSocket.write(`HTTP/1.1 206 Partial Content\r\nContent-Range: bytes ${start}-${end}/${totalSize}\r\nAccept-Ranges: bytes\r\nContent-Length: ${chunksize}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${path.basename(safeFilePath)}"\r\n\r\n`);
            const stream = fs.createReadStream(safeFilePath, { start, end });
            stream.pipe(clientSocket);
          } else {
            clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${totalSize}\r\nAccept-Ranges: bytes\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${path.basename(safeFilePath)}"\r\n\r\n`);
            const stream = fs.createReadStream(safeFilePath);
            stream.pipe(clientSocket);
          }
          return;
        }

        if (pathname.startsWith('/api/set-dns') && method === 'POST') {
          try {
            const bodyStr = dataStr.split('\r\n\r\n')[1] || '{}';
            const body = JSON.parse(bodyStr);

            if (body.preset && PRESETS[body.preset]) {
              const p = PRESETS[body.preset];
              DNS_CONFIG.mode = p.type;
              DNS_CONFIG.activeName = p.name;
              if (p.type === 'DOH') DNS_CONFIG.dohUrl = p.url;
              else { DNS_CONFIG.udpServer = p.host; DNS_CONFIG.udpPort = p.port; }
            } else if (body.mode === 'DOH') {
              DNS_CONFIG.mode = 'DOH';
              DNS_CONFIG.activeName = 'Custom DoH Pribadi';
              DNS_CONFIG.dohUrl = body.dohUrl || 'https://cloudflare-dns.com/dns-query';
            } else if (body.mode === 'UDP') {
              DNS_CONFIG.mode = 'UDP';
              DNS_CONFIG.activeName = 'Custom DNS UDP Pribadi';
              DNS_CONFIG.udpServer = body.udpServer || '1.1.1.1';
              DNS_CONFIG.udpPort = parseInt(body.udpPort, 10) || 53;
            }

            dnsCache.clear();
            const resBody = JSON.stringify({ success: true, config: DNS_CONFIG });
            clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${resBody.length}\r\nConnection: close\r\n\r\n${resBody}`);
          } catch (e) {
            const errBody = JSON.stringify({ success: false, error: e.message });
            clientSocket.write(`HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${errBody.length}\r\nConnection: close\r\n\r\n${errBody}`);
          }
          clientSocket.end();
          return;
        }

        if (pathname === '/' || pathname === '/index.html') {
          const html = renderDashboardHTML();
          clientSocket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`);
          clientSocket.end();
          return;
        }

        const hostMatch = dataStr.match(/Host:\s*([^\r\n:]+)(?::(\d+))?/i);
        const targetHost = hostMatch ? hostMatch[1].trim() : 'speed.cloudflare.com';
        const targetPort = hostMatch && hostMatch[2] ? parseInt(hostMatch[2], 10) : 80;

        if (!targetHost.includes('railway.com') && !targetHost.includes('up.railway.app')) {
          connData.type = 'HTTP SCAN';
          connData.target = `${targetHost}:${targetPort}`;
          activeConnections.set(connId, connData);
        }

        const resolvedIp = await resolveDomain(targetHost);
        targetSocket = net.connect({ host: resolvedIp, port: targetPort, noDelay: true }, () => {
          targetSocket.setNoDelay(true);
          targetSocket.setKeepAlive(true, 5000);
          targetSocket.write(chunk);
          bridgeSockets(clientSocket, targetSocket);
        });

        targetSocket.on('error', () => { activeConnections.delete(connId); clientSocket.destroy(); });
        return;
      }

      if (dataStr.startsWith('CONNECT ')) {
        const match = dataStr.match(/CONNECT\s+([^:\s]+):(\d+)/i);
        if (match) {
          const targetHost = match[1];
          const targetPort = parseInt(match[2], 10) || 443;

          if (!targetHost.includes('railway.com') && !targetHost.includes('up.railway.app')) {
            connData.type = 'HTTPS TUNNEL';
            connData.target = `${targetHost}:${targetPort}`;
            activeConnections.set(connId, connData);
          }

          const resolvedIp = await resolveDomain(targetHost);
          targetSocket = net.connect({ host: resolvedIp, port: targetPort, noDelay: true }, () => {
            targetSocket.setNoDelay(true);
            targetSocket.setKeepAlive(true, 5000);
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            bridgeSockets(clientSocket, targetSocket);
          });

          targetSocket.on('error', () => { activeConnections.delete(connId); clientSocket.destroy(); });
          return;
        }
      }

      const sni = parseTlsSni(chunk);
      const destinationHost = sni || 'speed.cloudflare.com';

      if (!destinationHost.includes('railway.com') && !destinationHost.includes('up.railway.app')) {
        connData.type = sni ? 'VLESS / TROJAN' : 'RAW TCP';
        connData.target = `${destinationHost}:443`;
        activeConnections.set(connId, connData);
      }

      const resolvedIp = await resolveDomain(destinationHost);
      targetSocket = net.connect({ host: resolvedIp, port: 443, noDelay: true }, () => {
        targetSocket.setNoDelay(true);
        targetSocket.setKeepAlive(true, 5000);
        targetSocket.write(chunk);
        bridgeSockets(clientSocket, targetSocket);
      });

      targetSocket.on('error', () => { activeConnections.delete(connId); clientSocket.destroy(); });
    }
  });

  clientSocket.on('error', () => { activeConnections.delete(connId); if (targetSocket) targetSocket.destroy(); });
  clientSocket.on('close', () => { activeConnections.delete(connId); if (targetSocket) targetSocket.destroy(); });
});

function parseTlsSni(buffer) {
  try {
    if (buffer[0] !== 0x16) return null;
    let pos = 43;
    if (pos >= buffer.length) return null;
    const sessionIdLen = buffer[pos];
    pos += 1 + sessionIdLen;
    const cipherSuitesLen = buffer.readUInt16BE(pos);
    pos += 2 + cipherSuitesLen;
    const compMethodsLen = buffer[pos];
    pos += 1 + compMethodsLen;
    if (pos >= buffer.length) return null;
    const extensionsLen = buffer.readUInt16BE(pos);
    pos += 2;
    const endExtensions = pos + extensionsLen;
    while (pos + 4 <= endExtensions && pos + 4 <= buffer.length) {
      const extType = buffer.readUInt16BE(pos);
      const extLen = buffer.readUInt16BE(pos + 2);
      pos += 4;
      if (extType === 0) {
        let sniPos = pos + 2;
        if (buffer[sniPos] === 0) {
          const nameLen = buffer.readUInt16BE(sniPos + 1);
          return buffer.toString('utf8', sniPos + 3, sniPos + 3 + nameLen);
        }
      }
      pos += extLen;
    }
  } catch (_) { return null; }
  return null;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Proxy & 32-Thread Downloader</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #06090e; color: #00ffcc; padding: 14px; margin: 0; display: flex; justify-content: center; }
    .card { background: #0c121e; border: 1px solid #00ffcc; box-shadow: 0 0 20px rgba(0,255,204,0.15); border-radius: 14px; max-width: 480px; width: 100%; padding: 18px; }
    h2 { margin: 0 0 16px 0; color: #38bdf8; text-align: center; font-size: 1.15rem; }
    
    .proxy-box { background: #030712; border: 1px solid #38bdf8; border-radius: 10px; padding: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
    .proxy-title { font-size: 0.72rem; color: #94a3b8; text-transform: uppercase; margin-bottom: 4px; }
    .proxy-val { font-family: monospace; font-size: 1.05rem; font-weight: bold; color: #39ff14; }
    .proxy-sub { font-family: monospace; font-size: 0.7rem; color: #64748b; margin-top: 2px; }
    .btn-copy { background: #1e293b; border: 1px solid #38bdf8; color: #38bdf8; padding: 8px 12px; border-radius: 6px; font-size: 0.75rem; font-weight: bold; cursor: pointer; }
    .btn-copy:active { background: #38bdf8; color: #000; }

    .badge-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 18px; }
    .badge { background: #030712; border: 1px solid #1e293b; border-radius: 10px; padding: 12px 10px; text-align: center; }
    .badge h4 { margin: 0; font-size: 0.72rem; color: #94a3b8; text-transform: uppercase; }
    .badge .val { font-size: 1.3rem; font-weight: bold; margin-top: 5px; font-family: monospace; }
    .badge .sub-val { font-size: 0.68rem; color: #94a3b8; margin-top: 3px; font-family: monospace; word-break: break-all; }
    
    .section-title { font-size: 0.85rem; font-weight: bold; color: #38bdf8; margin-top: 18px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
    
    .conn-list { display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto; }
    .conn-item { background: #030712; border: 1px solid #1e293b; border-left: 3px solid #39ff14; border-radius: 8px; padding: 10px 12px; }
    .conn-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .conn-ip { font-family: monospace; font-size: 0.85rem; font-weight: bold; color: #f8fafc; }
    .tag { background: #032b17; color: #39ff14; padding: 2px 6px; border-radius: 4px; border: 1px solid #39ff14; font-size: 0.65rem; font-weight: bold; }
    .conn-target { font-family: monospace; font-size: 0.75rem; color: #38bdf8; word-break: break-all; }
    
    .download-box { background: #030712; border: 1px solid #38bdf8; border-radius: 10px; padding: 12px; margin-top: 8px; }
    .file-item { background: #090e17; border: 1px solid #1e293b; border-radius: 6px; padding: 8px 10px; margin-top: 6px; display: flex; justify-content: space-between; align-items: center; }
    .file-info { font-family: monospace; font-size: 0.75rem; color: #fff; max-width: 60%; word-break: break-all; }
    .file-meta { font-size: 0.68rem; color: #94a3b8; }
    .btn-action { padding: 5px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold; cursor: pointer; text-decoration: none; border: none; }
    .btn-dl { background: #00ffcc; color: #000; margin-right: 4px; }
    .btn-del { background: #ef4444; color: #fff; }

    select, input { width: 100%; padding: 10px 12px; background: #030712; border: 1px solid #1e293b; border-radius: 8px; color: #fff; margin-top: 6px; font-family: monospace; font-size: 0.82rem; outline: none; }
    select:focus, input:focus { border-color: #00ffcc; }
    button.btn-main { width: 100%; padding: 12px; background: #00ffcc; color: #000; font-weight: bold; border: none; border-radius: 8px; margin-top: 10px; cursor: pointer; font-size: 0.85rem; }
    
    .toast { display: none; padding: 8px; text-align: center; border-radius: 6px; margin-top: 10px; font-size: 0.8rem; font-weight: bold; }
    .toast.success { display: block; background: #052e16; color: #4ade80; border: 1px solid #4ade80; }
  </style>
</head>
<body>
  <div class="card">
    <h2>⚡ PROXY & 32-THREAD LEECH</h2>
    
    <div class="proxy-box">
      <div>
        <div class="proxy-title">🚀 Active Proxy Server (IP:Port)</div>
        <div class="proxy-val" id="proxy_full_text">${PROXY_SERVER_INFO.fullProxy || 'Loading IP...'}</div>
        <div class="proxy-sub" id="proxy_sub_text">${PROXY_SERVER_INFO.domain ? PROXY_SERVER_INFO.domain + ':' + PROXY_SERVER_INFO.port : 'Railway Direct'}</div>
      </div>
      <button type="button" class="btn-copy" onclick="copyProxy()">📋 SALIN</button>
    </div>

    <div class="badge-grid">
      <div class="badge">
        <h4>User Konek</h4>
        <div class="val" style="color:#39ff14;" id="active_count">0</div>
      </div>
      <div class="badge">
        <h4>Status DNS</h4>
        <div class="val" style="color:#38bdf8; font-size:1.05rem;" id="badge_dns_mode">${DNS_CONFIG.mode}</div>
        <div class="sub-val" id="badge_dns_target">${DNS_CONFIG.mode === 'DOH' ? DNS_CONFIG.dohUrl : DNS_CONFIG.udpServer + ':' + DNS_CONFIG.udpPort}</div>
      </div>
      <div class="badge">
        <h4>Total In (RX)</h4>
        <div class="val" style="color:#00ffcc;" id="total_rx">0 B</div>
      </div>
      <div class="badge">
        <h4>Total Out (TX)</h4>
        <div class="val" style="color:#f59e0b;" id="total_tx">0 B</div>
      </div>
    </div>

    <div class="section-title">📥 32-THREAD REMOTE DOWNLOADER</div>
    <div class="download-box">
      <input type="text" id="dl_url" placeholder="Tempel Link Terabox / Direct URL Video">
      <input type="text" id="dl_custom_name" placeholder="Nama File (Opsional, contoh: video.mp4)">
      <button class="btn-main" style="background:#38bdf8;" onclick="submitRemoteDownload()">⚡ START 32-THREAD DOWNLOAD</button>

      <div id="task_container" style="margin-top:10px;"></div>

      <div style="font-size:0.75rem; color:#94a3b8; margin-top:12px; font-weight:bold;">📁 File Tersimpan di Server:</div>
      <div id="file_list_container"></div>
    </div>

    <div class="section-title">🟢 KONEKSI AKTIF REAL-TIME</div>
    <div class="conn-list" id="conn_container">
      <div style="text-align:center; color:#64748b; font-size:0.75rem; padding:10px;">Belum ada perangkat terhubung...</div>
    </div>

    <div class="section-title">⚙️ PENGATURAN DNS RESOLVER</div>
    <select id="preset_select" onchange="applyPreset()">
      <option value="cf-doh">Cloudflare DoH (Official)</option>
      <option value="google-doh">Google DoH</option>
      <option value="quad9-doh">Quad9 DoH (Security)</option>
      <option value="adguard-doh">AdGuard DoH (Adblock)</option>
      <option value="cf-udp">Cloudflare UDP (1.1.1.1:53)</option>
      <option value="google-udp">Google UDP (8.8.8.8:53)</option>
      <option value="custom_doh">✏️ Custom DoH Pribadi (URL)</option>
      <option value="custom_udp">✏️ Custom DNS UDP Pribadi (IP + Port)</option>
    </select>

    <div id="box_custom_doh" style="display:none; margin-top:8px;">
      <input type="text" id="custom_doh_url" placeholder="https://dns.nextdns.io/xxxxxx" value="${DNS_CONFIG.dohUrl}">
    </div>

    <div id="box_custom_udp" style="display:none; margin-top:8px;">
      <input type="text" id="custom_udp_ip" placeholder="IP: 94.140.14.14" value="${DNS_CONFIG.udpServer}">
      <input type="number" id="custom_udp_port" placeholder="Port: 53" value="${DNS_CONFIG.udpPort || 53}">
    </div>

    <button class="btn-main" onclick="saveDns()">💾 SIMPAN DNS</button>
    <div id="toast" class="toast"></div>
  </div>

  <script>
    let currentProxyString = "${PROXY_SERVER_INFO.fullProxy}";

    async function fetchStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        
        if (data.proxyInfo && data.proxyInfo.fullProxy) {
          currentProxyString = data.proxyInfo.fullProxy;
          document.getElementById('proxy_full_text').innerText = data.proxyInfo.fullProxy;
          if (data.proxyInfo.domain) {
            document.getElementById('proxy_sub_text').innerText = data.proxyInfo.domain + ':' + data.proxyInfo.port;
          }
        }

        if (data.dnsConfig) {
          document.getElementById('badge_dns_mode').innerText = data.dnsConfig.mode + ' (' + (data.dnsConfig.activeName || 'Active') + ')';
          document.getElementById('badge_dns_target').innerText = data.dnsConfig.mode === 'DOH' 
            ? data.dnsConfig.dohUrl 
            : data.dnsConfig.udpServer + ':' + data.dnsConfig.udpPort;
        }

        document.getElementById('active_count').innerText = data.totalActive;
        document.getElementById('total_rx').innerText = data.globalTotalIn;
        document.getElementById('total_tx').innerText = data.globalTotalOut;

        const fileBox = document.getElementById('file_list_container');
        if (!data.storageFiles || data.storageFiles.length === 0) {
          fileBox.innerHTML = '<div style="font-size:0.7rem; color:#64748b; padding:4px 0;">Belum ada file di server.</div>';
        } else {
          fileBox.innerHTML = data.storageFiles.map(f => \`
            <div class="file-item">
              <div class="file-info">
                <div>\${f.name}</div>
                <div class="file-meta">💾 \${f.size} | ⏱️ \${f.time}</div>
              </div>
              <div>
                <a href="/files/\${encodeURIComponent(f.name)}" class="btn-action btn-dl">⬇️ AMBIL KE HP</a>
                <button class="btn-action btn-del" onclick="deleteFile('\${f.name}')">🗑️</button>
              </div>
            </div>
          \`).join('');
        }

        const taskBox = document.getElementById('task_container');
        if (data.downloadTasks && data.downloadTasks.length > 0) {
          taskBox.innerHTML = data.downloadTasks.map(t => \`
            <div style="background:#090e17; padding:6px 8px; border-radius:6px; font-size:0.7rem; margin-top:4px; font-family:monospace;">
              <div>⚡ \${t.filename} (\${t.status})</div>
              <div>Speed: \${t.speed || 'Calculating...'} | Progress: \${t.progress}% (\${t.downloaded} / \${t.total})</div>
            </div>
          \`).join('');
        } else {
          taskBox.innerHTML = '';
        }

        const container = document.getElementById('conn_container');
        if (!data.connections || data.connections.length === 0) {
          container.innerHTML = '<div style="text-align:center; color:#64748b; font-size:0.75rem; padding:10px;">Belum ada perangkat terhubung...</div>';
          return;
        }

        container.innerHTML = data.connections.map(c => \`
          <div class="conn-item">
            <div class="conn-head">
              <span class="conn-ip">\${c.clientIp}</span>
              <span class="tag">\${c.type}</span>
            </div>
            <div class="conn-target">🎯 \${c.target}</div>
          </div>
        \`).join('');
      } catch (e) {}
    }

    setInterval(fetchStats, 2000);
    fetchStats();

    async function submitRemoteDownload() {
      const url = document.getElementById('dl_url').value.trim();
      const filename = document.getElementById('dl_custom_name').value.trim();
      if (!url) return alert('Masukkan URL download terlebih dahulu!');

      await fetch('/api/start-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, filename })
      });
      document.getElementById('dl_url').value = '';
      document.getElementById('dl_custom_name').value = '';
    }

    async function deleteFile(name) {
      if (!confirm('Hapus file ' + name + ' dari server?')) return;
      await fetch('/api/delete-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
    }

    function copyProxy() {
      if (!currentProxyString) return;
      navigator.clipboard.writeText(currentProxyString).then(() => {
        const toast = document.getElementById('toast');
        toast.innerText = '📋 IP:Port Berhasil Disalin: ' + currentProxyString;
        toast.className = 'toast success';
        setTimeout(() => toast.style.display = 'none', 2500);
      });
    }

    function applyPreset() {
      const val = document.getElementById('preset_select').value;
      document.getElementById('box_custom_doh').style.display = (val === 'custom_doh') ? 'block' : 'none';
      document.getElementById('box_custom_udp').style.display = (val === 'custom_udp') ? 'block' : 'none';
    }

    async function saveDns() {
      const selected = document.getElementById('preset_select').value;
      let payload = {};

      if (selected === 'custom_doh') {
        payload = { mode: 'DOH', dohUrl: document.getElementById('custom_doh_url').value.trim() };
      } else if (selected === 'custom_udp') {
        payload = {
          mode: 'UDP',
          udpServer: document.getElementById('custom_udp_ip').value.trim(),
          udpPort: document.getElementById('custom_udp_port').value.trim()
        };
      } else {
        payload = { preset: selected };
      }

      const res = await fetch('/api/set-dns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('badge_dns_mode').innerText = data.config.mode + ' (' + data.config.activeName + ')';
        document.getElementById('badge_dns_target').innerText = data.config.mode === 'DOH' 
          ? data.config.dohUrl 
          : data.config.udpServer + ':' + data.config.udpPort;

        const toast = document.getElementById('toast');
        toast.innerText = '✅ DNS Berhasil Diterapkan ke ' + data.config.activeName + '!';
        toast.className = 'toast success';
        setTimeout(() => toast.style.display = 'none', 3000);
      }
    }
  </script>
</body>
</html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`32-Thread Leech Downloader running on port ${PORT}`);
});
