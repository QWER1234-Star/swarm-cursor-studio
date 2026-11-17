#!/usr/bin/env node
'use strict';
/**
 * SwarmSite 本机接口（零依赖，Node 18+）
 *
 * 为什么需要它：
 *   双击 index.html 打开时是 file:// 页面，浏览器会以「跨域」为由拦掉所有
 *   发往 api.deepseek.com 之类的请求 —— 于是填了 API Key 也生成不了。
 *   这个脚本把页面用 http://127.0.0.1:5173 提供出来，并额外开一个同源接口
 *   /api/llm/chat 替你转发请求：浏览器只跟 127.0.0.1 说话，Key 由服务端注入，
 *   任何 OpenAI 兼容的服务商都能用，也不会有跨域问题。
 *
 * 用法：
 *   node server.js              启动并自动打开浏览器（默认 5173）
 *   node server.js --port 8080  换端口
 *   node server.js --no-open    不自动开浏览器
 *
 * 环境变量（可替代页面里的填写）：
 *   LLM_BASE_URL  LLM_API_KEY  LLM_MODEL
 *
 * 配置存在同目录 .llm.json（权限 600），不会上传到任何地方。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const zlib = require('zlib');

const ROOT = __dirname;
// 默认存在项目目录；测试或高级用法可用 SWARM_LLM_CONF 指到别处
const CONF_FILE = process.env.SWARM_LLM_CONF
  ? path.resolve(process.env.SWARM_LLM_CONF)
  : path.join(ROOT, '.llm.json');
const BASE_PORT = readFlagPort(process.env.PORT) || 5173;
const AUTO_OPEN = process.argv.indexOf('--no-open') < 0 && !process.env.SWARM_NO_OPEN;

// 图片代理：本地缓存目录 / 上游地址（测试时可指到本地假服务）
const IMG_CACHE = process.env.SWARM_IMG_CACHE
  ? path.resolve(process.env.SWARM_IMG_CACHE)
  : path.join(ROOT, '.imgcache');
const IMG_UPSTREAM = (process.env.SWARM_IMG_BASE || 'https://images.unsplash.com').replace(/\/+$/, '');

const DEFAULTS = {
  baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
  model: process.env.LLM_MODEL || 'deepseek-chat',
  apiKey: process.env.LLM_API_KEY || ''
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------------- 小工具 ---------------- */

function readFlagPort(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 0;
}

function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  if (s.length <= 8) return '••••';
  return s.slice(0, 3) + '…' + s.slice(-4);
}

function isLocalHost(u) {
  try {
    const h = new URL(u).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
  } catch (e) {
    return false;
  }
}

/** 把用户填的地址补成 .../chat/completions */
function normalizeBase(u) {
  if (!u) return '';
  let s = String(u).trim().replace(/\s+/g, '').replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/i, '');
  try {
    const url = new URL(s);
    if (!url.pathname || url.pathname === '/') {
      return url.origin + '/v1';
    }
  } catch (e) {
    return '';
  }
  return s;
}

function readConf() {
  try {
    const j = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (e) {
    return {};
  }
}

function writeConf(patch) {
  const cur = readConf();
  const next = Object.assign({}, cur, patch);
  Object.keys(next).forEach((k) => {
    if (next[k] === '' || next[k] == null) delete next[k];
  });
  fs.writeFileSync(CONF_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONF_FILE, 0o600); } catch (e) { /* Windows 上忽略 */ }
  return next;
}

function resolveConfig(override) {
  const conf = readConf();
  const o = override || {};
  const baseUrl = normalizeBase(o.baseUrl || conf.baseUrl || DEFAULTS.baseUrl);
  const apiKey = String(o.apiKey || conf.apiKey || DEFAULTS.apiKey || '').trim();
  const model = String(o.model || conf.model || DEFAULTS.model || '').trim();
  return { baseUrl, apiKey, model };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 4 * 1024 * 1024)) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 跨域守卫 ----------------
 * 只允许本机页面（含 file:// 的 Origin: null）调用，避免随便一个网站
 * 就能拿你存着的 Key 去刷接口。
 */
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o || o === 'null') return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(o);
}

