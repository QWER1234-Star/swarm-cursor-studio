/* 批量编译 inbox/A-html 里的真实模型产出，出结构指纹 + class 合规报告 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const IN = path.join(ROOT, 'inbox', 'A-html');
const APP = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PROMPTS = {
  '01-美甲': '做一个高端美甲店的预约页', '02-AI写作': '做一个 AI 写作工具的落地页',
  '03-瑜伽': '做一个社区瑜伽课的招生页', '04-摄影': '做一个独立摄影师的个人主页',
  '05-咖啡': '做一个精品咖啡店的官网', '06-宠物殡葬': '做一个宠物殡葬服务的介绍页',
  '07-设备租赁': '做一个工业设备租赁的公司页', '08-美甲再跑': '做一个高端美甲店的预约页'
};

// 白名单 class：直接从编译器源码里抽，避免手抄
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'compiler.js'), 'utf8'), ctx);
const C = ctx.window.BlueprintCompiler;
const CSS = C.LAYOUT_CSS;
const ALLOWED = new Set();
(CSS.match(/\.[a-zA-Z][\w-]*/g) || []).forEach((t) => ALLOWED.add(t.slice(1)));

function classesIn(html) {
  const out = new Set();
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) m[1].split(/\s+/).filter(Boolean).forEach((c) => out.add(c));
  return out;
}

(async () => {
  const files = fs.readdirSync(IN).filter((f) => f.endsWith('.html')).sort();
  if (!files.length) { console.log('inbox/A-html 里没有文件'); return; }

  const rows = [];
  console.log('文件'.padEnd(18) + '块数  文字  图 矩形  高    首屏图  居中  非白名单class');
  console.log('-'.repeat(96));

  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 940 });
  await p.goto(APP, { waitUntil: 'load' });
  await sleep(600);

  for (const f of files) {
    const raw = fs.readFileSync(path.join(IN, f), 'utf8');
    const used = classesIn(raw);
    const bad = [...used].filter((c) => !ALLOWED.has(c) && !/^(sr-only)$/.test(c));

    const r = await p.evaluate(async (html) => {
      try {
        const bp = await window.BlueprintCompiler.compile(html);
        const bs = bp.blocks;
        const texts = bs.filter((x) => x.type === 'text');
        const imgs = bs.filter((x) => x.type === 'image');
        const bigImg = imgs.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
        const firstImg = imgs.slice().sort((a, b) => a.y - b.y)[0];
        return {
          ok: true, blocks: bs.length,
          text: texts.length, img: imgs.length, rect: bs.filter((x) => x.type === 'rect').length,
          h: bp.meta.height,
          heroW: firstImg ? firstImg.w : 0,
          fullBleed: !!(firstImg && firstImg.w >= 1050 && firstImg.y < 40),
          centered: texts.filter((x) => x.align === 'center').length,
          actions: bs.filter((x) => x.action).length,
          deps: bs.filter((x) => x.deps && x.deps.length).length,
          types: bs.slice().sort((a, c) => a.y - c.y).map((x) => x.type[0]).join('').slice(0, 14)
        };
      } catch (e) { return { ok: false, err: e.message }; }
    }, raw);

    if (!r.ok) {
      console.log(f.padEnd(18) + '编译失败：' + r.err);
      rows.push({ file: f, ok: false, err: r.err, bad });
      continue;
    }
    console.log(
      f.replace('.html', '').padEnd(18) +
      String(r.blocks).padEnd(6) + String(r.text).padEnd(6) + String(r.img).padEnd(4) +
      String(r.rect).padEnd(6) + String(r.h).padEnd(6) +
      (r.fullBleed ? '整屏' : String(r.heroW) + 'px').padEnd(9) +
      String(r.centered).padEnd(6) +
      (bad.length ? bad.join(',') : '—')
    );
    rows.push({ file: f, ok: true, ...r, bad, types: r.types });

    // 出图
    await p.evaluate((o) => {
      document.querySelector('#llm-mode').value = 'offline';
      document.querySelector('#prompt').value = o.prompt;
      document.querySelector('#blueprint-json').value = o.html;
      document.querySelector('#from-json').click();
    }, { html: raw, prompt: PROMPTS[f.replace('.html', '')] || '一个现代感的产品落地页' });
    await sleep(900);
    for (let i = 0; i < 90; i++) {
      const done = await p.evaluate(() => {
        const e = window.__swarmEngine;
        if (!e) return false;
        if (e.tasks.every((t) => t.state === 'done')) return true;
        e.advance(1400);
        return e.tasks.every((t) => t.state === 'done');
      });
      if (done) break;
      await sleep(40);
    }
    await p.evaluate(() => { const g = document.getElementById('goLive'); if (g) g.click(); });
    await sleep(1600);
    await p.screenshot({ path: path.join(ROOT, 'preview-llm-' + f.replace('.html', '') + '.png') });
  }

  await b.close();
  fs.writeFileSync(path.join(IN, '_report.json'), JSON.stringify(rows, null, 1), 'utf8');

  // 差异分析
  const okRows = rows.filter((r) => r.ok);
  const sigs = new Set(okRows.map((r) => r.types));
  console.log('\n' + '-'.repeat(96));
  console.log('成功编译 ' + okRows.length + '/' + rows.length + ' 份');
  console.log('首屏形态分布：整屏大图 ' + okRows.filter((r) => r.fullBleed).length +
    ' · 分栏 ' + okRows.filter((r) => !r.fullBleed && r.heroW > 0 && r.heroW < 700).length +
    ' · 无图 ' + okRows.filter((r) => r.heroW === 0).length);
  console.log('块数区间：' + Math.min.apply(null, okRows.map((r) => r.blocks)) + ' ~ ' + Math.max.apply(null, okRows.map((r) => r.blocks)));
  console.log('结构签名去重后 ' + sigs.size + ' 种 / 共 ' + okRows.length + ' 份');
  const badClasses = {};
  rows.forEach((r) => (r.bad || []).forEach((c) => { badClasses[c] = (badClasses[c] || 0) + 1; }));
  const topBad = Object.keys(badClasses).sort((a, b2) => badClasses[b2] - badClasses[a]).slice(0, 12);
  console.log('模型最常自创的 class：' + (topBad.length ? topBad.map((c) => c + '(' + badClasses[c] + ')').join(' ') : '无'));
})();
