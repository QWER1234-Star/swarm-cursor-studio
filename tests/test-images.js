/* tests/test-images.js —— 图片代理 / 磁盘缓存 / 内嵌导出
 *
 * 背景：页面里的照片原本直连 images.unsplash.com，批量生成时会被 DNS 抖动
 * 或限流打断，表现为"图没加载出来、只剩渐变兜底"。改成同源代理后这些都要成立：
 *
 *   1. 首次请求回源并把图落盘，第二次直接命中缓存（不再打上游）
 *   2. 并发请求同一张图只回源一次
 *   3. 上游挂掉时，已缓存的照常返回，没缓存的明确 502（浏览器露出渐变兜底）
 *   4. 宽度参数被夹紧到安全范围，非法图片 id 被拒绝
 *   5. 页面里真的用 /img/ 代理地址，图片能解码出像素
 *   6. 导出：勾选内嵌 → 文件里是 base64；不勾 → 还原成公开 CDN 地址
 *   7. 全程零控制台错误
 *
 * 用法：node tests/test-images.js     （需要本机 Edge）
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(__dirname, '.img-cache-test');
const PORT = Number(process.env.IMG_PORT || 5281);
const UPPORT = 18097;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 1×1 的合法 JPEG —— 既验证代理转发，也验证浏览器真的能解码出像素 */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwc' +
  'KDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAA' +
  'AAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

let upHits = 0;
let upMode = 'ok';

function jsonGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(s) }); }
        catch (e) { resolve({ status: res.statusCode, headers: res.headers, text: s }); }
      });
    }).on('error', reject);
  });
}

function fetchImg(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks)
      }));
    }).on('error', reject);
  });
}

const upstream = http.createServer((req, res) => {
  if (req.url === '/hits') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(String(upHits));
  }
  if (upMode === 'down') { res.writeHead(503); return res.end('down'); }
  upHits++;
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length });
  res.end(JPEG);
});

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--no-open'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        SWARM_IMG_BASE: 'http://127.0.0.1:' + UPPORT,
        SWARM_IMG_CACHE: CACHE,
        SWARM_NO_OPEN: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (/已启动/.test(out)) resolve(child);
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => reject(new Error('server 退出 ' + code + ': ' + out)));
    setTimeout(() => reject(new Error('server 启动超时: ' + out)), 12000);
  });
}

const BASE = 'http://127.0.0.1:' + PORT;

