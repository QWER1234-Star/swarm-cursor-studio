/* tests/test-files.js —— 文件输入框 + 文档解析全链路
 *
 * 覆盖：
 *   1. 输入框结构（多行 textarea / 附件按钮 / 文件列表）
 *   2. 文本文件：前端直读，卡片显示字数
 *   3. 图片文件：前端压缩，缩略图，开工后进入蓝图
 *   4. 文档：POST /api/llm/extract 解析 docx / xlsx / pptx / pdf
 *   5. 错误路径：旧版 Office、不支持类型、空文件、超大文件
 *   6. 拖拽 / 粘贴 / 移除 / Enter 与 Shift+Enter
 *   7. 零运行时错误
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const CONF = path.join(__dirname, '.files-test.json');
const PORT = Number(process.env.FILES_PORT || 5281);
const BASE = 'http://127.0.0.1:' + PORT + '/';
const TMP = path.join(__dirname, '.tmp-files');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 造测试文件（不依赖系统 Office） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function buildZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const names = Object.keys(entries);
  for (const name of names) {
    const data = Buffer.from(entries[name], 'utf8');
    const nb = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8); eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function makeDocx() {
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
      '<w:p><w:r><w:t>巷子里的小店 品牌资料</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>日式美甲 198 元，手部护理 88 元。</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>电话 138-0000-0000，微信 nailhouse。</w:t></w:r></w:p>' +
      '</w:body></w:document>'
  });
}
function makeXlsx() {
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst count="6" uniqueCount="6">' +
      '<si><t>项目</t></si><si><t>价格</t></si><si><t>日式美甲</t></si><si><t>198</t></si><si><t>手部护理</t></si><si><t>88</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="s"><v>5</v></c></row>' +
      '</sheetData></worksheet>'
  });
}
function makePptx() {
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
    'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>' +
      '<a:p><a:r><a:t>社区瑜伽课招生</a:t></a:r></a:p><a:p><a:r><a:t>每周三晚 19:30，小班 8 人</a:t></a:r></a:p>' +
      '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide2.xml': '<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>' +
      '<a:p><a:r><a:t>首月体验价 199 元</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  });
}
function makePdf() {
  const content = 'BT /F1 20 Tf 72 720 Td (Nail Studio Price List) Tj 0 -32 Td /F1 13 Tf (Manicure 198 RMB) Tj ET';
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    '<</Length ' + Buffer.byteLength(content, 'latin1') + '>>stream\n' + content + '\nendstream',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
  ];
  let pdf = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xs = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offs.forEach((o) => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += 'trailer\n<</Size ' + (objs.length + 1) + '/Root 1 0 R>>\nstartxref\n' + xs + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}

/* ---------------- HTTP 小工具 ---------------- */
function postJson(p, body, timeout) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(out); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: out });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout || 20000, () => { req.destroy(new Error('timeout')); });
    req.end(data);
  });
}
const extract = (name, buf) => postJson('/api/llm/extract', { name, data: buf.toString('base64') });

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--no-open'], {
      env: { ...process.env, PORT: String(PORT), SWARM_LLM_CONF: CONF },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (/已启动/.test(out)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => reject(new Error('server exited ' + code + ': ' + out)));
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 12000);
  });
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const txtFile = path.join(TMP, '品牌资料.txt');
  fs.writeFileSync(txtFile, '店名：巷子里的小店\n主打：日式美甲、手部护理\n营业时间：10:00-20:00\n预约电话：138-0000-0000\n微信号：nailhouse', 'utf8');
  const pngFile = path.join(TMP, 'cover.png');
  fs.copyFileSync(path.join(__dirname, 'fixtures-photo.png'), pngFile);

  let server;
  try {
    server = await startServer();
    console.log('  (本机接口已启动 :' + PORT + ')');

    console.log('\n=== 1. 文档解析接口 ===');
    const r1 = await extract('品牌资料.docx', makeDocx());
    ok('docx 能解析出正文', r1.status === 200 && /巷子里的小店/.test(r1.body.text), JSON.stringify(r1.body).slice(0, 120));
    ok('docx 段落保留换行', r1.status === 200 && /\n/.test(r1.body.text), r1.body && r1.body.text);

    const r2 = await extract('价格表.xlsx', makeXlsx());
    ok('xlsx 能解析出表格', r2.status === 200 && /日式美甲/.test(r2.body.text) && /198/.test(r2.body.text), JSON.stringify(r2.body).slice(0, 140));
    ok('xlsx 保留列结构（制表符）', r2.status === 200 && /\t/.test(r2.body.text), r2.body && r2.body.text);

    const r3 = await extract('招生.pptx', makePptx());
    ok('pptx 能解析出两页文字', r3.status === 200 && /社区瑜伽课招生/.test(r3.body.text) && /199/.test(r3.body.text), JSON.stringify(r3.body).slice(0, 140));
    ok('pptx 带页码标记', r3.status === 200 && /第 1 页/.test(r3.body.text), r3.body && r3.body.text);

    const r4 = await extract('价格表.pdf', makePdf());
    ok('pdf 能解析出文字', r4.status === 200 && /Nail Studio Price List/.test(r4.body.text || ''), JSON.stringify(r4.body).slice(0, 140));

    const r5 = await extract('旧格式.doc', Buffer.from('not a zip'));
    ok('旧版 .doc 给出另存为提示', r5.status === 422 && /另存为/.test(r5.body.error), JSON.stringify(r5.body));
    const r6 = await extract('文件.xyz', Buffer.from('hello'));
    ok('不支持的格式有明确提示', r6.status === 422 && /不支持/.test(r6.body.error), JSON.stringify(r6.body));
    const r7 = await extract('空.docx', Buffer.alloc(0));
    ok('空文件被拒', r7.status === 400, JSON.stringify(r7.body));
    const r8 = await postJson('/api/llm/extract', { name: 'a.docx' });
    ok('缺文件内容被拒', r8.status === 400, JSON.stringify(r8.body));

    console.log('\n=== 2. 输入框结构 ===');
    const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'] });
    const p = await b.newPage();
    await p.setViewport({ width: 1440, height: 940 });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });

    await p.goto(BASE, { waitUntil: 'load' });
    await sleep(700);

    const shape = await p.evaluate(() => ({
      isTextarea: document.querySelector('#prompt').tagName === 'TEXTAREA',
      attach: !!document.querySelector('#attach'),
      input: !!document.querySelector('#file-input'),
      hidden: document.querySelector('#file-list').hidden
    }));
    ok('输入框是多行 textarea', shape.isTextarea);
    ok('有附件按钮和文件选择器', shape.attach && shape.input);
    ok('文件列表默认隐藏', shape.hidden);

    console.log('\n=== 3. 文本文件与图片 ===');
    let inp = await p.$('#file-input');
    await inp.uploadFile(txtFile);
    await sleep(700);
    const c1 = await p.evaluate(() => {
      const chips = [].slice.call(document.querySelectorAll('.file-chip'));
      return { n: chips.length, text: chips.map((c) => c.textContent).join('|'), shown: !document.querySelector('#file-list').hidden };
    });
    ok('文本文件生成卡片', c1.n === 1, c1.text);
    ok('卡片显示读到的字数', /\d+\s*字/.test(c1.text), c1.text);
    ok('文件列表展开', c1.shown);

    inp = await p.$('#file-input');
    await inp.uploadFile(pngFile);
    await sleep(1200);
    const c2 = await p.evaluate(() => {
      const chips = [].slice.call(document.querySelectorAll('.file-chip'));
      const im = chips.map((c) => c.querySelector('img')).filter((i) => i && /^data:image/.test(i.src))[0];
      return { n: chips.length, thumbLen: im ? im.src.length : 0, delVisible: !!document.querySelector('.file-chip .chip-x') && document.querySelector('.file-chip .chip-x').getBoundingClientRect().width > 0 };
    });
    ok('图片卡片带 data: 缩略图', c2.thumbLen > 0);
    ok('图片被压缩到合理体积', c2.thumbLen > 1000 && c2.thumbLen < 900000, 'base64=' + c2.thumbLen);
    ok('移除按钮真的可见（不与特效层撞类名）', c2.delVisible);

    await p.evaluate(() => document.querySelector('.file-chip .chip-x').click());
    await sleep(250);
    ok('点 × 能移除文件', (await p.evaluate(() => document.querySelectorAll('.file-chip').length)) === 1);

    console.log('\n=== 4. 开工后图片进蓝图 ===');
    await p.evaluate(() => {
      document.querySelector('#llm-mode').value = 'offline';
      document.querySelector('#prompt').value = '做一个美甲店的预约页';
    });
    await p.click('#build');
    await sleep(500);
    for (let i = 0; i < 90; i++) {
      const done = await p.evaluate(() => {
        const e = window.__swarmEngine;
        if (!e) return false;
        if (e.tasks.every((t) => t.state === 'done')) return true;
        e.advance(1200);
        return e.tasks.every((t) => t.state === 'done');
      });
      if (done) break;
      await sleep(60);
    }
    await p.evaluate(() => { const g = document.getElementById('goLive'); if (g) g.click(); });
    await sleep(1400);
    const t4 = await p.evaluate(() => {
      const fills = [].slice.call(document.querySelectorAll('#page .blk.image .imgfill'));
      return {
        total: fills.length,
        dataOnes: fills.filter((f) => /data:image/.test(getComputedStyle(f).backgroundImage)).length,
        // 走本机接口时是 /img/photo-… 代理地址，双击打开时是 images.unsplash.com 直链
        urlOnes: fills.filter((f) => /images\.unsplash\.com|\/img\/photo-/.test(getComputedStyle(f).backgroundImage)).length
      };
    });
    ok('图片块渲染出来了', t4.total >= 2, JSON.stringify(t4));
    ok('上传的图被用在最大的图片块上', t4.dataOnes >= 1, JSON.stringify(t4));
    ok('其余图片块用内置照片', t4.urlOnes >= 1, JSON.stringify(t4));

    console.log('\n=== 5. 拖拽 / 粘贴 / 键盘 ===');
    const before = await p.evaluate(() => document.querySelectorAll('.file-chip').length);
    await p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['拖进来的内容'], 'drag.txt', { type: 'text/plain' }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await sleep(700);
    const afterDrop = await p.evaluate(() => document.querySelectorAll('.file-chip').length);
    ok('拖拽文件能被接收', afterDrop > before, before + ' -> ' + afterDrop);

    await p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['粘贴的内容'], 'paste.txt', { type: 'text/plain' }));
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(700);
    const afterPaste = await p.evaluate(() => document.querySelectorAll('.file-chip').length);
    ok('粘贴文件能被接收', afterPaste > afterDrop, afterDrop + ' -> ' + afterPaste);

    await p.evaluate(() => {
      window.__hits = 0;
      const o = document.querySelector('#build');
      o.click = function () { window.__hits++; };
      document.querySelector('#prompt').focus();
    });
    await p.keyboard.press('Enter');
    await sleep(200);
    ok('Enter 触发开工', (await p.evaluate(() => window.__hits)) === 1);
    await p.keyboard.down('Shift');
    await p.keyboard.press('Enter');
    await p.keyboard.up('Shift');
    await sleep(150);
    ok('Shift+Enter 换行不误触', (await p.evaluate(() => window.__hits)) === 1);

    ok('全程无运行时错误', errs.length === 0, errs.slice(0, 3).join(' | '));
    await b.close();
  } finally {
    if (server) try { server.kill(); } catch (_) {}
    try { fs.unlinkSync(CONF); } catch (_) {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n通过 ' + pass + '，失败 ' + fail);
  if (fail) console.log('失败清单：' + fails.join('；'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
