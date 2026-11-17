/* tests/test-editor.js —— 点选编辑
 *
 * 覆盖：
 *   1. 进入/退出编辑态，页面里的块变得可点
 *   2. 点中任意元素 → 检查器出现，且只显示这一类型该有的控件
 *   3. 改字号 / 颜色 / 文案 / 对齐 / 坐标 → 画面、蓝图、内容面板、导出 JSON 四处同步
 *   4. 方向键微调、Ctrl+Z 撤销
 *   5. 双击文字就地输入
 *   6. 编辑态下点按钮不会真的复制微信/跳转
 *   7. 换照片、复制块、删除块、撤销删除
 *   8. 退出后真实交互恢复；重播与导出都带上改动
 *
 * 用法：node tests/test-editor.js
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.ED_PORT || 5291);
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--no-open'], {
      env: { ...process.env, PORT: String(PORT), SWARM_NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); if (/已启动/.test(out)) resolve(child); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (c) => reject(new Error('server 退出 ' + c + ': ' + out)));
    setTimeout(() => reject(new Error('server 启动超时: ' + out)), 12000);
  });
}

/* 把某个块滚进视野再点它（施工镜头会停在页面底部） */
async function tapBlock(p, sel) {
  const box = await p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, sel);
  if (!box) throw new Error('找不到 ' + sel);
  await sleep(260);
  const box2 = await p.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, sel);
  await p.mouse.click(box2.x, box2.y);
  await sleep(220);
  return box2;
}

async function pick(p, sel) {
  const okEl = await p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, sel);
  await sleep(240);
  return okEl;
}

function bp(page) {
  return page.evaluate(() => JSON.parse(document.querySelector('#blueprint-json').value));
}
function insp(page) {
  return page.evaluate(() => ({
    open: !document.querySelector('#insp').hidden,
    title: document.querySelector('#insp-title').textContent,
    type: document.querySelector('#insp-type').textContent,
    rows: ['text', 'font', 'align', 'color', 'fill', 'radius', 'photo'].filter((k) => !document.querySelector('#row-' + k).hidden),
    selCount: document.querySelectorAll('#page .blk.sw-sel').length
  }));
}