(async () => {
  fs.rmSync(CACHE, { recursive: true, force: true });
  await new Promise((r) => upstream.listen(UPPORT, '127.0.0.1', r));
  const server = await startServer();

  try {
    console.log('\n=== 1. 首次回源 + 落盘 ===');
    const r1 = await fetchImg(BASE + '/img/photo-abcdefgh12?w=1200');
    ok('代理返回 200', r1.status === 200, 'status=' + r1.status);
    ok('返回的是图片', /^image\/jpe?g/.test(r1.headers['content-type'] || ''), r1.headers['content-type']);
    ok('首次是回源（miss）', r1.headers['x-img-cache'] === 'miss', r1.headers['x-img-cache']);
    ok('内容与上游一致', r1.buf.equals(JPEG), 'len=' + r1.buf.length);
    ok('缓存文件已落盘', fs.existsSync(path.join(CACHE, 'photo-abcdefgh12@1200.jpg')));

    console.log('\n=== 2. 第二次命中缓存 ===');
    const before = upHits;
    const r2 = await fetchImg(BASE + '/img/photo-abcdefgh12?w=1200');
    ok('第二次命中（hit）', r2.headers['x-img-cache'] === 'hit', r2.headers['x-img-cache']);
    ok('命中时没有再打上游', upHits === before, 'upstream ' + before + ' → ' + upHits);
    ok('长缓存头存在', /immutable/.test(r2.headers['cache-control'] || ''), r2.headers['cache-control']);

    console.log('\n=== 3. 参数安全 ===');
    await fetchImg(BASE + '/img/photo-bigwidth999?w=99999');
    ok('超大宽度被夹到 2000', fs.existsSync(path.join(CACHE, 'photo-bigwidth999@2000.jpg')));
    const bad = await jsonGet(BASE + '/img/%2E%2E%2Fsecret');
    ok('非法图片 id 被拒绝', bad.status === 400, 'status=' + bad.status);
    const noId = await jsonGet(BASE + '/img/');
    ok('空 id 被拒绝', noId.status === 400, 'status=' + noId.status);
    const head = await new Promise((resolve) => {
      const req = http.request(BASE + '/img/photo-abcdefgh12?w=1200', { method: 'HEAD' }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.end();
    });
    ok('HEAD 请求可用', head === 200, 'status=' + head);

    console.log('\n=== 4. 并发只回源一次 ===');
    upHits = 0;
    const burst = await Promise.all(
      Array.from({ length: 5 }, () => fetchImg(BASE + '/img/photo-concurrent1?w=900'))
    );
    ok('5 个并发都成功', burst.every((x) => x.status === 200), burst.map((x) => x.status).join(','));
    ok('上游只被打了 1 次', upHits === 1, 'hits=' + upHits);

    console.log('\n=== 5. 上游挂掉时的韧性 ===');
    upMode = 'down';
    const cached = await fetchImg(BASE + '/img/photo-abcdefgh12?w=1200');
    ok('已缓存的图在上游挂掉时仍可返回', cached.status === 200 && cached.buf.length > 0, 'status=' + cached.status);
    const fresh = await jsonGet(BASE + '/img/photo-neverseen1?w=1200');
    ok('没缓存的图明确报 502（前端会露渐变，不会裂图）', fresh.status === 502, 'status=' + fresh.status);
    ok('502 带可读原因', /取图失败/.test((fresh.json && fresh.json.error) || ''), JSON.stringify(fresh.json));
    upMode = 'ok';

    console.log('\n=== 6. 内嵌导出接口 ===');
    const emb = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ items: [{ id: 'photo-abcdefgh12', w: 1200 }, { id: 'bad', w: 100 }] });
      const req = http.request(BASE + '/api/img/embed', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) }));
      });
      req.on('error', reject);
      req.end(body);
    });
    const img0 = (emb.json.images || [])[0] || {};
    const img1 = (emb.json.images || [])[1] || {};
    ok('内嵌接口返回 data URL', /^data:image\/jpeg;base64,/.test(img0.dataUrl || ''), String(img0.dataUrl || '').slice(0, 30));
    ok('非法 id 单独报错、不影响其他图', !!img1.error && !!img0.dataUrl, JSON.stringify(img1));

    console.log('\n=== 7. 浏览器：页面真的走代理 ===');
    const browser = await puppeteer.launch({
      executablePath: EDGE, headless: 'new',
      args: ['--no-sandbox', '--allow-file-access-from-files']
    });
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console:' + m.text());
    });
    await p.goto(BASE + '/', { waitUntil: 'load' });
    await sleep(800);

    const proxyOn = await p.evaluate(() => window.__SWARM_IMG_PROXY === true);
    ok('页面识别到本机接口 → 启用图片代理', proxyOn);

    await p.evaluate(() => {
      document.querySelector('#llm-mode').value = 'offline';
      document.querySelector('#prompt').value = '做一个高端美甲店的预约页';
      document.querySelector('#build').click();
    });
    await sleep(1000);

    const dom = await p.evaluate(() => {
      const fills = [].slice.call(document.querySelectorAll('#page .imgfill'));
      const urls = fills.map((f) => getComputedStyle(f).backgroundImage).join(' ');
      return {
        fills: fills.length,
        proxied: (urls.match(/\/img\/photo-/g) || []).length,
        cdn: (urls.match(/images\.unsplash\.com/g) || []).length,
        gradient: (urls.match(/linear-gradient/g) || []).length,
        sample: urls.slice(0, 90)
      };
    });
    ok('渲染出的图片块用了代理地址', dom.proxied >= 3, JSON.stringify(dom));
    ok('代理模式下不再直连 CDN', dom.cdn === 0, 'cdn=' + dom.cdn);
    ok('每张图都带了渐变兜底', dom.gradient >= dom.proxied, 'gradient=' + dom.gradient);

    const decoded = await p.evaluate(() => new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => resolve({ w: 0, h: 0 });
      im.src = '/img/photo-abcdefgh12?w=1200';
    }));
    ok('浏览器能把代理图解码成真实像素', decoded.w > 0 && decoded.h > 0, JSON.stringify(decoded));

    console.log('\n=== 8. 导出：内嵌 / 外链 ===');
    const expEmbed = await p.evaluate(async () => {
      const box = document.querySelector('#exp-embed');
      if (box) box.checked = true;
      document.querySelector('#exp-html').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const h = window.__lastExport && window.__lastExport.html;
        if (h && /data:image\/jpeg;base64|images\.unsplash\.com/.test(h)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const html = (window.__lastExport || {}).html || '';
      return {
        size: html.length,
        dataUrls: (html.match(/data:image\/jpeg;base64/g) || []).length,
        proxied: (html.match(/\/img\/photo-/g) || []).length,
        cdn: (html.match(/images\.unsplash\.com/g) || []).length
      };
    });
    ok('勾选内嵌后文件里有 base64 图片', expEmbed.dataUrls >= 3, JSON.stringify(expEmbed));
    ok('内嵌后文件里不再有本机代理路径', expEmbed.proxied === 0, 'proxied=' + expEmbed.proxied);
    ok('内嵌后文件也不依赖外链 CDN', expEmbed.cdn === 0, 'cdn=' + expEmbed.cdn);

    const expLink = await p.evaluate(async () => {
      const box = document.querySelector('#exp-embed');
      if (box) box.checked = false;
      window.__lastExport = null;
      document.querySelector('#exp-html').click();
      await new Promise((r) => setTimeout(r, 600));
      const html = (window.__lastExport || {}).html || '';
      return {
        size: html.length,
        dataUrls: (html.match(/data:image\/jpeg;base64/g) || []).length,
        proxied: (html.match(/\/img\/photo-/g) || []).length,
        cdn: (html.match(/images\.unsplash\.com/g) || []).length
      };
    });
    ok('不勾内嵌时还原成公开 CDN 地址', expLink.cdn >= 3, JSON.stringify(expLink));
    ok('不勾内嵌时文件里没有本机代理路径', expLink.proxied === 0, 'proxied=' + expLink.proxied);
    ok('不勾内嵌时文件更小', expLink.size < expEmbed.size, expLink.size + ' < ' + expEmbed.size);

    console.log('\n=== 9. 双击打开（file://）不用代理 ===');
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1440, height: 900 });
    await p2.goto('file:///' + ROOT.replace(/\\/g, '/') + '/index.html', { waitUntil: 'load' });
    await sleep(700);
    const fileMode = await p2.evaluate(() => {
      document.querySelector('#llm-mode').value = 'offline';
      document.querySelector('#prompt').value = '做一个精品咖啡店的官网';
      document.querySelector('#build').click();
      return window.__SWARM_IMG_PROXY;
    });
    await sleep(900);
    const fileImgs = await p2.evaluate(() => {
      const fills = [].slice.call(document.querySelectorAll('#page .imgfill'));
      const urls = fills.map((f) => getComputedStyle(f).backgroundImage).join(' ');
      return {
        cdn: (urls.match(/images\.unsplash\.com/g) || []).length,
        proxied: (urls.match(/\/img\/photo-/g) || []).length
      };
    });
    ok('file:// 下不开代理', fileMode === false, 'flag=' + fileMode);
    ok('file:// 下退回直连 CDN', fileImgs.cdn >= 3 && fileImgs.proxied === 0, JSON.stringify(fileImgs));

    ok('全程无运行时错误', errs.length === 0, errs.join(' | '));

    await browser.close();
  } finally {
    server.kill();
    upstream.close();
    fs.rmSync(CACHE, { recursive: true, force: true });
  }

  console.log('\n通过 ' + pass + '，失败 ' + fail);
  if (fail) { console.log('失败清单：\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  try { upstream.close(); } catch (_) {}
  process.exit(2);
});
