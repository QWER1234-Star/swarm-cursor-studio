/* 并行生成：把「写页面结构」这件活派给 DeepSeek，多路并发
 * 提示词从 compiler.js 现读，保证和线上完全一致（不手抄）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'inbox', 'A-html');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, '.llm.json'), 'utf8'));
const BASE = (cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const MODEL = cfg.model || 'deepseek-chat';
const KEY = cfg.apiKey;

const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'compiler.js'), 'utf8'), ctx);
const C = ctx.window.BlueprintCompiler;

const CASES = [
  { tag: '01-美甲', prompt: '做一个高端美甲店的预约页', seed: 1 },
  { tag: '02-AI写作', prompt: '做一个 AI 写作工具的落地页' },
  { tag: '03-瑜伽', prompt: '做一个社区瑜伽课的招生页' },
  { tag: '04-摄影', prompt: '做一个独立摄影师的个人主页' },
  { tag: '05-咖啡', prompt: '做一个精品咖啡店的官网' },
  { tag: '06-宠物殡葬', prompt: '做一个宠物殡葬服务的介绍页' },
  { tag: '07-设备租赁', prompt: '做一个工业设备租赁的公司页，客户是工厂厂长' },
  { tag: '08-美甲再跑', prompt: '做一个高端美甲店的预约页', seed: 7 }
];

const CONCURRENCY = 1;
const SKIP_EXISTING = true;

async function callOnce(item, attempt) {
  const prompt = C.buildPrompt(item.prompt, { seed: item.seed || 0 });
  const body = {
    model: MODEL,
    temperature: 0.85,
    max_tokens: 3200,
    messages: [
      { role: 'system', content: '你是网页结构设计师。只输出 HTML 片段，不要解释，不要 markdown 围栏，不要写任何 CSS。' },
      { role: 'user', content: prompt }
    ]
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body)
    });
  } catch (e) {
    if (attempt < 2) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); return callOnce(item, attempt + 1); }
    throw new Error(e.message);
  }
  const text = await res.text();
  if (!res.ok) {
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      await new Promise(r => setTimeout(r, 2500 * (attempt + 1)));
      return callOnce(item, attempt + 1);
    }
    throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200));
  }
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('返回不是 JSON'); }
  let content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  const usage = j.usage || {};
  const html = C.extractHTML(content);
  const isHtml = C.looksLikeHTML(html);
  const clean = {
    tag: item.tag, prompt: item.prompt, model: MODEL,
    secs: ((Date.now() - t0) / 1000).toFixed(1),
    chars: html.length, isHtml,
    tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
  };
  const name = item.tag + (isHtml ? '' : '.bad') + '.html';
  fs.writeFileSync(path.join(OUT, name), html, 'utf8');
  return clean;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // 不清理，已存在的会跳过
  console.log('提示词长度', C.buildPrompt('x', {}).length, '字符 · 模型', MODEL);
  console.log('并发', CONCURRENCY, '· 共', CASES.length, '个任务\n');

  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < CASES.length) {
      const item = CASES[idx++];
      const exist = path.join(OUT, item.tag + '.html');
      if (SKIP_EXISTING && fs.existsSync(exist) && fs.statSync(exist).size > 500) { console.log('  · ' + item.tag + ' 已存在，跳过'); results.push({tag:item.tag, skipped:true}); continue; }
      try {
        const r = await callOnce(item, 0);
        results.push(r);
        console.log('  ✓ ' + r.tag + '  ' + r.secs + 's  ' + r.chars + '字符  ' +
          (r.isHtml ? 'HTML' : '✗ 不像 HTML') + '  ' + r.tokens + ' tokens');
      } catch (e) {
        results.push({ tag: item.tag, error: e.message });
        console.log('  ✗ ' + item.tag + '  ' + e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ok = results.filter(r => r.isHtml).length;
  const tok = results.reduce((a, r) => a + (r.tokens || 0), 0);
  fs.writeFileSync(path.join(OUT, '_meta.json'), JSON.stringify(results, null, 1), 'utf8');
  console.log('\n完成 ' + ok + '/' + results.length + ' · 合计 ' + tok + ' tokens');
  if (tok) console.log('按 DeepSeek 定价约 ¥' + (tok / 1000000 * 2).toFixed(3) + '（粗算）');
})();