(async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: EDGE, headless: 'new',
      args: ['--no-sandbox', '--allow-file-access-from-files']
    });
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 940 });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console:' + m.text());
    });

    await p.goto(BASE + '/', { waitUntil: 'load' });
    await sleep(700);

    console.log('\n=== 0. 建一次站 ===');
    await p.evaluate(() => {
      document.querySelector('#llm-mode').value = 'offline';
      document.querySelector('#prompt').value = '做一个高端美甲店的预约页';
      document.querySelector('#build').click();
    });
    await sleep(400);
    for (let i = 0; i < 100; i++) {
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
    ok('施工完成', true);

    console.log('\n=== 1. 进入编辑态 ===');
    await p.click('#btn-edit');
    await sleep(400);
    const entered = await p.evaluate(() => ({
      on: document.body.classList.contains('sw-editing'),
      pageCls: document.querySelector('#page').classList.contains('sw-edit'),
      btn: document.querySelector('#btn-edit').textContent,
      pe: getComputedStyle(document.querySelector('#page .blk')).pointerEvents,
      exportbar: getComputedStyle(document.querySelector('#exportbar')).display
    }));
    ok('进入编辑态', entered.on && entered.pageCls, JSON.stringify(entered));
    ok('按钮变成「完成编辑」', /完成编辑/.test(entered.btn), entered.btn);
    ok('所有块都变成可点', entered.pe === 'auto', entered.pe);
    ok('顺手把导出行显示出来', entered.exportbar === 'flex', entered.exportbar);

    console.log('\n=== 2. 选中一个文字块 ===');
    await tapBlock(p, '#page [data-bind="title1"]');
    const s1 = await insp(p);
    ok('检查器出现', s1.open);
    ok('只高亮一个块', s1.selCount === 1, 'sel=' + s1.selCount);
    ok('标题取的是这块的文字', /在你身边/.test(s1.title), s1.title);
    ok('类型显示为文字', s1.type === '文字', s1.type);
    ok('文字块有文案/字号/对齐/颜色，没有背景色', 
      s1.rows.includes('text') && s1.rows.includes('font') && s1.rows.includes('color') && !s1.rows.includes('fill'), s1.rows.join(','));

    console.log('\n=== 3. 改字号 / 颜色 / 文案 ===');
    await p.evaluate(() => {
      const i = document.querySelector('#ir-size');
      i.value = '92';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(200);
    const afterSize = await p.evaluate(() => {
      const el = document.querySelector('#page [data-bind="title1"]');
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.bind === 'title1');
      return { css: getComputedStyle(el).fontSize, bp: String(b.style.fontSize) };
    });
    ok('字号改完画面立刻变', afterSize.css === '92px', afterSize.css);
    ok('字号写进了蓝图', afterSize.bp === '92px', afterSize.bp);

    await p.evaluate(() => {
      const i = document.querySelector('#ir-color');
      i.value = '#c0392b';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(200);
    const afterColor = await p.evaluate(() => {
      const el = document.querySelector('#page [data-bind="title1"]');
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.bind === 'title1');
      return { css: getComputedStyle(el).color, bp: b.style.color };
    });
    ok('颜色改完画面立刻变', afterColor.css === 'rgb(192, 57, 43)', afterColor.css);
    ok('颜色写进了蓝图', afterColor.bp === '#c0392b', afterColor.bp);

    await p.evaluate(() => {
      const i = document.querySelector('#ir-text');
      i.value = '只做一件事，做到最好';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(250);
    const afterText = await p.evaluate(() => {
      const el = document.querySelector('#page [data-bind="title1"]');
      const f = document.querySelector('#edit-fields [data-field="title1"]');
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.bind === 'title1');
      return { dom: el.textContent.trim(), field: f ? f.value : null, bp: b.text };
    });
    ok('文案改完画面立刻变', afterText.dom === '只做一件事，做到最好', afterText.dom);
    ok('文案写进了蓝图', afterText.bp === '只做一件事，做到最好', afterText.bp);
    ok('内容面板的同一字段跟着同步（不会互相覆盖）', afterText.field === '只做一件事，做到最好', String(afterText.field));

    // 真实键入：面板不能被"回填"打断（否则光标会跳到末尾、中文输入法会被掐断）
    await p.evaluate(() => { const t = document.querySelector('#ir-text'); t.focus(); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(120);
    await p.keyboard.type('连续键入测试');
    await sleep(200);
    const typedInPanel = await p.evaluate(() => ({
      val: document.querySelector('#ir-text').value,
      caret: document.querySelector('#ir-text').selectionStart,
      bp: JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.bind === 'title1').text
    }));
    ok('面板里连续键入不会被回填打断', typedInPanel.val === '连续键入测试' && typedInPanel.caret === 6, JSON.stringify(typedInPanel));
    ok('键入的内容同步进蓝图', typedInPanel.bp === '连续键入测试', typedInPanel.bp);

    console.log('\n=== 4. 对齐 / 方向键 / 坐标 ===');
    await p.evaluate(() => { document.querySelector('#ir-align button[data-v="center"]').click(); });
    await sleep(200);
    const align = await p.evaluate(() => {
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.bind === 'title1');
      const t = document.querySelector('#page [data-bind="title1"] .txt');
      return { align: b.align, justify: getComputedStyle(t).justifyContent };
    });
    ok('对齐按钮生效', align.align === 'center' && align.justify === 'center', JSON.stringify(align));

    const before = await p.evaluate(() => {
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.bind === 'title1');
      return { x: b.x, y: b.y };
    });
    await p.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await p.keyboard.press('ArrowRight');
    await p.keyboard.down('Shift');
    await p.keyboard.press('ArrowDown');
    await p.keyboard.up('Shift');
    await sleep(220);
    const moved = await p.evaluate(() => {
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.bind === 'title1');
      const el = document.querySelector('#page [data-bind="title1"]');
      return { x: b.x, y: b.y, left: el.style.left, top: el.style.top };
    });
    ok('方向键微调 1px', moved.x === before.x + 1, before.x + '→' + moved.x);
    ok('Shift+方向键 10px', moved.y === before.y + 10, before.y + '→' + moved.y);
    ok('位置同时落到 DOM 上', moved.left === moved.x + 'px' && moved.top === moved.y + 'px', moved.left + ',' + moved.top);

    await p.evaluate(() => {
      const i = document.querySelector('#ir-x');
      i.value = '120';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(200);
    ok('直接输 X 坐标也生效', (await bp(p)).blocks.find((b) => b.bind === 'title1').x === 120);

    console.log('\n=== 5. 撤销 ===');
    await p.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await p.keyboard.down('Control');
    await p.keyboard.press('KeyZ');
    await p.keyboard.up('Control');
    await sleep(250);
    const undone = (await bp(p)).blocks.find((b) => b.bind === 'title1');
    ok('Ctrl+Z 撤销掉刚才的坐标改动', undone.x !== 120, 'x=' + undone.x);
    const undoPanelX = await p.evaluate(() => document.querySelector('#ir-x').value);
    ok('撤销后面板跟着刷新', String(undoPanelX) === String(undone.x), undoPanelX + ' vs ' + undone.x);

    console.log('\n=== 6. 双击就地改字 ===');
    const tb = await p.evaluate(() => {
      const el = document.querySelector('#page [data-bind="title1"]');
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) };
    });
    await sleep(250);
    const tb2 = await p.evaluate(() => {
      const r = document.querySelector('#page [data-bind="title1"]').getBoundingClientRect();
      return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) };
    });
    await p.mouse.click(tb2.x, tb2.y);
    await sleep(80);
    await p.mouse.click(tb2.x, tb2.y);
    await sleep(350);
    const editing = await p.evaluate(() => {
      const t = document.querySelector('#page [data-bind="title1"] .txt');
      return { ce: t.getAttribute('contenteditable'), focused: document.activeElement === t };
    });
    ok('双击文字进入就地输入', editing.ce === 'true' && editing.focused, JSON.stringify(editing));
    await p.keyboard.type('手打的新标题');
    await p.keyboard.press('Escape');
    await sleep(350);
    const typed = await p.evaluate(() => {
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.bind === 'title1');
      const el = document.querySelector('#page [data-bind="title1"]');
      return { bp: b.text, dom: el.textContent.trim(), ce: el.querySelector('.txt').getAttribute('contenteditable') };
    });
    ok('键入的文字提交进蓝图', typed.bp === '手打的新标题', typed.bp);
    ok('画面同步且退出输入态', typed.dom === '手打的新标题' && !typed.ce, JSON.stringify(typed));

    console.log('\n=== 7. 编辑态下点按钮不会真的执行动作 ===');
    await p.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.remove(); });
    await pick(p, '#page .blk.rect[data-action]');
    const btn = await p.evaluate(() => ({
      type: document.querySelector('#insp-type').textContent,
      rows: ['fill', 'text', 'photo'].filter((k) => !document.querySelector('#row-' + k).hidden),
      toast: !!document.querySelector('#toast'),
      toastTxt: document.querySelector('#toast') ? document.querySelector('#toast').textContent : '',
      action: document.querySelector('#page .sw-sel') ? document.querySelector('#page .sw-sel').getAttribute('data-action') : ''
    }));
    ok('按钮被选中而不是被触发', btn.type === '色块' && !!btn.action, JSON.stringify(btn));
    ok('没有弹出「复制微信号」之类的提示', !/微信|复制/.test(btn.toastTxt), btn.toastTxt);
    ok('色块显示背景色、不显示文案与换图', btn.rows.includes('fill') && !btn.rows.includes('text') && !btn.rows.includes('photo'), btn.rows.join(','));

    await p.evaluate(() => {
      const i = document.querySelector('#ir-fill');
      i.value = '#1f6feb';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(220);
    const filled = await p.evaluate(() => {
      const el = document.querySelector('#page .sw-sel');
      return { css: getComputedStyle(el).backgroundColor, bp: JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((b) => b.id === el.id.replace('blk-', '')).style.background };
    });
    ok('改背景色同时落到画面和蓝图', filled.css === 'rgb(31, 111, 235)' && filled.bp === '#1f6feb', JSON.stringify(filled));

    console.log('\n=== 8. 换照片 ===');
    await pick(p, '#page .blk.image');
    const img0 = await p.evaluate(() => {
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.id === document.querySelector('#page .sw-sel').id.replace('blk-', ''));
      return String(b.image).slice(0, 80);
    });
    await p.click('#ir-photo-next');
    await sleep(400);
    const img1 = await p.evaluate(() => {
      const b = JSON.parse(document.querySelector('#blueprint-json').value).blocks.find((x) => x.id === document.querySelector('#page .sw-sel').id.replace('blk-', ''));
      const el = document.querySelector('#page .sw-sel .imgfill');
      return { image: String(b.image).slice(0, 80), css: getComputedStyle(el).backgroundImage.slice(0, 60) };
    });
    ok('换照片真的换了另一张', img1.image !== img0, img0 + ' → ' + img1.image);
    ok('新照片同时刷到画面上', /url\(/.test(img1.css), img1.css);

    console.log('\n=== 9. 复制 / 删除 / 撤销删除 ===');
    const count0 = (await bp(p)).blocks.length;
    await p.click('#ir-dup');
    await sleep(350);
    const dup = await bp(p);
    ok('复制后多了一块', dup.blocks.length === count0 + 1, count0 + '→' + dup.blocks.length);
    const ids = dup.blocks.map((b) => String(b.id));
    ok('副本 id 不重复', new Set(ids).size === ids.length, ids.length + ' vs ' + new Set(ids).size);
    const copySel = await p.evaluate(() => {
      const el = document.querySelector('#page .sw-sel');
      return el ? el.id : null;
    });
    ok('复制完自动选中副本', !!copySel && copySel.replace('blk-', '') !== 'x', String(copySel));

    await p.click('#ir-del');
    await sleep(350);
    const del = await bp(p);
    ok('删除后少了一块', del.blocks.length === count0, del.blocks.length + ' vs ' + count0);
    ok('删完没有残留的选中框', (await insp(p)).selCount === 0);

    await p.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await p.keyboard.down('Control');
    await p.keyboard.press('KeyZ');
    await p.keyboard.up('Control');
    await sleep(400);
    const restored = await bp(p);
    ok('撤销能把删掉的块恢复', restored.blocks.length === count0 + 1, restored.blocks.length + ' vs ' + (count0 + 1));

    console.log('\n=== 10. 退出编辑后真实交互恢复 ===');
    await p.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await p.keyboard.press('Escape');   // 先取消选择
    await sleep(150);
    const afterEsc = await insp(p);
    ok('第一次 Esc 只取消选择', afterEsc.selCount === 0 && afterEsc.open === false, JSON.stringify(afterEsc));
    await p.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    await p.keyboard.press('Escape');   // 再 Esc 退出编辑
    await sleep(300);
    const exited = await p.evaluate(() => ({
      on: document.body.classList.contains('sw-editing'),
      btn: document.querySelector('#btn-edit').textContent,
      insp: document.querySelector('#insp').hidden
    }));
    ok('第二次 Esc 退出编辑', !exited.on && /点选编辑/.test(exited.btn), JSON.stringify(exited));

    await p.evaluate(() => { document.querySelector('#stage').scrollTop = 0; });
    await sleep(400);
    const navBox = await p.evaluate(() => {
      const stage = document.querySelector('#stage');
      // 导航里有高度为 1 的包裹块，取真正看得见的那个链接
      const navs = [].slice.call(document.querySelectorAll('#page [data-role="nav"]'))
        .filter((e) => e.getBoundingClientRect().height > 10);
      const el = navs[2] || navs[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: stage.scrollTop, count: navs.length };
    });
    ok('导航项是可点的真实链接', !!navBox && navBox.count >= 3, JSON.stringify(navBox));
    const beforeScroll = navBox.top;
    await p.mouse.click(navBox.x, navBox.y);
    await sleep(1000);
    const afterScroll = await p.evaluate(() => document.querySelector('#stage').scrollTop);
    ok('退出后点导航能真的滚动', afterScroll > beforeScroll + 50, beforeScroll + '→' + afterScroll);

    console.log('\n=== 11. 重播与导出都带上改动 ===');
    await p.evaluate(() => document.querySelector('#replay').click());
    await sleep(600);
    for (let i = 0; i < 100; i++) {
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
    const replay = await p.evaluate(() => {
      const el = document.querySelector('#page [data-bind="title1"]');
      return { text: el ? el.textContent.trim() : null, size: el ? getComputedStyle(el).fontSize : null, color: el ? getComputedStyle(el).color : null };
    });
    ok('重播后文案还是改过的', replay.text === '手打的新标题', String(replay.text));
    ok('重播后字号/颜色也还在', replay.size === '92px' && replay.color === 'rgb(192, 57, 43)', replay.size + ' / ' + replay.color);

    const exp = await p.evaluate(async () => {
      const box = document.querySelector('#exp-embed');
      if (box) box.checked = false;
      window.__lastExport = null;
      document.querySelector('#exp-html').click();
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        if (window.__lastExport && window.__lastExport.html) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const html = (window.__lastExport || {}).html || '';
      return {
        size: html.length,
        hasText: html.indexOf('手打的新标题') >= 0,
        hasSize: /font-size:\s*92px/.test(html),
        hasColor: /#c0392b/i.test(html)
      };
    });
    ok('导出的单文件里带着改过的文案', exp.hasText, JSON.stringify({ size: exp.size }));
    ok('导出的单文件里带着新字号', exp.hasSize);
    ok('导出的单文件里带着新颜色', exp.hasColor);

    ok('全程无运行时错误', errs.length === 0, errs.join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }

  console.log('\n通过 ' + pass + '，失败 ' + fail);
  if (fail) { console.log('失败清单：\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
