/* tests/test-compiler.js —— HTML → 蓝图 编译器
 *
 * 覆盖：
 *   1. 白名单清洗：script / onclick / style / 外链 img 一律剥掉
 *   2. 基础编译：块数、类型、坐标、图片位、action、居中对齐
 *   3. 容错：模型自创 class、脏 HTML、未闭合标签，都不能崩
 *   4. 依赖：分段串行，段内并行
 *   5. 分流：JSON 不会被误判成 HTML，HTML 会被正确识别
 *   6. 端到端：粘贴 HTML → 施工完成 → 页面可点 → 图片按场景配好
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const APP = 'file:///' + path.resolve(__dirname, '..').replace(/\\/g, '/') + '/index.html';

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GOOD = [
  '<nav class="nav"><div class="brand">巷子里</div><div class="nav-links"><a href="#">服务</a><a href="#">价格</a></div></nav>',
  '<section class="hero"><div class="hero-copy"><div class="eyebrow">NAIL ATELIER</div><h1 class="h1">三十分钟，把手交给我们</h1>',
  '<p class="lead">日式美甲与手部护理，一人一锉一消毒。</p>',
  '<div class="btn-row"><a class="btn btn-primary" data-action="wechat" data-value="nailhouse">微信预约</a>',
  '<a class="btn btn-ghost">看价目</a></div></div><div class="media"></div></section>',
  '<section class="features"><div class="section-head"><h2 class="h2">为什么选我们</h2></div><div class="grid-3">',
  '<div class="card"><div class="media"></div><h3 class="h3">一人一消毒</h3><p>每套工具独立高温灭菌。</p></div>',
  '<div class="card"><div class="media"></div><h3 class="h3">三十分钟快修</h3><p>午休就能做完。</p></div>',
  '<div class="card"><div class="media"></div><h3 class="h3">不推销办卡</h3><p>只做你约的那一项。</p></div>',
  '</div></section>',
  '<div class="stats"><div><div class="stat-num">2400</div><div class="stat-label">位客人</div></div>',
  '<div><div class="stat-num">4.9</div><div class="stat-label">平均评分</div></div></div>',
  '<section class="cta"><div><h2 class="h2">今天还有 3 个位子</h2><p class="lead-sm">营业时间 10:00-20:00</p></div>',
  '<a class="btn btn-primary" data-action="tel" data-value="13800000000">打电话</a></section>',
  '<footer class="footer"><div><div class="brand">巷子里</div><div class="contact-line">微信 nailhouse · 电话 138</div></div>',
  '<div class="foot-links"><a>Twitter</a><a>Email</a></div></footer>'
].join('');

const CENTERED = '<section class="hero-center"><div class="eyebrow">YOGA</div>' +
  '<h1 class="h1">每周三晚，一起呼吸</h1><p class="lead">小班八人，社区活动室。</p>' +
  '<div class="btn-row"><a class="btn btn-primary" data-action="wechat" data-value="yoga">报名</a></div></section>';

const DIRTY = '<div style="color:red" onclick="alert(1)"><script>alert(2)</script>' +
  '<h1 class="h1">标题</h1><img src="https://evil.example.com/x.png">' +
  '<a href="javascript:alert(3)" class="btn">坏链接</a><iframe src="https://evil"></iframe></div>';

const WEIRD = '<div class="container"><div class="hero-title">我自创了类名</div>' +
  '<div class="wrapper"><p>这段正文没有任何可用 class，但文字不能丢。</p></div></div>';

const BROKEN = '<section class="hero"><div class="hero-copy"><h1 class="h1">没闭合的标题<p>也缺结束' +
  '<div class="card"><h3 class="h3">卡片';

(async () => {
  const b = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 940 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console:' + m.text()); });

  await p.goto(APP, { waitUntil: 'load' });
  await sleep(600);

  console.log('\n=== 1. 清洗与分流 ===');
  const san = await p.evaluate((dirty) => {
    const out = window.BlueprintCompiler.sanitize(dirty);
    return {
      out: out,
      noScript: !/<script/i.test(out),
      noOnclick: !/onclick/i.test(out),
      noStyle: !/style=/i.test(out),
      noImg: !/<img/i.test(out),
      noIframe: !/<iframe/i.test(out),
      noJsHref: !/javascript:/i.test(out),
      keepsText: /标题/.test(out) && /坏链接/.test(out)
    };
  }, DIRTY);
  ok('script 被剥掉', san.noScript);
  ok('onclick 被剥掉', san.noOnclick);
  ok('style 属性被剥掉', san.noStyle);
  ok('外链 img 被剥掉', san.noImg);
  ok('iframe 被剥掉', san.noIframe);
  ok('javascript: 链接被剥掉', san.noJsHref, san.out.slice(0, 80));
  ok('文字内容保留下来', san.keepsText);

  const split = await p.evaluate(() => {
    const C = window.BlueprintCompiler;
    const json = '{"meta":{"title":"x"},"blocks":[{"id":"a","type":"text","x":0,"y":0,"w":10,"h":10,"text":"hi"}]}';
    return {
      json: C.looksLikeHTML(json),
      html: C.looksLikeHTML('<section class="hero"><h1>标题</h1></section>'),
      plain: C.looksLikeHTML('你好，帮我做个页面'),
      fence: C.extractHTML('好的\n```html\n<section class="hero"><h1>甲</h1></section>\n```'),
      body: C.extractHTML('<html><body><div>乙</div></body></html>')
    };
  });
  ok('JSON 不会被误判成 HTML', split.json === false);
  ok('HTML 会被识别', split.html === true);
  ok('普通文字不会被误判', split.plain === false);
  ok('去得掉 markdown 围栏', !/```/.test(split.fence) && /<section/.test(split.fence), split.fence);
  ok('完整文档只取 body', split.body.indexOf('<body') < 0 && /乙/.test(split.body), split.body);

  console.log('\n=== 2. 基础编译 ===');
  const g = await p.evaluate((html) => {
    return window.BlueprintCompiler.compile(html).then((bp) => {
      const bs = bp.blocks;
      const t = bs.filter((x) => x.type === 'text');
      const img = bs.filter((x) => x.type === 'image');
      const rect = bs.filter((x) => x.type === 'rect');
      return {
        blocks: bs.length, text: t.length, img: img.length, rect: rect.length,
        height: bp.meta.height,
        actions: bs.filter((x) => x.action).map((x) => x.action + ':' + x.actionValue),
        heroImg: img.length ? img.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0].label : '',
        cardRects: rect.filter((x) => /card/.test(x.label)).length,
        outOfCanvas: bs.filter((x) => x.x < 0 || x.x + x.w > 1200 + 2).length,
        zeroSize: bs.filter((x) => x.w < 2 || x.h < 2).length,
        withDeps: bs.filter((x) => x.deps && x.deps.length).length,
        h1Size: (t.filter((x) => /三十分钟/.test(x.text))[0] || {}).style
      };
    });
  }, GOOD);
  ok('编译出足够多的块', g.blocks >= 20, 'blocks=' + g.blocks);
  ok('三类块都有', g.text > 8 && g.img >= 4 && g.rect >= 4, JSON.stringify({ t: g.text, i: g.img, r: g.rect }));
  ok('高度合理（1000~3000）', g.height > 1000 && g.height < 3000, 'h=' + g.height);
  ok('按钮 action 不重复', g.actions.length === 2, JSON.stringify(g.actions));
  ok('action 值正确', g.actions.indexOf('wechat:nailhouse') >= 0 && g.actions.indexOf('tel:13800000000') >= 0, JSON.stringify(g.actions));
  ok('首屏图识别为 hero image', g.heroImg === 'hero image', g.heroImg);
  ok('三张卡片都被识别', g.cardRects === 3, 'cards=' + g.cardRects);
  ok('没有块跑出画布', g.outOfCanvas === 0, 'out=' + g.outOfCanvas);
  ok('没有零尺寸块', g.zeroSize === 0, 'zero=' + g.zeroSize);
  ok('有施工依赖（分段串行）', g.withDeps >= 3, 'deps=' + g.withDeps);
  ok('标题字号被搬过来（>=40px）', g.h1Size && parseFloat(g.h1Size.fontSize) >= 40, JSON.stringify(g.h1Size));

  console.log('\n=== 3. 居中首屏 ===');
  const c = await p.evaluate((html) => {
    return window.BlueprintCompiler.compile(html).then((bp) => {
      const t = bp.blocks.filter((x) => x.type === 'text');
      const h1 = t.filter((x) => /一起呼吸/.test(x.text))[0] || {};
      return { align: h1.align, w: h1.w, x: h1.x, blocks: bp.blocks.length };
    });
  }, CENTERED);
  ok('居中排版被识别为 center', c.align === 'center', JSON.stringify(c));
  ok('居中标题宽度撑满内容区', c.w > 600, 'w=' + c.w);

  console.log('\n=== 4. 容错 ===');
  const weird = await p.evaluate((html) => {
    return window.BlueprintCompiler.compile(html).then((bp) => ({
      ok: true, blocks: bp.blocks.length,
      texts: bp.blocks.filter((x) => x.type === 'text').map((x) => x.text)
    })).catch((e) => ({ ok: false, err: e.message }));
  }, WEIRD);
  ok('自创 class 不会崩', weird.ok === true, weird.err);
  ok('自创 class 时文字不丢', weird.ok && weird.texts.join('|').indexOf('我自创了类名') >= 0, JSON.stringify(weird.texts));

  const broken = await p.evaluate((html) => {
    return window.BlueprintCompiler.compile(html).then((bp) => ({ ok: true, blocks: bp.blocks.length }))
      .catch((e) => ({ ok: false, err: e.message }));
  }, BROKEN);
  ok('未闭合标签也能编译', broken.ok === true, broken.err);

  const empty = await p.evaluate(() => {
    return window.BlueprintCompiler.compile('   ').then(() => ({ ok: true })).catch((e) => ({ ok: false, err: e.message }));
  });
  ok('空内容给明确错误', empty.ok === false && /HTML/.test(empty.err), JSON.stringify(empty));

  console.log('\n=== 5. 提示词 ===');
  const pr = await p.evaluate(() => {
    const s = window.BlueprintCompiler.buildPrompt('做一个美甲店', { contact: '微信 x' });
    return {
      len: s.length,
      noStyle: /不要写 style/.test(s),
      classList: /hero-center/.test(s) && /media-wide/.test(s) && /grid-3/.test(s),
      photoRule: /media/.test(s) && /不要写 src/.test(s),
      diffRule: /结构应该明显不同/.test(s),
      contact: /微信 x/.test(s),
      jsonWords: /JSON/.test(s)
    };
  });
  ok('提示词包含 class 清单', pr.classList);
  ok('提示词禁止写 style', pr.noStyle);
  ok('提示词约定图片写法', pr.photoRule);
  ok('提示词要求结构因行业而异', pr.diffRule);
  ok('提示词带上联系方式', pr.contact);
  ok('提示词不再要求输出 JSON', pr.jsonWords === false);
  ok('提示词长度可控（<4000 字符）', pr.len < 4000, 'len=' + pr.len);

  console.log('\n=== 6. 端到端施工 ===');
  await p.evaluate((html) => {
    document.querySelector('#llm-mode').value = 'offline';
    document.querySelector('#prompt').value = '做一个高端美甲店的预约页';
    document.querySelector('#blueprint-json').value = html;
    document.querySelector('#from-json').click();
  }, GOOD);
  await sleep(1500);

  const mid = await p.evaluate(() => ({
    engine: !!window.__swarmEngine,
    blocks: document.querySelectorAll('#page .blk').length,
    imgs: document.querySelectorAll('#page .blk.image').length
  }));
  ok('编译器产物能进施工引擎', mid.engine && mid.blocks >= 20, JSON.stringify(mid));

  for (let i = 0; i < 90; i++) {
    const done = await p.evaluate(() => {
      const e = window.__swarmEngine;
      if (!e) return false;
      if (e.tasks.every((t) => t.state === 'done')) return true;
      e.advance(1200);
      return e.tasks.every((t) => t.state === 'done');
    });
    if (done) break;
    await sleep(50);
  }
  await p.evaluate(() => { const g = document.getElementById('goLive'); if (g) g.click(); });
  await sleep(2200);

  const live = await p.evaluate(() => {
    const fills = [].slice.call(document.querySelectorAll('#page .blk.image .imgfill'));
    return {
      imgs: fills.length,
      withPhoto: fills.filter((f) => /images\.unsplash\.com/.test(getComputedStyle(f).backgroundImage)).length,
      clickable: document.querySelectorAll('#page [data-action]').length,
      cards: document.querySelectorAll('#page [data-role="card"]').length,
      textOk: /三十分钟/.test(document.querySelector('#page').textContent)
    };
  });
  ok('图片块配上了真实照片', live.imgs >= 4 && live.withPhoto >= 4, JSON.stringify(live));
  ok('按钮可点（action 保留）', live.clickable >= 2, 'clickable=' + live.clickable);
  ok('卡片可点（role=card）', live.cards >= 3, 'cards=' + live.cards);
  ok('文案渲染完整', live.textOk);

  console.log('\n=== 7. 导出一致性 ===');
  const exp = await p.evaluate(() => {
    const html = window.__lastExport ? window.__lastExport.html : '';
    return {
      exists: !!html, size: html.length,
      inlineImgs: (html.match(/images\.unsplash\.com/g) || []).length,
      hasBlocks: /class="blk/.test(html),
      noPending: !/class="blk[^"]*\bpending\b/.test(html)
    };
  });
  if (!exp.exists) {
    await p.evaluate(() => { const b = document.querySelector('#exp-html'); if (b) b.click(); });
    await sleep(1200);
  }
  const exp2 = await p.evaluate(() => {
    const html = window.__lastExport ? window.__lastExport.html : '';
    return {
      exists: !!html, size: html.length,
      inlineImgs: (html.match(/images\.unsplash\.com/g) || []).length,
      hasBlocks: /class="blk/.test(html),
      noPending: !/class="blk[^"]*\bpending\b/.test(html)
    };
  });
  ok('导出的单文件包含编译产物', exp2.exists && exp2.hasBlocks, JSON.stringify(exp2));
  ok('导出文件里图片链接保留', exp2.inlineImgs >= 4, 'imgs=' + exp2.inlineImgs);
  ok('导出文件没有残留 pending', exp2.exists ? exp2.noPending : true);

  ok('全程无运行时错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  await p.screenshot({ path: path.join(__dirname, 'shot-compiled.png') });
  await b.close();
  console.log('\n通过 ' + pass + '，失败 ' + fail);
  if (fail) console.log('失败清单：' + fails.join('；'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
