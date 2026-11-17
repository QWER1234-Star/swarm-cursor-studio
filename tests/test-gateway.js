/* tests/test-gateway.js —— 本机接口 + 在线 API 全链路
 *
 * 覆盖：
 *   1. server.js 启动 / 健康检查 / 静态托管
 *   2. 页面自动识别本机接口，预设一键填地址
 *   3. 填 Key → 保存到本机接口（浏览器不留 Key）
 *   4. 刷新后仍然可用（Key 在服务端）
 *   5. 测试连接 / 生成蓝图（流式） / 一句话改页面 / 撤销
 *   6. 清掉 Key 后给出可读错误
 *   7. 跨域守卫：外部 Origin 被拒
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const CONF = path.join(__dirname, '.llm-test.json');
const PORT = Number(process.env.GW_PORT || 5271);
const UPPORT = 18093;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假上游（OpenAI 兼容，支持流式） ---------- */
const BP_TITLE = '接口写的标题';
const BP_PATCHED = '改过的标题';
function blueprint(title, extra) {
  const blocks = [
    { id: 't1', type: 'text', x: 80, y: 60, w: 700, h: 64, style: { fontSize: '52px', fontWeight: '800', color: '#ffffff' }, text: title, bind: 'title1' },
    { id: 'p1', type: 'text', x: 80, y: 140, w: 620, h: 80, style: { fontSize: '16px', color: '#9fb0c9' }, text: '这段文字来自接口，用来验证在线生成。' },
    { id: 'n1', type: 'text', x: 880, y: 44, w: 90, h: 26, style: { fontSize: '13px', color: '#cfe0f5' }, text: '特色', label: 'nav link' },
    { id: 'btn', type: 'rect', x: 80, y: 250, w: 210, h: 56, style: { background: '#2b7cff', borderRadius: '8px' }, label: 'button', action: 'wechat', actionValue: 'gateway_demo' },
    { id: 'sec', type: 'text', x: 80, y: 420, w: 520, h: 40, style: { fontSize: '28px', fontWeight: '700', color: '#fff' }, text: '下半屏区块' }
  ];
  if (extra) blocks.push(extra);
  return { meta: { title: '接口生成站', width: 1200, height: 780, bg: '#0b1220' }, blocks: blocks };
}

let upMode = 'ok';

const upstream = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.url === '/mode') {
    upMode = req.headers['x-mode'] || 'ok';
    res.writeHead(200, cors); return res.end('ok');
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (e) {}
    const msgs = body.messages || [];
    const lastUser = (msgs.filter((m) => m.role === 'user').pop() || {}).content || '';

    if (upMode === '500') {
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: { message: '上游炸了' } }));
    }

    const isProbe = /只回复两个字/.test(lastUser);
    const isPatch = /修改要求：/.test(lastUser);
    let text;
    if (isProbe) text = '可以';
    else if (isPatch) {
      const bp = blueprint(BP_PATCHED, { id: 'n2', type: 'rect', x: 80, y: 500, w: 320, h: 140, style: { background: '#16233a', borderRadius: '12px' }, label: 'card' });
      text = '好的：\n```json\n' + JSON.stringify(bp) + '\n```';
    } else {
      text = '这是蓝图：\n```json\n' + JSON.stringify(blueprint(BP_TITLE)) + '\n```\n还需要调整随时说。';
    }

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', ...cors });
      const step = 24;
      let i = 0;
      const timer = setInterval(() => {
        if (i >= text.length) {
          res.write('data: [DONE]\n\n');
          clearInterval(timer);
          return res.end();
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + step) } }] }) + '\n\n');
        i += step;
      }, 12);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    res.end(JSON.stringify({ model: 'fake-1', choices: [{ message: { content: text } }], usage: { total_tokens: 100 } }));
  });
});

/* ---------- 起本机接口 ---------- */
function startGateway() {
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
    child.on('exit', (code) => reject(new Error('gateway exited ' + code + ': ' + out)));
    setTimeout(() => reject(new Error('gateway start timeout: ' + out)), 12000);
  });
}

function httpJson(options, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, body: j, raw: raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(JSON.stringify(payload));
    req.end();
  });
}

