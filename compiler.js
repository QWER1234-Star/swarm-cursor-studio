/* =============================================================================
 * compiler.js —— 把「模型写的 HTML」编译成「施工蓝图」
 *
 * 为什么要有这一层：
 *   原来的契约是让模型直接吐绝对坐标（x/y/w/h）。模型于是把大半注意力花在
 *   算像素、防重叠上，结果不管什么行业，排出来都是同一套骨架。
 *   这里换一层契约：模型只写结构和文案，**排版权交给浏览器的 CSS**；
 *   我们在隐藏 iframe 里把它渲染出来，用 getBoundingClientRect 量出每块的
 *   真实位置和尺寸，再编译回原来的蓝图格式。
 *   于是施工动画、边建边点、可交互层、导出单文件全部照旧复用。
 *
 * 安全边界：
 *   - iframe 用 sandbox="allow-same-origin"（刻意不给 allow-scripts），模型就算
 *     塞了 <script> 也不会执行；
 *   - HTML 先过白名单清洗，只保留结构标签，属性只留 class / data-action /
 *     data-value / href；
 *   - 不加载任何外部图片：图片位统一用 <div class="media">，由本地配图。
 * ========================================================================== */
window.BlueprintCompiler = (function () {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 设计系统：一套预置 CSS
   * 模型不写样式，只从下面的 class 里挑。于是「排版质量」由这里保证，
   * 「结构与文案」由模型决定 —— 这是这个方案能稳定的根本原因。
   * ------------------------------------------------------------------------- */
  var LAYOUT_CSS = [
    '*{box-sizing:border-box;margin:0;padding:0}',
    'html{ -webkit-text-size-adjust:100% }',
    'body{width:1200px;overflow-x:hidden;background:#fff;color:#16181d;',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;',
    '  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
    'img{display:block;max-width:100%}',
    'a{color:inherit;text-decoration:none}',
    'button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}',
    'ul{list-style:none}',

    /* 通用容器 */
    '.wrap{padding-left:80px;padding-right:80px}',
    '.section{display:block}',

    /* ---------- 导航 ---------- */
    '.nav{display:flex;align-items:center;justify-content:space-between;padding:30px 80px 26px}',
    '.brand{font-size:22px;font-weight:700;letter-spacing:-.02em}',
    '.nav-links{display:flex;gap:38px;font-size:15px;color:#5b616e}',
    '.nav-links a{color:inherit}',

    /* ---------- 首屏：三选一 ---------- */
    '.hero{display:grid;grid-template-columns:1fr 452px;gap:72px;align-items:center;padding:64px 80px 104px}',
    '.hero-copy{align-self:center}',
    '.hero-copy .media{margin-top:36px}',
    '.hero-center{text-align:center;padding:104px 190px 92px}',
    '.hero-center .lead{margin-left:auto;margin-right:auto}',
    '.hero-center .btn-row{justify-content:center}',
    '.hero-full{position:relative;height:640px;display:flex;align-items:flex-end;padding:0 80px 78px}',
    '.hero-full::before{content:"";position:absolute;inset:0;z-index:1;',
    '  background:linear-gradient(180deg,rgba(10,14,22,0) 26%,rgba(10,14,22,.78) 100%)}',
    '.hero-full>.media,.hero-full>.media-wide,.hero-full>.media-tall{position:absolute;inset:0;border-radius:0;z-index:0;aspect-ratio:auto;min-height:0}',
    '.hero-full>.wrap{padding-left:0;padding-right:0}',
    '.hero-full .hero-copy{position:relative;z-index:2;max-width:660px;color:#fff}',
    '.hero-full .lead{color:rgba(255,255,255,.8)}',
    '.hero-full .eyebrow{color:rgba(255,255,255,.72)}',

    /* ---------- 文案层级 ---------- */
    '.eyebrow{font-size:13px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:#8a91a0}',
    '.h1{font-size:66px;line-height:1.05;font-weight:800;letter-spacing:-.035em;margin-top:18px}',
    '.h2{font-size:42px;line-height:1.12;font-weight:800;letter-spacing:-.025em}',
    '.h3{font-size:20px;line-height:1.35;font-weight:700}',
    '.lead{font-size:19px;line-height:1.62;color:#5b616e;margin-top:22px;max-width:540px}',
    '.lead-sm{font-size:16px;line-height:1.65;color:#5b616e;margin-top:12px}',
    '.muted{color:#8a91a0;font-size:14px;line-height:1.6}',
    '.btn-row{display:flex;gap:14px;margin-top:36px;align-items:center}',

    /* ---------- 按钮 ---------- */
    '.btn{display:inline-flex;align-items:center;justify-content:center;height:54px;padding:0 30px;',
    '  border-radius:11px;background:#16181d;color:#fff;font-size:16px;font-weight:600;white-space:nowrap}',
    '.btn-primary{background:#2b7cff;color:#fff}',
    '.btn-ghost{background:transparent;color:#16181d;border:1px solid #d3d8e0}',
    '.hero-full .btn-ghost{color:#fff;border-color:rgba(255,255,255,.45)}',

    /* ---------- 图片位 ---------- */
    '.media{width:100%;aspect-ratio:4/3;min-height:70px;background:#e9edf4;border-radius:18px}',
    '.media-wide{width:100%;aspect-ratio:16/6.5;min-height:70px;background:#e9edf4;border-radius:18px}',
    '.media-tall{width:100%;aspect-ratio:3/4;min-height:70px;background:#e9edf4;border-radius:18px}',

    /* ---------- 区块与网格 ---------- */
    '.features{padding:96px 80px 40px}',
    '.section-head{max-width:640px;margin-bottom:44px}',
    '.section-head.ctr{max-width:none;text-align:center;margin-bottom:48px}',
    '.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:28px}',
    '.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}',
    '.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:22px}',

    /* ---------- 卡片 ---------- */
    '.card{background:#f7f8fa;border:1px solid #ecedf2;border-radius:20px;padding:26px}',
    '.card .media{aspect-ratio:16/10;margin-bottom:20px;border-radius:14px}',
    '.card .h3{margin-bottom:8px}',
    '.card p{font-size:15px;line-height:1.65;color:#5b616e}',
    '.card-plain{background:#fff;border:1px solid #ecedf2}',

    /* ---------- 数据 ---------- */
    '.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:40px;padding:72px 80px 96px}',
    '.stat-num{font-size:54px;line-height:1;font-weight:800;letter-spacing:-.035em}',
    '.stat-label{font-size:15px;color:#5b616e;margin-top:10px}',

    /* ---------- 引言 ---------- */
    '.quote{padding:96px 170px;text-align:center}',
    '.quote p{font-size:29px;line-height:1.48;font-weight:600;letter-spacing:-.015em}',
    '.quote .by{margin-top:26px;font-size:15px;color:#8a91a0}',

    /* ---------- 价格 ---------- */
    '.pricing{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:96px 80px 40px}',
    '.plan{border:1px solid #e5e7ee;border-radius:20px;padding:32px}',
    '.plan.hot{border-color:#2b7cff;background:#f5f9ff}',
    '.plan .tier{font-size:15px;font-weight:700;letter-spacing:.04em;color:#5b616e}',
    '.plan .price{font-size:46px;line-height:1;font-weight:800;letter-spacing:-.03em;margin:16px 0 6px}',
    '.plan .price em{font-size:16px;font-weight:600;font-style:normal;color:#8a91a0}',
    '.plan ul{margin-top:22px;border-top:1px solid #eceef3}',
    '.plan li{padding:11px 0;border-bottom:1px solid #f2f3f6;font-size:15px;color:#5b616e}',
    '.plan .btn{width:100%;margin-top:24px}',

    /* ---------- CTA 条 ---------- */
    '.cta{margin:96px 80px 0;background:#16181d;border-radius:24px;padding:66px 60px;',
    '  display:flex;align-items:center;justify-content:space-between;gap:48px}',
    '.cta .h2{color:#fff}',
    '.cta .lead-sm{color:rgba(255,255,255,.72)}',
    '.cta .btn-primary{flex:none}',

    /* ---------- 页脚 ---------- */
    '.footer{margin-top:80px;padding:54px 80px 74px;border-top:1px solid #eceef3;',
    '  display:flex;justify-content:space-between;align-items:flex-start;gap:40px}',
    '.footer .foot-links{display:flex;gap:30px;font-size:14px;color:#5b616e}',
    '.contact-line{margin-top:26px;font-size:14px;font-weight:600;color:#2b7cff}'
  ].join('\n');

  /* 给模型看的 class 清单（同时也是白名单的一部分） */
  var CLASS_DOC = [
    '布局：wrap（左右留白容器）',
    '导航：nav、brand、nav-links',
    '首屏（三选一）：hero（左文右图两列）、hero-center（居中单列）、hero-full（整屏大图+遮罩文字）；配套 hero-copy、eyebrow、h1、lead、btn、btn-primary、btn-ghost、btn-row',
    '区块：features、quote、pricing、stats、cta、footer',
    '网格：grid-2、grid-3、grid-4',
    '卡片：card、card-plain、plan（可选 hot）、tier、price',
    '图片位：media、media-wide、media-tall（只写空 div，不要 src）',
    '文字：h2（区块标题）、h3（卡片标题）、lead（说明）、lead-sm、muted、stat-num、stat-label、section-head（可选 ctr）、contact-line、foot-links'
  ].join('\n');

  var ALLOWED_TAGS = {
    DIV: 1, SECTION: 1, SPAN: 1, P: 1, H1: 1, H2: 1, H3: 1, H4: 1,
    A: 1, UL: 1, OL: 1, LI: 1, EM: 1, STRONG: 1, B: 1, I: 1, BR: 1, SMALL: 1,
    NAV: 1, HEADER: 1, FOOTER: 1, MAIN: 1, ARTICLE: 1, ASIDE: 1,
    BLOCKQUOTE: 1, FIGURE: 1, FIGCAPTION: 1, HR: 1, DL: 1, DT: 1, DD: 1, TIME: 1,
    BUTTON: 1
  };
  /* 整段丢掉的标签：不会有可见内容，或者会带来安全/交互问题的 */
  var DROP_TAGS = 'script,style,iframe,object,embed,link,meta,base,svg,canvas,video,audio,form,input,textarea,select,source,picture,noscript';
  var ALLOWED_ATTR = { class: 1, 'data-action': 1, 'data-value': 1, href: 1, 'aria-label': 1 };

  /* ---------------- HTML 清洗：白名单，只留结构与少量 data 属性 ---------------- */
  function sanitize(raw) {
    var box = document.createElement('div');
    box.innerHTML = String(raw || '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // 1) 整段删掉危险/无意义标签（含内容）
    var drops = box.querySelectorAll(DROP_TAGS);
    for (var k = drops.length - 1; k >= 0; k--) {
      if (drops[k].parentNode) drops[k].parentNode.removeChild(drops[k]);
    }

    // 2) 不认识的标签：**展开**（保留子节点）而不是拍成一段文字
    //    早期版本把 <nav> 拍平，导致整个页面被外层容器吞成一个文本块
    var all = box.querySelectorAll('*');
    for (var i = all.length - 1; i >= 0; i--) {
      var el = all[i];
      if (ALLOWED_TAGS[el.tagName]) continue;
      var parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }

    // 3) 属性白名单 + 链接协议检查
    var rest = box.querySelectorAll('*');
    for (var n = 0; n < rest.length; n++) {
      var node = rest[n];
      var attrs = [].slice.call(node.attributes);
      for (var j = 0; j < attrs.length; j++) {
        var name = attrs[j].name.toLowerCase();
        if (!ALLOWED_ATTR[name]) { node.removeAttribute(attrs[j].name); continue; }
        if (name === 'href') {
          var hv = String(node.getAttribute('href') || '').trim();
          if (/^(javascript|data|vbscript):/i.test(hv.replace(/[\s\u0000-\u001f]/g, ''))) {
            node.removeAttribute('href');
          }
        }
      }
    }
    return box.innerHTML;
  }

  /* ---------------- 在隐藏 iframe 里渲染并测量 ---------------- */
  function renderAndMeasure(html) {
    return new Promise(function (resolve, reject) {
      var frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-same-origin');   // 刻意不给 allow-scripts
      frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:900px;border:0;visibility:hidden';
      var doc =
        '<!doctype html><html><head><meta charset="utf-8"><style>' + LAYOUT_CSS + '</style></head><body>' +
        html + '</body></html>';
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; cleanup(); reject(new Error('渲染超时')); } }, 8000);

      function cleanup() {
        try { frame.remove(); } catch (_) {}
      }

      frame.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          var d = frame.contentDocument;
          if (!d || !d.body) throw new Error('无法读取渲染结果');
          // 让字体就绪再量，避免字体替换导致尺寸偏差
          var ready = (d.fonts && d.fonts.ready) ? d.fonts.ready : Promise.resolve();
          ready.then(function () {
            setTimeout(function () {
              try {
                var out = collect(d);
                cleanup();
                resolve(out);
              } catch (e) {
                cleanup();
                reject(e);
              }
            }, 60);
          });
        } catch (e) {
          cleanup();
          reject(e);
        }
      };
      frame.srcdoc = doc;
      document.body.appendChild(frame);
    });
  }

  /* ---------------- 采集：DOM → 块 ---------------- */
  function collect(doc) {
    var win = doc.defaultView;
    var blocks = [];
    var uid = 0;

    function push(b) {
      b.id = 'c' + (++uid);
      b.z = uid;                       // DOM 顺序即绘制顺序，后出现的在上
      blocks.push(b);
      return b;
    }

    function alphaOf(color) {
      if (!color) return 0;
      var m = /rgba?\(([^)]+)\)/.exec(color);
      if (!m) return /transparent/i.test(color) ? 0 : 1;
      var p = m[1].split(',');
      return p.length > 3 ? parseFloat(p[3]) : 1;
    }

    function hasFill(cs) {
      if (alphaOf(cs.backgroundColor) > 0.02) return true;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
      if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && alphaOf(cs.borderTopColor) > 0.02) return true;
      if (cs.boxShadow && cs.boxShadow !== 'none') return true;
      return false;
    }

    function ownTextLen(el) {
      var s = '';
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3) s += n.textContent;
      }
      return s.replace(/\s+/g, '').length;
    }

    function boxOf(el, cs) {
      var r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height)
      };
    }

    function radiusOf(cs) {
      var r = cs.borderRadius;
      if (!r || r === '0px') return null;
      return r.split('/')[0].trim();
    }

    function shadowOf(cs) {
      return (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : null;
    }

    function alignOf(cs) {
      var jc = cs.justifyContent || '';
      var ai = cs.alignItems || '';
      var align = 'left';
      if (cs.textAlign === 'center' || jc === 'center') align = 'center';
      else if (cs.textAlign === 'right' || jc === 'flex-end') align = 'right';
      var valign = (ai === 'center' || jc === 'center') ? 'center' : 'flex-start';
      return { align: align, valign: valign };
    }

    function labelOf(el) {
      var cls = ' ' + (el.className || '') + ' ';
      var tag = el.tagName;
      if (/ btn /.test(cls) || (tag === 'A' && / btn/.test(cls))) return 'button';
      if (el.closest && el.closest('.nav')) return 'nav link';
      if (el.closest && el.closest('.footer')) return 'footer link';
      if (/ contact-line /.test(cls)) return 'contact line';
      if (tag === 'A') return 'text link';
      if (/ h1 /.test(cls)) return 'headline';
      if (/ h2 /.test(cls)) return 'section title';
      return '';
    }

    function actionOf(el) {
      var a = (el.getAttribute && el.getAttribute('data-action') || '').toLowerCase();
      if (!/^(wechat|tel|mailto|link)$/.test(a)) return null;
      return { action: a, actionValue: el.getAttribute('data-value') || '' };
    }

    function walk(el, parentCls) {
      if (!el || el.nodeType !== 1) return;
      var cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;

      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;

      var cls = ' ' + (el.className || '') + ' ';
      var base = boxOf(el, cs);

      /* 图片位 */
      if (/\bmedia(-wide|-tall)?\b/.test(cls) || el.tagName === 'IMG') {
        var isHero = / hero /.test(cls) || (el.parentElement && / hero /.test(' ' + el.parentElement.className + ' '));
        push({
          type: 'image', x: base.x, y: base.y, w: base.w, h: base.h,
          style: (radiusOf(cs) ? { borderRadius: radiusOf(cs) } : {}),
          image: 'photo',
          imageFallback: 'linear-gradient(135deg,#e2e7f0,#aab4c6)',
          label: isHero ? 'hero image' : 'image'
        });
        return;
      }

      var ownLen = ownTextLen(el);
      // 纯文本叶子直接当一块；有元素子节点时，只有自带文字够多才当正文，
      // 否则继续往下拆 —— 否则一个外层容器会把整页吞成一块（摄影站就踩过）
      var txt = ownLen > 0 && (el.children.length === 0 || ownLen >= 12);
      var fill = hasFill(cs);
      var act = actionOf(el);
      var gaveAction = false;
      var isCard = / card /.test(cls) || / plan /.test(cls);

      /* 有背景的盒子：先出一层 rect（卡片、按钮、CTA 条、遮罩都在这里） */
      if (fill) {
        var st = {};
        if (alphaOf(cs.backgroundColor) > 0.02) st.background = cs.backgroundColor;
        else if (cs.backgroundImage && cs.backgroundImage !== 'none') st.background = cs.backgroundImage;
        if (radiusOf(cs)) st.borderRadius = radiusOf(cs);
        if (shadowOf(cs)) st.boxShadow = shadowOf(cs);
        if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && alphaOf(cs.borderTopColor) > 0.02) {
          st.border = cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor;
        }
        var rect = {
          type: 'rect', x: base.x, y: base.y, w: base.w, h: base.h, style: st,
          label: isCard ? 'card' : (/ btn /.test(cls) ? 'button' : '')
        };
        if (act) { rect.action = act.action; rect.actionValue = act.actionValue; gaveAction = true; }
        push(rect);

        /* 卡片的可点区域：整张卡可点（引导到 CTA），和原来一致 */
        if (isCard) rect.role = 'card';
      }

      /* 文本 */
      if (txt) {
        var padL = parseFloat(cs.paddingLeft) || 0;
        var padR = parseFloat(cs.paddingRight) || 0;
        var padT = parseFloat(cs.paddingTop) || 0;
        var padB = parseFloat(cs.paddingBottom) || 0;
        var tx = base.x + padL;
        var ty = base.y + padT;
        var tw = Math.max(4, base.w - padL - padR);
        var th = Math.max(4, base.h - padT - padB);

        var ts = {
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          color: cs.color
        };
        if (cs.lineHeight && cs.lineHeight !== 'normal') ts.lineHeight = cs.lineHeight;
        if (cs.letterSpacing && cs.letterSpacing !== 'normal') ts.letterSpacing = cs.letterSpacing;

        var al = alignOf(cs);
        var textContent = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (textContent) {
          var tb = {
            type: 'text', x: Math.round(tx), y: Math.round(ty),
            w: Math.round(tw), h: Math.round(th), style: ts,
            text: textContent, align: al.align, valign: al.valign,
            label: labelOf(el)
          };
          if (act && !gaveAction) { tb.action = act.action; tb.actionValue = act.actionValue; }
          push(tb);
        }
        return;   // 文字整体当一个块，不再往下拆
      }

      /* 无文字的容器：递归 */
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], cls);
    }

    var body = doc.body;
    var bodyCs = win.getComputedStyle(body);
    var bg = bodyCs.backgroundColor;

    for (var i = 0; i < body.children.length; i++) {
      walk(body.children[i], '');
    }

    if (!blocks.length) throw new Error('这份 HTML 没有渲染出任何可见内容');

    /* 整屏首屏的遮罩：CSS 里那层是 ::before 伪元素，采不到块，
       但编译产物是独立块渲染的，没有它白字会压在浅色照片上看不清 —— 补一个。 */
    var heroIdx = -1;
    for (var hi = 0; hi < blocks.length; hi++) {
      var bb = blocks[hi];
      if (bb.type === 'image' && bb.w >= 1000 && bb.y < 400) { heroIdx = hi; break; }
    }
    if (heroIdx >= 0) {
      var hero = blocks[heroIdx];
      blocks.splice(heroIdx + 1, 0, {
        id: 'c' + (++uid), type: 'rect',
        x: hero.x, y: hero.y, w: hero.w, h: hero.h, z: 0,
        style: { background: 'linear-gradient(180deg,rgba(10,14,22,0) 26%,rgba(10,14,22,.78) 100%)' },
        label: 'hero overlay'
      });
    }

    /* z 统一按数组顺序重排成整数：数组顺序 = DOM 顺序 = 绘制顺序，
       比散落的递增值和 1.5 这类小数更可靠（遮罩就靠它盖在图上、垫在字下）。 */
    blocks.forEach(function (b, i) { b.z = i + 1; });

    /* ---- 施工依赖：按纵向分段，段间串行、段内并行 ---- */
    var sorted = blocks.slice().sort(function (a, b) {
      return (a.y - b.y) || (a.x - b.x);
    });
    var seg = -1;
    var prevBottom = -1e9;
    var lastInSeg = {};
    sorted.forEach(function (b) {
      if (b.type === 'guide') return;
      if (b.y - prevBottom > 60) { seg++; lastInSeg[seg] = null; }
      if (lastInSeg[seg]) {
        b.deps = [lastInSeg[seg]];
      } else if (seg > 0 && lastInSeg[seg - 1]) {
        b.deps = [lastInSeg[seg - 1]];
      }
      lastInSeg[seg] = b.id;
      prevBottom = Math.max(prevBottom, b.y + b.h);
    });

    /* ---- 画布高度 ---- */
    var maxBottom = 0;
    blocks.forEach(function (b) { maxBottom = Math.max(maxBottom, b.y + b.h); });
    var height = Math.min(6000, maxBottom + 64);

    /* ---- 标题：字号最大的那段文字 ---- */
    var title = '';
    var biggest = 0;
    blocks.forEach(function (b) {
      if (b.type !== 'text') return;
      var fs = parseFloat(b.style.fontSize) || 0;
      if (fs > biggest) { biggest = fs; title = b.text; }
    });

    return {
      html: '',
      meta: {
        title: (title || '未命名站点').slice(0, 40),
        width: 1200,
        height: height,
        bg: (alphaOf(bg) > 0.02 ? bg : '#ffffff'),
        contact: '',
        ctaAction: 'wechat',
        ctaValue: '',
        layout: 'compiled'
      },
      blocks: blocks,
      _stats: { blocks: blocks.length, height: height }
    };
  }

  /* ---------------- 对外：编译 ---------------- */
  function compile(html, opts) {
    opts = opts || {};
    var clean = sanitize(html);
    if (!/<[a-z]/i.test(clean)) {
      return Promise.reject(new Error('这段内容里没有 HTML 结构'));
    }
    return renderAndMeasure(clean).then(function (bp) {
      if (opts.assets) bp.assets = opts.assets;
      var err = window.BlueprintGen && window.BlueprintGen.validate
        ? window.BlueprintGen.validate(bp) : null;
      if (err) throw new Error('编译出的蓝图不合法：' + err);
      return bp;
    });
  }

  /* 首屏原型：不指望模型自己"三选一" —— 实测 DeepSeek 8 次全选左文右图。
     改成按行业给候选，再按 seed 在候选里挑，于是同一句话多次生成也会换版式。 */
  var HERO_DESC = {
    hero: '左文右图两列：左边文案、右边一张竖图',
    'hero-center': '居中单列：文字全部居中，左右留白很大，不放首屏大图',
    'hero-full': '整屏大图：一个 media 铺满整个首屏（高约 640px），文字压在图片左下角的深色遮罩上，文字用白色'
  };
  var HERO_RULES = [
    { re: /摄影|餐饮|咖啡|餐厅|酒吧|活动|演出|音乐节|展览|酒店|民宿|旅行|空间|建筑|服装|花店|艺术展/, cand: ['hero-full', 'hero'] },
    { re: /个人|作品集|博客|工作室|设计|艺术|画室|写作|独立|简历|名片/, cand: ['hero-center', 'hero-full'] },
    { re: /瑜伽|健身|课程|招生|培训|教育|社群|冥想|舞蹈/, cand: ['hero-center', 'hero'] },
    { re: /预约|门店|服务|维修|美甲|理发|宠物|诊所|搬家|开锁|清洁|装修|月嫂/, cand: ['hero', 'hero-full'] }
  ];
  function pickHero(text, seed) {
    var s = String(text || '');
    var cand = ['hero', 'hero-center', 'hero-full'];
    for (var i = 0; i < HERO_RULES.length; i++) {
      if (HERO_RULES[i].re.test(s)) { cand = HERO_RULES[i].cand; break; }
    }
    var n = Number(seed) || 0;
    var k = Math.abs((n ^ (n >>> 13)) + s.length) % cand.length;
    return cand[k];
  }

  /* ---------------- 给模型的提示词 ---------------- */
  function buildPrompt(userPrompt, opts) {
    opts = opts || {};
    var ask = String(userPrompt || '').trim() || '一个现代感的产品落地页';
    var hero = opts.hero || pickHero(ask + ' ' + (opts.brand || ''), opts.seed || 0);
    var lines = [
      '你在为一个「多光标施工动画」写网页结构：一群光标会照着你写的 HTML 把页面一块块画出来。',
      '',
      '只输出 HTML 片段：不要 <html>/<body>/<style>，不要写任何 CSS，不要解释，不要 markdown 围栏。',
      '只用这些标签：div section span p h1 h2 h3 a ul li em strong br',
      '',
      '可用 class（只能用这些，不要自创）：',
      CLASS_DOC,
      '',
      '规则：',
      '1) 图片一律写成空的 <div class="media"></div>（宽幅用 media-wide，竖图用 media-tall）。不要写 src，不要写 style，程序会配真实照片。',
      '2) 需要点击的元素加 data-action="wechat|tel|mailto|link"，需要值时加 data-value="..."。',
      '3) 文案必须是真实可用的中文：写出具体的卖点、数字、地址、时间、价格，不要「标题一」「示例文本」「lorem」。',
      '4) 不要写 style 属性，不要写行内颜色，样式全部由 class 决定。',
      '5) 本次首屏**必须**用 ' + hero + '：' + (HERO_DESC[hero] || '') + '。不要换成别的首屏写法。',
      '6) 整页 4~6 个区块，整页高度控制在 3400px 以内，块与块之间要有节奏变化（大标题区、卡片区、数据区、CTA 条里挑，不必全用）。',
      '7) 不同行业的页面结构应该明显不同：门店类偏「首屏图 + 服务卡片 + 地址时间」，活动类偏「大图 + 讲者/日程 + 报名」，个人类偏「居中介绍 + 作品网格」，产品类偏「功能网格 + 数据 + 价格」。不要每次都套同一个顺序。',
      '8) 三个卡片的文案要具体且彼此不同，不要三句话一个意思。',
      '9) 卡片区和 pricing 里，每张卡都要放一个 media；整页至少 2 张图，不要做成纯文字页。',
      '',
      '用户需求：' + ask
    ];
    if (opts.brand) lines.push('品牌/店名：' + opts.brand);
    if (opts.contact) lines.push('联系方式（放在 .contact-line 里）：' + opts.contact);
    if (opts.ctaAction) lines.push('主按钮行为：' + opts.ctaAction + (opts.ctaValue ? ' = ' + opts.ctaValue : ''));
    return lines.join('\n');
  }

  /* 粗略判断一段文本是不是 HTML（用来决定走编译器还是走 JSON 修复） */
  function looksLikeHTML(text) {
    var s = String(text || '');
    if (!/</.test(s)) return false;
    var m = s.match(/<\s*(section|div|h1|h2|p|nav|a|ul)\b/i);
    if (!m) return false;
    // 同时出现大量 "x": 说明更可能是带尖括号的 JSON
    var jsonish = (s.match(/"[a-z]+"\s*:/gi) || []).length;
    var tagish = (s.match(/<\s*\/?[a-z]/gi) || []).length;
    return tagish > jsonish;
  }

  function extractHTML(text) {
    var s = String(text || '');
    s = s.replace(/^\uFEFF/, '');
    // 去掉 ```html 围栏
    s = s.replace(/```[a-z]*\s*/gi, '').replace(/```/g, '');
    // 若模型给了完整文档，取 body 内容
    var body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(s);
    if (body) s = body[1];
    return s.trim();
  }

  return {
    LAYOUT_CSS: LAYOUT_CSS,
    CLASS_DOC: CLASS_DOC,
    compile: compile,
    sanitize: sanitize,
    buildPrompt: buildPrompt,
    pickHero: pickHero,
    looksLikeHTML: looksLikeHTML,
    extractHTML: extractHTML,
    _collectFromHTML: function (html) { return renderAndMeasure(sanitize(html)); }
  };
})();