function applyCors(req, res) {
  const o = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', o && o !== 'null' ? o : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Swarm-Gateway');
  res.setHeader('Access-Control-Max-Age', '600');
}

/* ---------------- 上游调用 ---------------- */

function pickText(json) {
  if (!json) return '';
  if (typeof json === 'string') return json;
  const c = json.choices && json.choices[0];
  if (c) {
    if (c.message && typeof c.message.content === 'string' && c.message.content.trim()) return c.message.content;
    if (typeof c.text === 'string') return c.text;
  }
  if (typeof json.response === 'string') return json.response;   // Ollama 原生
  if (json.error) {
    const e = json.error;
    throw new Error(typeof e === 'string' ? e : (e.message || JSON.stringify(e)));
  }
  return '';
}

async function handleChat(req, res, body) {
  const cfg = resolveConfig({ baseUrl: body.baseUrl, apiKey: body.apiKey, model: body.model });
  if (!cfg.baseUrl) return sendJson(res, 400, { error: '上游地址不合法，检查一下 API 地址（例如 https://api.deepseek.com/v1）' });
  if (!cfg.apiKey && !isLocalHost(cfg.baseUrl)) {
    return sendJson(res, 400, { error: '缺少 API Key：在面板里填一次，或点「保存到本机接口」存下来' });
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendJson(res, 400, { error: 'messages 不能为空' });
  }

  const target = cfg.baseUrl + '/chat/completions';
  const payload = {
    model: cfg.model || 'gpt-4o-mini',
    messages: body.messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.6,
    stream: !!body.stream
  };
  if (body.max_tokens) payload.max_tokens = body.max_tokens;

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180000);
  req.on('close', () => clearTimeout(timer));

  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e && e.name === 'AbortError' ? '上游 180 秒没返回，先换个快点的模型试试' : ('连不上上游：' + (e && e.message ? e.message : e));
    return sendJson(res, 502, { error: msg, baseUrl: cfg.baseUrl });
  }

  const ct = upstream.headers.get('content-type') || '';

  /* 流式：把上游的 SSE 原样吐给浏览器，前端边收边显示进度 */
  if (payload.stream && upstream.ok && /text\/event-stream/i.test(ct) && upstream.body) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    try {
      for await (const chunk of upstream.body) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
    } catch (e) {
      try { res.write('data: ' + JSON.stringify({ error: '上游中断：' + (e.message || e) }) + '\n\n'); } catch (_) {}
    }
    clearTimeout(timer);
    return res.end();
  }

  let text = '';
  try {
    text = await upstream.text();
  } catch (e) {
    clearTimeout(timer);
    return sendJson(res, 502, { error: '读取上游响应失败：' + (e.message || e) });
  }
  clearTimeout(timer);

  if (!upstream.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text);
      if (j.error) detail = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
    } catch (e) { /* 保持原文 */ }
    const hint = upstream.status === 401 ? '（Key 不对或没生效）'
      : upstream.status === 402 || upstream.status === 403 ? '（余额不足或没有权限）'
      : upstream.status === 404 ? '（地址或模型名不对）'
      : upstream.status === 429 ? '（请求太频繁，等几秒）'
      : '';
    return sendJson(res, upstream.status, {
      error: 'HTTP ' + upstream.status + ' ' + hint + ' · ' + String(detail).slice(0, 300),
      baseUrl: cfg.baseUrl,
      model: payload.model
    });
  }

  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return sendJson(res, 502, { error: '上游返回的不是 JSON：' + String(text).slice(0, 200) });
  }
  let content = '';
  try {
    content = pickText(json);
  } catch (e) {
    return sendJson(res, 502, { error: e.message });
  }
  return sendJson(res, 200, {
    content: content,
    model: (json && json.model) || payload.model,
    usage: (json && json.usage) || null
  });
}

