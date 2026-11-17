const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const APP = 'file:///' + ROOT.split('\\').join('/') + '/index.html';
const DL = path.join(__dirname, 'dl');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
async function buildToEnd(page) {
  await page.click('#build');
  await page.waitForFunction(() => window.__swarmEngine && window.__swarmEngine.tasks.length > 0, { timeout: 8000 });
  for (let i = 0; i < 60; i++) {
    const done = await page.evaluate(() => {
      const e = window.__swarmEngine;
      if (!e) return true;
      if (e.tasks.every(t => t.state === 'done')) return true;
      e.advance(1500);
      return e.tasks.every(t => t.state === 'done');
    });
    if (done) break;
    await sleep(60);
  }
  await sleep(300);
}

(async () => {
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-web-security']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const errors = [];
  // 只认脚本运行时错误。外链图片加载失败（net::ERR_*）是网络环境问题，
  // 不是代码 bug —— 图片层本身有渐变兜底，另有 test-images.js 专门验证稳定性。
  const netNoise = /Failed to load resource|net::ERR_/;
  page.on('console', m => { if (m.type() === 'error' && !netNoise.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));

  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  let bc = null;
  try {
    bc = await browser.target().createCDPSession();
    await bc.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  } catch (e) { console.log('  (Browser.setDownloadBehavior 不可用，改用内存副本校验)'); }

  console.log('\n=== 1. 载入与基础结构 ===');
  await page.goto(APP, { waitUntil: 'load' });
  const base = await page.evaluate(() => ({
    render: typeof window.SwarmRender,
    engine: typeof window.SwarmEngine,
    gen: typeof window.BlueprintGen,
    staticHTML: typeof window.SwarmRender.staticHTML,
    themes: Object.keys(window.SwarmEngine.THEMES || {}),
    scenes: Object.keys(window.BlueprintGen.SCENES).length,
    fields: document.querySelectorAll('#edit-fields [data-field]').length
  }));
  ok('三个模块都挂上了', base.render === 'object' && base.engine === 'function' && base.gen === 'object', JSON.stringify(base));
  ok('render 暴露 staticHTML', base.staticHTML === 'function');
  ok('内置 4 套施工主题', base.themes.length === 4, base.themes.join(','));
  ok('场景数 >= 12', base.scenes >= 12, 'scenes=' + base.scenes);
  ok('编辑面板字段已渲染', base.fields === 24, 'fields=' + base.fields);

  console.log('\n=== 2. 离线生成 + 完整施工 ===');
  await buildToEnd(page);
  const afterBuild = await page.evaluate(() => {
    const e = window.__swarmEngine;
    const els = [].slice.call(document.querySelectorAll('#page .blk'));
    return {
      blocks: els.length,
      pending: els.filter(x => x.classList.contains('pending')).length,
      rough: els.filter(x => x.classList.contains('rough')).length,
      typed: els.filter(x => x.textContent.trim().length > 0).length,
      done: e ? e.tasks.filter(t => t.state === 'done').length : -1,
      total: e ? e.tasks.length : -1,
      hud: (document.querySelector('.shud') || {}).textContent || '',
      goLive: getComputedStyle(document.querySelector('#goLive')).display !== 'none',
      interactive: document.querySelectorAll('#page [data-interactive]').length
    };
  });
  ok('块已全部渲染', afterBuild.blocks > 40, 'blocks=' + afterBuild.blocks);
  ok('没有残留 pending', afterBuild.pending === 0, 'pending=' + afterBuild.pending);
  ok('没有残留骨架态', afterBuild.rough === 0, 'rough=' + afterBuild.rough);
  ok('文字都被"打"出来了', afterBuild.typed > 30, 'typed=' + afterBuild.typed);
  ok('引擎任务全部完成', afterBuild.done === afterBuild.total && afterBuild.total > 0, afterBuild.done + '/' + afterBuild.total);
  ok('HUD 显示完成信息', /完成 \d+ 块/.test(afterBuild.hud), afterBuild.hud);
  ok('完成后出现「进入网站」', afterBuild.goLive);
  ok('可点块被识别', afterBuild.interactive >= 8, 'interactive=' + afterBuild.interactive);

  console.log('\n=== 3. 边建边点 ===');
  await page.click('#replay');
  await page.waitForFunction(() => window.__swarmEngine && window.__swarmEngine.running, { timeout: 8000 });
  await page.evaluate(() => window.__swarmEngine.advance(400));
  await sleep(150);
  for (let i = 0; i < 30; i++) {
    const st = await page.evaluate(() => {
      window.__swarmEngine.advance(450);
      const nav = [].slice.call(document.querySelectorAll('#page [data-role="nav"]')).filter(x => !x.classList.contains('pending'))[0];
      return { nav: !!nav, done: window.__swarmEngine.doneCount, total: window.__swarmEngine.tasks.length };
    });
    if (st.done >= 10 || st.done >= st.total) break;
    await sleep(30);
  }
  const mid = await page.evaluate(() => {
    document.querySelector('#stage').scrollTop = 0;
    const els = [].slice.call(document.querySelectorAll('#page .blk'));
    const ready = els.filter(x => !x.classList.contains('pending') && x.hasAttribute('data-interactive'));
    const pending = els.filter(x => x.classList.contains('pending') && x.hasAttribute('data-interactive'));
    const r = ready[0] ? getComputedStyle(ready[0]).pointerEvents : 'none';
    const p = pending[0] ? getComputedStyle(pending[0]).pointerEvents : 'none';
    const allNavs = els.filter(x => x.getAttribute('data-role') === 'nav');
    const nav = allNavs.filter(x => !x.classList.contains('pending'))[0];
    return {
      done: window.__swarmEngine.doneCount, total: els.length,
      readyCount: ready.length, readyPE: r, pendingPE: p,
      navs: allNavs.length, navsReady: allNavs.filter(x => !x.classList.contains('pending')).length,
      navText: nav ? (nav.getAttribute('data-text') || nav.textContent || '(空)') : null,
      navBox: nav ? (() => { const b = nav.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })() : null,
      scrollTop: document.querySelector('#stage').scrollTop
    };
  });
  ok('施工中途已有块完成', mid.done > 3 && mid.done < mid.total, mid.done + '/' + mid.total);
  ok('已完成块可点（pointer-events:auto）', mid.readyPE === 'auto', mid.readyPE);
  ok('未完成块不吃点击', mid.pendingPE === 'none', mid.pendingPE);
  ok('找到可点的导航项', !!mid.navText, String(mid.navText));
  if (mid.navBox) {
    await page.mouse.click(mid.navBox.x, mid.navBox.y);
    await sleep(700);
    const afterClick = await page.evaluate(() => ({
      hold: window.__swarmEngine.userHoldUntil - window.__swarmEngine.time,
      scrollTop: document.querySelector('#stage').scrollTop
    }));
    ok('施工中点导航会暂停镜头跟随', afterClick.hold > 1, 'hold=' + afterClick.hold.toFixed(2));
    ok('施工中点击真的滚动了', afterClick.scrollTop !== mid.scrollTop, mid.scrollTop + ' -> ' + afterClick.scrollTop);
  } else { ok('施工中点导航会暂停镜头跟随', false, 'no nav'); ok('施工中点击真的滚动了', false, 'no nav'); }

  console.log('\n=== 4. 进入网站后的真实交互 ===');
  await page.evaluate(() => document.getElementById('goLive').click());
  await sleep(1200);
  const live = await page.evaluate(() => ({ scrollTop: document.querySelector('#stage').scrollTop, hud: !!document.querySelector('.shud') }));
  ok('进入网站后回到首屏', live.scrollTop === 0, 'scrollTop=' + live.scrollTop);
  ok('进入网站后 HUD 已清理', live.hud === false);

  const navBox2 = await page.evaluate(() => {
    const nav = [].slice.call(document.querySelectorAll('#page [data-role="nav"]'))[1];
    const b = nav.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, t: nav.getAttribute('data-text') };
  });
  await page.mouse.click(navBox2.x, navBox2.y);
  await sleep(900);
  const afterNav = await page.evaluate(() => ({ top: document.querySelector('#stage').scrollTop, on: document.querySelectorAll('#page [data-role="nav"].on').length }));
  ok('导航点击滚动到区块', afterNav.top > 100, '“' + navBox2.t + '” -> scrollTop=' + afterNav.top);
  ok('导航高亮跟随', afterNav.on === 1, 'on=' + afterNav.on);

  const cardBox = await page.evaluate(() => {
    const c = document.querySelector('#page [data-role="card"]');
    const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await page.evaluate(() => {
    const c = document.querySelector('#page [data-role="card"]');
    c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(1000);
  const afterCard = await page.evaluate(() => ({ top: document.querySelector('#stage').scrollTop, pulse: document.querySelectorAll('#page .blk.pulse').length }));
  ok('点卡片引到报名区', afterCard.top > 500, 'scrollTop=' + afterCard.top);
  ok('报名按钮脉冲提示', afterCard.pulse >= 1, 'pulse=' + afterCard.pulse);

  const kb = await page.evaluate(() => {
    const nav = document.querySelector('#page [data-role="nav"]');
    nav.focus();
    const focused = document.activeElement === nav;
    nav.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return focused;
  });
  await sleep(600);
  ok('导航可键盘聚焦并回车触发', kb);

  console.log('\n=== 5. 按钮行为（未填 / 已填） ===');
  await page.evaluate(() => {
    const btn = document.querySelector('#page [data-role="action"]');
    btn.setAttribute('data-action-value', '');
    btn.click();
  });
  await sleep(200);
  const t1 = await page.evaluate(() => (document.getElementById('__swarm_toast') || {}).textContent || '');
  ok('没填微信号时给出可操作提示', /还没填微信号/.test(t1), t1);

  await page.evaluate(() => {
    document.querySelector('#cta-value').value = 'swarm_demo01';
    document.querySelector('#cta-action').value = 'wechat';
    document.querySelector('#apply-edit').click();
  });
  await sleep(400);
  await buildToEnd2(page);
  await page.evaluate(() => document.getElementById('goLive').click());
  await sleep(1000);
  await page.evaluate(() => document.querySelector('#page [data-role="action"]').click());
  await sleep(400);
  const t2 = await page.evaluate(() => (document.getElementById('__swarm_toast') || {}).textContent || '');
  ok('填了微信号后点击执行复制', /微信号已复制：swarm_demo01/.test(t2), t2);

  async function buildToEnd2(p) {
    for (let i = 0; i < 60; i++) {
      const done = await p.evaluate(() => {
        const e = window.__swarmEngine;
        if (!e) return true;
        if (e.tasks.every(t => t.state === 'done')) return true;
        e.advance(1500);
        return e.tasks.every(t => t.state === 'done');
      });
      if (done) break;
      await sleep(60);
    }
    await sleep(200);
  }

  console.log('\n=== 6. 主题切换 ===');
  const beforeTheme = await page.evaluate(() => getComputedStyle(document.querySelector('#stage')).backgroundColor);
  await page.select('#theme', 'neon');
  await sleep(700);
  const themeState = await page.evaluate(() => ({
    attr: document.body.getAttribute('data-theme'),
    bg: getComputedStyle(document.querySelector('#stage')).backgroundColor,
    colors: window.__swarmEngine ? window.__swarmEngine.colors.slice(0, 2) : null,
    blocks: document.querySelectorAll('#page .blk').length
  }));
  ok('主题属性切到 neon', themeState.attr === 'neon', themeState.attr);
  ok('舞台底色随主题变化', themeState.bg !== beforeTheme, beforeTheme + ' -> ' + themeState.bg);
  ok('光标配色随主题变化', themeState.colors && themeState.colors[0] === '#FF3BD4', JSON.stringify(themeState.colors));
  ok('换主题后页面仍完整', themeState.blocks > 40, 'blocks=' + themeState.blocks);

  console.log('\n=== 7. LLM：提示词与容错修复 ===');
  const promptInfo = await page.evaluate(() => {
    const t = window.BlueprintGen.buildPrompt('做一个美甲店的预约页', { brand: '小满', contact: '微信 xm01' });
    return { len: t.length, hasJson: t.indexOf('"blocks"') > 0, hasOnlyJson: t.indexOf('只输出一个 JSON') >= 0, hasAsk: t.indexOf('美甲店') > 0, hasBrand: t.indexOf('小满') > 0 };
  });
  ok('提示词包含结构骨架', promptInfo.hasJson && promptInfo.hasOnlyJson, JSON.stringify(promptInfo));
  ok('提示词带上了用户需求与品牌', promptInfo.hasAsk && promptInfo.hasBrand);

  const repairCases = await page.evaluate(() => {
    const R = window.BlueprintGen.repair;
    const out = [];
    // a) 代码围栏 + 前后废话
    const a = R('好的，这是蓝图：\n```json\n{"meta":{"title":"X"},"blocks":[{"id":"b1","type":"text","x":80,"y":40,"w":300,"h":40,"text":"你好"}]}\n```\n希望有帮助！');
    out.push(['围栏+废话', !a.error && a.blueprint.blocks.length === 1, a.error || '']);
    // b) 缺 meta / 缺 y / 未知类型 / 重复 id
    const b = R({blocks:[
      {id:'a', type:'heading', x:80, w:300, text:'标题'},
      {id:'a', type:'paragraph', x:80, w:600, text:'正文正文'},
      {id:'c', type:'button', x:80, y:200, w:190, h:56, action:'wechat', actionValue:'wx'},
      {id:'d', type:'whatever', x:80, y:300, w:100, h:100}
    ]});
    out.push(['缺字段+冲突', !b.error && b.blueprint.blocks.length === 4 && b.blueprint.meta.width === 1200, b.error || '']);
    const ids = b.error ? [] : b.blueprint.blocks.map(x => x.id);
    out.push(['id 唯一', new Set(ids).size === ids.length, ids.join(',')]);
    const acts = b.error ? [] : b.blueprint.blocks.filter(x => x.action);
    out.push(['动作被保留', acts.length === 1 && acts[0].action === 'wechat', JSON.stringify(acts.map(x => x.action))]);
    // c) 全 0 坐标 → 自动堆叠
    const c = R({blocks:[{id:'1',type:'text',x:0,y:0,w:200,h:30,text:'a'},{id:'2',type:'text',x:0,y:0,w:200,h:30,text:'b'},{id:'3',type:'text',x:0,y:0,w:200,h:30,text:'c'},{id:'4',type:'text',x:0,y:0,w:200,h:30,text:'d'}]});
    const ys = c.error ? [] : c.blueprint.blocks.map(x => x.y);
    out.push(['y 重叠被拆开', !c.error && new Set(ys).size === ys.length, ys.join(',')]);
    // d) 尾逗号
    const d = R('{"meta":{},"blocks":[{"id":"x","type":"rect","x":1,"y":1,"w":10,"h":10},]}');
    out.push(['尾逗号能救', !d.error && d.blueprint.blocks.length === 1, d.error || '']);
    // e) 包了一层
    const e = R({site:{blocks:[{id:'z',type:'rect',x:0,y:0,w:10,h:10}]}});
    out.push(['外层包装能剥', !e.error && e.blueprint.blocks.length === 1, e.error || '']);
    // f) 完全不是蓝图
    const f = R('今天天气不错');
    out.push(['无关内容给出明确错误', !!f.error, f.error || '']);
    return out;
  });
  repairCases.forEach(([n, cond, extra]) => ok('修复：' + n, cond, extra));

  // 用一段"脏" JSON 走完整建站流程
  await page.evaluate(() => {
    document.querySelector('#tab-llm').click();
    const bad = '```json\n{"meta":{"title":"脏数据测试","bg":"#101820"},\n"blocks":[\n' +
      '{"id":"t1","type":"heading","x":80,"y":40,"w":400,"h":44,"style":{"font_size":30,"color":"#fff"},"text":"光标建出来的站"},\n' +
      '{"id":"t1","type":"paragraph","x":80,"y":110,"w":600,"h":70,"style":{"fontSize":"15px","color":"#9ab"},"text":"这段是 LLM 乱写也能用的证明。"},\n' +
      '{"id":"btn","type":"button","x":80,"y":210,"w":190,"h":56,"style":{"background":"#1f6feb","border_radius":"8px"},"action":"wechat","label":"button"},\n' +
      '{"id":"nav1","type":"text","x":800,"y":44,"w":90,"h":26,"text":"关于","label":"nav link"},\n' +
      '{"id":"nav2","type":"text","x":900,"y":44,"w":90,"h":26,"text":"联系","label":"nav link"},\n' +
      '{"id":"sec","type":"heading","x":80,"y":320,"w":500,"h":40,"text":"为什么值得"}' +
      ']}\n```';
    document.querySelector('#blueprint-json').value = bad;
    document.querySelector('#blueprint-json').dispatchEvent(new Event('input'));
  });
  await page.evaluate(() => document.querySelector('#from-json').click());
  await sleep(400);
  const badBuild = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    blocks: document.querySelectorAll('#page .blk').length,
    editing: document.querySelectorAll('#edit-fields [data-field=title1]').length
      ? document.querySelector('#edit-fields [data-field=title1]').value : '',
    binds: document.querySelectorAll('#page [data-bind]').length
  }));
  ok('脏 JSON 也能建站', badBuild.blocks >= 6, 'blocks=' + badBuild.blocks + ' · ' + badBuild.status);
  ok('状态栏说明了修了什么', /自动修好|成功/.test(badBuild.status), badBuild.status);
  ok('自动识别出可编辑标题', badBuild.editing.length > 0, 'title1=' + badBuild.editing);
  ok('自动补上了 bind 方便改写', badBuild.binds >= 2, 'binds=' + badBuild.binds);

  // 改标题要真的生效
  await page.evaluate(() => {
    document.querySelector('#edit-fields [data-field=title1]').value = '改过的标题生效了';
    document.querySelector('#apply-edit').click();
  });
  await sleep(500);
  const editApplied = await page.evaluate(() => {
    const el = document.querySelector('#page [data-bind=title1]');
    return el ? (el.getAttribute('data-text') || '') : '';
  });
  ok('LLM 蓝图改文案能写回', /改过的标题生效了/.test(editApplied), editApplied);

  console.log('\n=== 8. 导出单文件 ===');
  await page.evaluate(() => {
    document.querySelector('#prompt').value = '做一个美甲店的预约页';
    document.querySelector('#llm-mode').value = 'offline';
    document.querySelector('#llm-mode').dispatchEvent(new Event('change'));
    document.querySelector('#build').click();
  });
  await sleep(500);
  await buildToEnd2(page);
  await page.evaluate(() => document.getElementById('goLive').click());
  await sleep(500);
  await page.evaluate(() => document.querySelector('#exp-html').click());
  let file = null;
  for (let i = 0; i < 60; i++) {
    const fs2 = fs.readdirSync(DL).filter(f => f.endsWith('.html'));
    if (fs2.length) { file = path.join(DL, fs2[0]); await sleep(500); break; }
    await sleep(150);
  }
  if (!file) {
    const le = await page.evaluate(() => window.__lastExport ? { name: window.__lastExport.name, html: window.__lastExport.html } : null);
    if (le) {
      file = path.join(DL, le.name);
      fs.writeFileSync(file, le.html, 'utf8');
    }
    ok('导出文件落盘（无头环境下载被拦，改用内存副本）', !!file, DL);
  } else {
    ok('导出文件落盘（真实下载）', true);
  }
  if (file) {
    const html = fs.readFileSync(file, 'utf8');
    const bodyMarkup = html.slice(html.indexOf('<body'), html.indexOf('<script id="render-src"'));
    ok('导出文件是单文件（无外链脚本）', !/<script[^>]+src=/.test(html), 'size=' + Math.round(html.length / 1024) + 'KB');
    ok('导出文件内联了静态内容', /巷子里的小店|在你身边/.test(bodyMarkup), 'markup=' + bodyMarkup.length);
    ok('导出文件带 noscript 兜底', /<noscript>/.test(html));
    ok('导出文件带主题属性', /data-theme="/.test(html));
    ok('导出文件没有 pending 类', !/\bpending\b/.test(bodyMarkup));

    // 8b) 关掉 JS 看静态内容
    const p2 = await browser.newPage();
    await p2.setViewport({ width: 1280, height: 860 });
    await p2.setJavaScriptEnabled(false);
    await p2.goto('file:///' + file.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded', timeout: 20000 });
    const noJs = await p2.evaluate(() => ({
      texts: document.body.innerText.replace(/\s+/g, ' ').trim().length,
      blocks: document.querySelectorAll('#page .blk').length,
      goLiveHidden: getComputedStyle(document.querySelector('#goLive')).display === 'none'
    }));
    ok('禁用 JS 仍能看到完整页面', noJs.blocks >= 20 && noJs.texts > 200, 'blocks=' + noJs.blocks + ' textLen=' + noJs.texts);
    ok('禁用 JS 时按钮不碍事', noJs.goLiveHidden);
    await p2.close();

    // 8c) 正常打开：能施工、能进入、能重播
    const p3 = await browser.newPage();
    await p3.setViewport({ width: 1280, height: 860 });
    const e3 = [];
    p3.on('pageerror', e => e3.push(e.message));
    await p3.goto('file:///' + file.replace(/\\/g, '/'), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(600);
    const started = await p3.evaluate(() => !!(window.__swarmEngine && window.__swarmEngine.running));
    ok('导出页自动开始施工', started);
    for (let i = 0; i < 60; i++) {
      const done = await p3.evaluate(() => {
        const e = window.__swarmEngine;
        if (!e) return true;
        if (e.tasks.every(t => t.state === 'done')) return true;
        e.advance(1500);
        return e.tasks.every(t => t.state === 'done');
      });
      if (done) break;
      await sleep(50);
    }
    await p3.evaluate(() => document.getElementById('goLive').click());
    await sleep(900);
    const ex = await p3.evaluate(() => {
      const nav = [].slice.call(document.querySelectorAll('#page [data-role="nav"]'))[1];
      if (nav) { const b = nav.getBoundingClientRect(); nav.dispatchEvent(new MouseEvent('click', { clientX: b.left + 3, clientY: b.top + 3, bubbles: true })); }
      return {
        goHidden: getComputedStyle(document.getElementById('goLive')).display === 'none',
        pending: document.querySelectorAll('#page .blk.pending').length,
        replay: getComputedStyle(document.getElementById('replay')).display !== 'none'
      };
    });
    await sleep(800);
    const exScroll = await p3.evaluate(() => document.getElementById('stage').scrollTop);
    ok('导出页施工完成', ex.pending === 0);
    ok('导出页「进入网站」生效', ex.goHidden);
    ok('导出页导航可点并滚动', exScroll > 50, 'scrollTop=' + exScroll);
    ok('导出页可重播', ex.replay);
    ok('导出页无运行时错误', e3.length === 0, e3.join(' | '));

    // 8d) ?nointro 直出真页面
    const p4 = await browser.newPage();
    await p4.setViewport({ width: 1280, height: 860 });
    await p4.goto('file:///' + file.replace(/\\/g, '/') + '?nointro', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(500);
    const ni = await p4.evaluate(() => ({
      engine: !!window.__swarmEngine,
      replayText: document.getElementById('replay').textContent,
      replayShown: getComputedStyle(document.getElementById('replay')).display !== 'none',
      pending: document.querySelectorAll('#page .blk.pending').length,
      clickable: getComputedStyle(document.querySelector('#page [data-interactive]')).pointerEvents
    }));
    ok('?nointro 不播放动画', ni.engine === false);
    ok('?nointro 直接展示真页面且可点', ni.pending === 0 && ni.clickable === 'auto');
    ok('?nointro 留了播放入口', ni.replayShown && /播放施工动画/.test(ni.replayText), ni.replayText);
    await p4.close();
    await p3.close();
  }

  console.log('\n=== 9. 尊重系统「减少动态效果」 ===');
  const p5 = await browser.newPage();
  await p5.setViewport({ width: 1280, height: 860 });
  await p5.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await p5.goto(APP, { waitUntil: 'load' });
  await p5.click('#build');
  await sleep(700);
  const rm = await p5.evaluate(() => ({
    pending: document.querySelectorAll('#page .blk.pending').length,
    hasEngine: !!window.__swarmEngine,
    goLive: getComputedStyle(document.querySelector('#goLive')).display !== 'none'
  }));
  ok('减少动态效果时不播放动画', rm.pending === 0, 'pending=' + rm.pending);
  ok('减少动态效果时直接给成品', rm.goLive);
  await p5.close();

  console.log('\n=== 10. 控制台 ===');
  const realErrors = errors.filter(e => !/favicon|Download the React|net::ERR_FILE/.test(e));
  ok('主流程零控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) { console.log('失败清单：'); fails.forEach(f => console.log(' - ' + f)); }
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(2); });