(async () => {
  try { fs.unlinkSync(CONF); } catch (e) {}
  await new Promise((r) => upstream.listen(UPPORT, '127.0.0.1', r));
  const gw = await startGateway();
  let browser = null;

  try {
    console.log('\n=== 1. 本机接口本身 ===');
    const health = await httpJson({ host: '127.0.0.1', port: PORT, path: '/api/llm/health', method: 'GET' });
    ok('健康检查返回 service=swarmsite-gateway', health.status === 200 && health.body && health.body.service === 'swarmsite-gateway', JSON.stringify(health.body));
    ok('未配置时 hasKey=false', health.body && health.body.hasKey === false);

    const page = await httpJson({ host: '127.0.0.1', port: PORT, path: '/', method: 'GET' });
    ok('页面能被 http 托管（不再是 file://）', page.status === 200 && /SwarmSite/.test(page.raw), 'status=' + page.status);

    const cross = await httpJson({
      host: '127.0.0.1', port: PORT, path: '/api/llm/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }
    }, { messages: [{ role: 'user', content: 'hi' }] });
    ok('外部 Origin 被跨域守卫拒绝', cross.status === 403, 'status=' + cross.status);

    const noKey = await httpJson({
      host: '127.0.0.1', port: PORT, path: '/api/llm/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { messages: [{ role: 'user', content: 'hi' }], baseUrl: 'http://127.0.0.1:' + UPPORT + '/v1' });
    ok('本机上游不需要 Key 也能转发', noKey.status === 200 && /接口写的标题/.test(JSON.stringify(noKey.body)), JSON.stringify(noKey.body).slice(0, 120));

    console.log('\n=== 2. 页面里填 Key ===');
    browser = await puppeteer.launch({
      executablePath: EDGE, headless: 'new',
      args: ['--no-sandbox', '--allow-file-access-from-files']
    });
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/Failed to load resource/i.test(t)) return;   // favicon / 故意触发的 500
      errs.push('console:' + t);
    });

    await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
    await p.click('#advanced');
    await p.click('#tab-llm');
    await p.select('#llm-mode', 'api');
    await sleep(500);

    const gwView = await p.evaluate(() => {
      const b = document.querySelector('#gw-status');
      return { cls: b.className, txt: b.textContent, mode: document.querySelector('#llm-mode').value };
    });
    ok('页面自动识别本机接口（状态条变绿）', /ok/.test(gwView.cls) && /已连通/.test(gwView.txt), JSON.stringify(gwView));

    await p.click('[data-preset="deepseek"]');
    await sleep(200);
    const preset = await p.evaluate(() => ({
      url: document.querySelector('#llm-url').value,
      model: document.querySelector('#llm-model').value,
      mode: document.querySelector('#llm-mode').value
    }));
    ok('服务商预设一键填好地址与模型', /deepseek/.test(preset.url) && !!preset.model, JSON.stringify(preset));

    await p.evaluate((u) => {
      document.querySelector('#llm-url').value = u;
      document.querySelector('#llm-model').value = 'fake-1';
      document.querySelector('#llm-key').value = 'sk-gateway-987654321';
    }, 'http://127.0.0.1:' + UPPORT + '/v1');
    await p.click('#save-llm');
    await sleep(900);

    const saved = await p.evaluate(() => ({
      keyField: document.querySelector('#llm-key').value,
      lsKey: (function () { try { return localStorage.getItem('swarmsite.cfg.v1') || ''; } catch (e) { return 'x'; } })(),
      hint: document.querySelector('#llm-hint').textContent
    }));
    ok('保存后输入框不再留着 Key', saved.keyField === '', 'keyField=' + saved.keyField);
    ok('浏览器 localStorage 里没有 Key', saved.lsKey.indexOf('sk-gateway') < 0, saved.lsKey.slice(0, 80));
    ok('提示文案说明 Key 存在本机接口', /本机接口/.test(saved.hint), saved.hint);

    const conf = fs.existsSync(CONF) ? fs.readFileSync(CONF, 'utf8') : '';
    ok('Key 写进了项目里的 .llm.json', conf.indexOf('sk-gateway-987654321') >= 0, conf.slice(0, 80));
    ok('接口只回传脱敏尾号', conf.indexOf('987654321') >= 0);

    console.log('\n=== 3. 刷新后不用重填 ===');
    await p.reload({ waitUntil: 'load' });
    await p.click('#advanced');
    await p.click('#tab-llm');
    await sleep(600);
    const afterReload = await p.evaluate(() => ({
      hasKey: !!document.querySelector('#llm-key').placeholder.match(/已存在本机接口/),
      mode: document.querySelector('#llm-mode').value,
      status: document.querySelector('#gw-status').className,
      url: document.querySelector('#llm-url').value
    }));
    ok('刷新后仍是 API 模式', afterReload.mode === 'api', JSON.stringify(afterReload));
    ok('Key 输入框提示"已存在本机接口"', afterReload.hasKey, JSON.stringify(afterReload));
    ok('地址从本机接口自动补回', /18093/.test(afterReload.url), afterReload.url);

    console.log('\n=== 4. 测试连接与生成 ===');
    await p.click('#test-llm');
    await sleep(1200);
    const testStatus = await p.evaluate(() => document.querySelector('#status').textContent);
    ok('测试连接成功并显示上游地址', /连接成功/.test(testStatus) && /18093/.test(testStatus), testStatus);

    await p.evaluate(() => { document.querySelector('#prompt').value = '做一个 AI 写作工具的落地页'; });
    await p.click('#build');
    await sleep(1800);
    const built = await p.evaluate(() => ({
      blocks: document.querySelectorAll('#page .blk').length,
      hasTitle: [].slice.call(document.querySelectorAll('#page .blk')).some((e) => e.getAttribute('data-text') === '接口写的标题'),
      engine: !!window.__swarmEngine,
      status: document.querySelector('#status').textContent
    }));
    ok('流式返回的蓝图直接建出页面', built.blocks >= 5 && built.hasTitle, JSON.stringify(built));
    ok('施工引擎已启动', built.engine);

    console.log('\n=== 5. 一句话改页面 ===');
    await p.click('#tab-patch');
    await sleep(200);
    const patchUi = await p.evaluate(() => ({
      visible: !document.querySelector('#pane-patch').hidden,
      chips: document.querySelectorAll('[data-chip]').length
    }));
    ok('改页面页签可用、快捷短语存在', patchUi.visible && patchUi.chips >= 6, JSON.stringify(patchUi));

    await p.click('[data-chip="把主标题改得更有吸引力，一句话说清卖点"]');
    const chipVal = await p.evaluate(() => document.querySelector('#patch-input').value);
    ok('点快捷短语会填进输入框', /主标题/.test(chipVal), chipVal);

    await p.click('#patch-go');
    await sleep(2200);
    const patched = await p.evaluate(() => ({
      hasNew: [].slice.call(document.querySelectorAll('#page .blk')).some((e) => e.getAttribute('data-text') === '改过的标题'),
      result: document.querySelector('#patch-result').textContent,
      log: document.querySelector('#patch-log').textContent,
      input: document.querySelector('#patch-input').value,
      blocks: document.querySelectorAll('#page .blk').length
    }));
    ok('模型改过的标题生效并重新施工', patched.hasNew, JSON.stringify(patched).slice(0, 200));
    ok('给出差异摘要（新增 1 块）', /新增 1 块/.test(patched.result), patched.result);
    ok('改动记录里留下这一条', /主标题/.test(patched.log), patched.log.slice(0, 80));
    ok('改完清空输入框', patched.input === '');

    await p.click('#patch-undo');
    await sleep(900);
    const undone = await p.evaluate(() => [].slice.call(document.querySelectorAll('#page .blk')).some((e) => e.getAttribute('data-text') === '接口写的标题'));
    ok('撤销能回到改之前的版本', undone);

    console.log('\n=== 6. 错误要说人话 ===');
    await httpJson({ host: '127.0.0.1', port: PORT, path: '/api/llm/config', method: 'DELETE' });
    await p.evaluate(() => { document.querySelector('#llm-key').value = ''; });
    await p.reload({ waitUntil: 'load' });
    await p.click('#advanced');
    await p.click('#tab-llm');
    await sleep(500);
    // 指向一个真实的公网地址、但 Key 已被清掉 → 应该在发请求之前就拦住
    await p.evaluate(() => {
      document.querySelector('#llm-key').value = '';
      document.querySelector('#llm-url').value = 'https://api.deepseek.com/v1';
    });
    await p.click('#test-llm');
    await sleep(1000);
    const errStatus = await p.evaluate(() => document.querySelector('#status').textContent);
    ok('没有 Key 时提示明确、可操作', /缺少 API Key/.test(errStatus), errStatus);

    upMode = '500';
    await p.evaluate((u) => {
      document.querySelector('#llm-key').value = 'sk-gateway-987654321';
      document.querySelector('#llm-url').value = u;
    }, 'http://127.0.0.1:' + UPPORT + '/v1');
    await p.click('#test-llm');
    await sleep(1200);
    const err500 = await p.evaluate(() => document.querySelector('#status').textContent);
    ok('上游 500 会带状态码和人话', /HTTP 500/.test(err500) && /炸了/.test(err500), err500);

    ok('全程零运行时错误', errs.length === 0, errs.join(' | '));

    await p.screenshot({ path: path.join(__dirname, 'shot-gateway.png'), clip: { x: 0, y: 0, width: 1440, height: 470 } });
  } finally {
    if (browser) await browser.close();
    try { gw.kill(); } catch (e) {}
    upstream.close();
    try { fs.unlinkSync(CONF); } catch (e) {}
  }

  console.log('\n通过 ' + pass + '，失败 ' + fail);
  if (fail) console.log('失败清单：' + fails.join(' / '));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试崩了：', e);
  try { upstream.close(); } catch (_) {}
  process.exit(2);
});