/* ==========================================================================
 * 图片代理 + 磁盘缓存
 *
 * 问题：页面里的照片原本直连 images.unsplash.com，批量生成时会被 DNS 抖动或
 *      限流打断，表现就是"图没加载出来、只剩渐变兜底"，整屏首屏变成一块色块。
 * 做法：改成同源代理 /img/<id>?w=1200 —— 命中本地缓存直接回，未命中才去上游
 *      取一次并落盘。同一个 id+宽度只会真正下载一次。
 * 附带好处：同源（不受 Referer/CSP 影响）、可长缓存（第二次秒开）、
 *          上游临时挂掉时已缓存的图照样能显示。
 * ========================================================================== */

const IMG_ID_RE = /^photo-[A-Za-z0-9_-]{8,64}$/;
const IMG_MAX_BYTES = 8 * 1024 * 1024;
const IMG_EMBED_TOTAL = 6 * 1024 * 1024;
const IMG_EMBED_MAX = 16;
const IMG_TIMEOUT_MS = 8000;      // 单次尝试的上限：宁可早点失败露出渐变，也别让用户干等 45 秒
const IMG_UPSTREAM_SLOTS = 4;     // 同时回源的上限，别把上游和本机连接池一起打爆
const imgInflight = new Map();
let imgActive = 0;
const imgQueue = [];

/* 一个极简的信号量：排队而不是并发打满 */
function withUpstreamSlot(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      imgActive++;
      const done = () => {
        imgActive--;
        const nxt = imgQueue.shift();
        if (nxt) nxt();
      };
      Promise.resolve().then(fn).then(
        (v) => { done(); resolve(v); },
        (e) => { done(); reject(e); }
      );
    };
    if (imgActive < IMG_UPSTREAM_SLOTS) start();
    else imgQueue.push(start);
  });
}

function imgErrText(e) {
  const base = (e && e.message) || String(e);
  const code = e && e.cause && (e.cause.code || e.cause.message);
  return code && String(base).indexOf(String(code)) < 0 ? base + '（' + code + '）' : base;
}

function imgCacheFile(id, w) {
  return path.join(IMG_CACHE, id + '@' + w + '.jpg');
}

function clampImgWidth(v) {
  let w = parseInt(v, 10);
  if (!isFinite(w) || w <= 0) w = 1200;
  w = Math.max(200, Math.min(2000, w));
  return Math.round(w / 50) * 50;          // 对齐到 50，提高命中率
}

async function fetchImage(id, w) {
  const file = imgCacheFile(id, w);
  const cached = await fs.promises.readFile(file).catch(() => null);
  if (cached && cached.length) return { buf: cached, cached: true };

  const key = id + '@' + w;
  if (imgInflight.has(key)) return imgInflight.get(key);

  const job = withUpstreamSlot(async () => {
    const url = IMG_UPSTREAM + '/' + id + '?w=' + w + '&q=80&auto=format&fit=crop';
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT_MS);
      try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'image/*' } });
        if (!r.ok) throw new Error('上游返回 HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) throw new Error('上游返回空内容');
        if (buf.length > IMG_MAX_BYTES) throw new Error('图片超出大小上限');
        await fs.promises.mkdir(IMG_CACHE, { recursive: true });
        const tmp = file + '.' + process.pid + '.tmp';
        await fs.promises.writeFile(tmp, buf).catch(() => {});
        await fs.promises.rename(tmp, file).catch(() => {});
        return { buf, cached: false };
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || '');
        if (/HTTP 4\d\d/.test(msg)) break;                       // 4xx 直接放弃
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('取图失败');
  });

  imgInflight.set(key, job);
  try { return await job; } finally { imgInflight.delete(key); }
}

async function serveImage(req, res, u) {
  let raw;
  try { raw = decodeURIComponent(u.pathname.slice('/img/'.length)); }
  catch (_) { return sendJson(res, 400, { error: '图片 id 不合法' }); }
  raw = raw.replace(/\.(jpe?g|png|webp)$/i, '');
  if (!IMG_ID_RE.test(raw)) return sendJson(res, 400, { error: '图片 id 不合法' });
  const w = clampImgWidth(u.searchParams.get('w'));

  let out;
  try {
    out = await fetchImage(raw, w);
  } catch (e) {
    // 故意不回占位图：让浏览器的背景层自然露出渐变兜底，比灰块好看
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    return res.end(JSON.stringify({ error: '取图失败：' + imgErrText(e) }));
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': out.buf.length,
    // 内容由 id+宽度唯一决定，可以放心长缓存
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Img-Cache': out.cached ? 'hit' : 'miss'
  });
  if (req.method === 'HEAD') return res.end();
  res.end(out.buf);
}

/* 导出时「内嵌图片」：把蓝图里引用到的图取回来转 base64，让单文件离线也有图 */
async function handleImgEmbed(req, res) {
  let body;
  try { body = await readBody(req, 128 * 1024); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }

  const items = Array.isArray(body.items) ? body.items.slice(0, IMG_EMBED_MAX) : [];
  if (!items.length) return sendJson(res, 400, { error: '没有要内嵌的图片' });

  const images = [];
  let total = 0;
  for (const it of items) {
    const id = String(it.id || '');
    const w = clampImgWidth(it.w);
    if (!IMG_ID_RE.test(id)) { images.push({ id, w, error: 'id 不合法' }); continue; }
    try {
      const r = await fetchImage(id, w);
      if (total + r.buf.length > IMG_EMBED_TOTAL) { images.push({ id, w, error: '总大小超出上限' }); continue; }
      total += r.buf.length;
      images.push({
        id, w, bytes: r.buf.length,
        dataUrl: 'data:image/jpeg;base64,' + r.buf.toString('base64')
      });
    } catch (e) {
      images.push({ id, w, error: e.message || '取图失败' });
    }
  }
  return sendJson(res, 200, { ok: true, totalBytes: total, images });
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return sendJson(res, 403, { error: '越界' });
  const base = path.basename(file);
  if (base.startsWith('.') || rel.indexOf('/tests/') === 0 || rel.indexOf('/node_modules/') >= 0) {
    return sendJson(res, 404, { error: 'not found' });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found: ' + rel });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- 路由 ---------------- */

const started = Date.now();

/* ==========================================================================
 * 文档解析：把用户拖进输入框的文件变成纯文字，喂给大模型
 *
 * Word / Excel / PPT（.docx/.xlsx/.pptx）本质是 zip 包 + XML，用内置 zlib 就能解，
 * 不需要任何第三方依赖 —— 这样双击运行、离线可用。
 * PDF 的编码太复杂（对象流、CID 字体），自己写既不现实也不可靠，走可选依赖 pdf-parse：
 * 装了就能用，没装会在状态栏告诉你一条安装命令，不会静默失败。
 * ========================================================================== */

function unzip(buf) {
  let i = buf.length - 22;
  const floor = Math.max(0, buf.length - 65558);
  for (; i >= floor; i--) if (buf.readUInt32LE(i) === 0x06054b50) break;
  if (i < 0) throw new Error('不是有效的 zip 包（旧版 .doc/.xls/.ppt 请另存为 .docx/.xlsx/.pptx）');
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen).replace(/\\/g, '/');
    try {
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnameLen + lextraLen;
      const raw = buf.subarray(start, start + csize);
      out[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    } catch (_) { /* 单个条目坏了就跳过，不影响其它 */ }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function xmlToText(xml) {
  return String(xml).replace(/^\uFEFF/, '')
    .replace(/<w:p\b[^>]*\/>/g, '\n')
    .replace(/<w:p\b[^>]*>/g, '\n')
    .replace(/<a:p\b[^>]*>/g, '\n')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseDocx(files) {
  const body = files['word/document.xml'];
  if (!body) throw new Error('这个 .docx 里没有正文（可能是加密文件或已损坏）');
  return xmlToText(body.toString('utf8'));
}

function parsePptx(files) {
  const names = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  if (!names.length) throw new Error('这个 .pptx 里没有找到幻灯片');
  return names.map((n, i) => '【第 ' + (i + 1) + ' 页】\n' + xmlToText(files[n].toString('utf8'))).join('\n\n');
}

function parseXlsx(files) {
  const shared = [];
  const ss = files['xl/sharedStrings.xml'];
  if (ss) {
    const xml = ss.toString('utf8');
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) {
      const parts = m[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
      shared.push(xmlToText(parts.join('')).replace(/\n+/g, ' '));
    }
  }
  const sheets = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  if (!sheets.length) throw new Error('这个 .xlsx 里没有工作表');
  return sheets.map((n, si) => {
    const xml = files[n].toString('utf8');
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        let val = '';
        if (/t="s"/.test(attrs)) {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (v) val = shared[parseInt(v[1], 10)] || '';
        } else if (/t="inlineStr"/.test(attrs)) {
          const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
          if (t) val = xmlToText(t[1]);
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (v) val = v[1];
        }
        cells.push(val.replace(/\s+/g, ' ').trim());
      }
      if (cells.some((c) => c)) rows.push(cells.join('\t'));
    }
    return '【工作表 ' + (si + 1) + '】\n' + rows.join('\n');
  }).join('\n\n');
}

async function parsePdf(buf) {
  let mod;
  try { mod = require('pdf-parse'); }
  catch (_) { throw new Error('PDF 需要先安装依赖：在本目录运行 npm i pdf-parse'); }

  let text = '';
  if (mod && typeof mod.PDFParse === 'function') {
    // pdf-parse 2.x：具名类
    const parser = new mod.PDFParse({ data: buf });
    try {
      const r = await parser.getText();
      text = String((r && r.text) || '');
    } finally {
      if (typeof parser.destroy === 'function') { try { await parser.destroy(); } catch (_) {} }
    }
  } else if (typeof mod === 'function') {
    // pdf-parse 1.x：直接是函数
    const r = await mod(buf);
    text = String((r && r.text) || '');
  } else {
    throw new Error('pdf-parse 版本不兼容，请运行 npm i pdf-parse@1');
  }
  return text.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractText(name, buf) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = ext ? ext[1] : '';
  if (e === 'pdf') return parsePdf(buf);
  if (['docx', 'xlsx', 'pptx'].indexOf(e) >= 0) {
    const files = unzip(buf);
    if (e === 'docx') return parseDocx(files);
    if (e === 'pptx') return parsePptx(files);
    return parseXlsx(files);
  }
  if (['doc', 'xls', 'ppt'].indexOf(e) >= 0) {
    throw new Error('旧版 .' + e + ' 格式读不了，请在 Office/WPS 里另存为 .' + e + 'x 再拖进来');
  }
  throw new Error('不支持的文件类型：' + (e || '未知'));
}

async function route(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  if (p.startsWith('/img/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveImage(req, res, u);
  }

  if (p.startsWith('/api/')) {
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (!originAllowed(req)) {
      return sendJson(res, 403, { error: '只允许本机页面调用这个接口' });
    }
  }

  if (p === '/api/llm/health' && req.method === 'GET') {
    const cfg = resolveConfig();
    return sendJson(res, 200, {
      ok: true,
      service: 'swarmsite-gateway',
      version: '1.0.0',
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      hasKey: !!cfg.apiKey,
      keyTail: maskKey(cfg.apiKey),
      keySource: readConf().apiKey ? 'file' : (DEFAULTS.apiKey ? 'env' : (cfg.apiKey ? 'none' : 'none')),
      uptimeSec: Math.round((Date.now() - started) / 1000),
      node: process.version,
      port: server.address() ? server.address().port : null
    });
  }

  if (p === '/api/llm/config' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 64 * 1024); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const baseUrl = body.baseUrl ? normalizeBase(body.baseUrl) : '';
    if (body.baseUrl && !baseUrl) return sendJson(res, 400, { error: 'API 地址不合法' });
    const patch = {};
    if (baseUrl) patch.baseUrl = baseUrl;
    if (body.model) patch.model = String(body.model).trim();
    if (body.apiKey) patch.apiKey = String(body.apiKey).trim();
    const saved = writeConf(patch);
    return sendJson(res, 200, {
      ok: true,
      baseUrl: saved.baseUrl || DEFAULTS.baseUrl,
      model: saved.model || DEFAULTS.model,
      hasKey: !!saved.apiKey,
      keyTail: maskKey(saved.apiKey)
    });
  }

  if (p === '/api/llm/config' && req.method === 'DELETE') {
    const cur = readConf();
    delete cur.apiKey;
    fs.writeFileSync(CONF_FILE, JSON.stringify(cur, null, 2), { mode: 0o600 });
    return sendJson(res, 200, { ok: true, hasKey: false });
  }

  if (p === '/api/img/embed' && req.method === 'POST') {
    return handleImgEmbed(req, res);
  }

  if (p === '/api/img/stats' && req.method === 'GET') {
    let files = 0, bytes = 0;
    try {
      for (const f of fs.readdirSync(IMG_CACHE)) {
        if (!/\.jpg$/.test(f)) continue;
        files++;
        bytes += fs.statSync(path.join(IMG_CACHE, f)).size;
      }
    } catch (_) { /* 缓存目录还没建 */ }
    return sendJson(res, 200, { ok: true, files, bytes, dir: IMG_CACHE, upstream: IMG_UPSTREAM });
  }

  if (p === '/api/llm/chat' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    return handleChat(req, res, body);
  }

  if (p === '/api/llm/extract' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 26 * 1024 * 1024); }
    catch (e) { return sendJson(res, 413, { error: e.message || '文件太大' }); }
    if (!body || !body.data) return sendJson(res, 400, { error: '缺少文件内容' });
    let buf;
    try { buf = Buffer.from(String(body.data), 'base64'); }
    catch (e) { return sendJson(res, 400, { error: '文件内容不是合法 base64' }); }
    if (!buf.length) return sendJson(res, 400, { error: '文件是空的' });
    if (buf.length > 18 * 1024 * 1024) return sendJson(res, 413, { error: '文件太大（上限 18MB）' });
    try {
      let text = await extractText(body.name, buf);
      text = String(text || '').replace(/\r\n/g, '\n').trim();
      if (!text) return sendJson(res, 422, { error: '这个文件里没有可读文字（可能是扫描件或纯图片）' });
      return sendJson(res, 200, { text: text.slice(0, 24000), chars: text.length });
    } catch (e) {
      return sendJson(res, 422, { error: e.message || '解析失败' });
    }
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: '没有这个接口：' + p });

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '只支持 GET' });
  return serveStatic(req, res, p);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { error: '服务出错：' + (e.message || e) });
    else try { res.end(); } catch (_) {}
  });
});

let bannerPrinted = false;
function listen(port, tries) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) {
      console.log('  端口 ' + port + ' 被占用，换 ' + (port + 1));
      setTimeout(() => listen(port + 1, tries - 1), 60);
    } else {
      console.error('启动失败：' + e.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const actual = (server.address() && server.address().port) || port;
    if (bannerPrinted) return;      // 换端口重试时只打一次横幅
    bannerPrinted = true;
    const url = 'http://127.0.0.1:' + actual + '/';
    const cfg = resolveConfig();
    console.log('');
    console.log('  SwarmSite 本机接口已启动');
    console.log('  ───────────────────────────────────────────');
    console.log('  页面地址   ' + url);
    console.log('  上游接口   ' + (cfg.baseUrl || '（未配置）'));
    console.log('  模型       ' + (cfg.model || '（未配置）'));
    console.log('  API Key    ' + (cfg.apiKey ? '已配置 ' + maskKey(cfg.apiKey) : '还没配置 —— 在页面 ⚙ → LLM / 蓝图 里填一次'));
    console.log('  ───────────────────────────────────────────');
    console.log('  请用上面这个地址打开页面（不要再双击 index.html）');
    console.log('  关掉这个窗口或按 Ctrl+C 即停止');
    console.log('');
    if (AUTO_OPEN) openBrowser(url);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'start "" "' + url + '"'
    : process.platform === 'darwin' ? 'open "' + url + '"'
    : 'xdg-open "' + url + '"';
  exec(cmd, () => {});
}

listen(BASE_PORT, 12);
