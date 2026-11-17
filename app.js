/* app.js — 应用外壳：场景/编辑/施工/交互/导出/分享/LLM */
(function(){
  'use strict';
  var $=function(s){return document.querySelector(s);};
  var stage=$('#stage'), zoom=$('#zoom'), page=$('#page'), layer=$('#layer');
  var engine=null, blueprint=null, scale=1, built=false, currentSceneKey=null, currentPrompt='';
  var jsonDirty=false;
  var LS_KEY='swarmsite.cfg.v1';

  function fit(){
    var w=parseInt(page.getAttribute('data-w')||'1200',10);
    var h=parseInt(page.getAttribute('data-h')||'1780',10);
    var avail=stage.clientWidth-40;
    scale=Math.min(1,avail/w);
    zoom.style.width=w+'px';zoom.style.height=h+'px';
    zoom.style.zoom=scale;
    if(engine)engine.setScale(scale);
  }
  function status(s){$('#status').textContent=s;}
  function showExport(v){$('#exportbar').style.display=v?'flex':'none';}
  function showGoLive(v){$('#goLive').style.display=v?'block':'none';}

  /* ---------- CTA 行为：拨号 / 复制微信 / 邮件 / 链接 ---------- */
  function copyText(text,okMsg){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){toast(okMsg||'已复制：'+text);}).catch(function(){fallbackCopy(text,okMsg);});
    } else fallbackCopy(text,okMsg);
  }
  function fallbackCopy(text,okMsg){
    var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';
    document.body.appendChild(ta);ta.select();try{document.execCommand('copy');toast(okMsg||'已复制：'+text);}catch(e){toast('请手动复制：'+text);}document.body.removeChild(ta);
  }
  function toast(msg){
    var t=$('#toast');if(!t){t=document.createElement('div');t.id='toast';document.body.appendChild(t);}
    t.textContent=msg;t.classList.add('show');clearTimeout(t._timer);t._timer=setTimeout(function(){t.classList.remove('show');},2600);
  }
  function bindActions(){
    if(!blueprint) return;
    // 导航滚动 / 卡片引导 / 按钮动作 / 页脚与联系方式，全部由 render 侧统一接管，
    // 导出的单文件调用的是同一个函数，行为不会走样。
    try{ SwarmRender.bind(page,blueprint.meta,{scroller:stage,editable:true}); }catch(e){ console.warn('bind failed',e); }
  }

  /* ==========================================================================
   * 点选编辑：点页面上的任意元素，就地改它的文案 / 颜色 / 字号 / 位置
   *
   * 设计取舍：
   *  - 改的是蓝图（唯一数据源），DOM 用 SwarmRender.paintBlock 重刷那一块，
   *    所以重播施工、导出单文件都自动带上改动，不需要"重新生成"。
   *  - 编辑态用捕获阶段拦掉点击，页面里的导航/按钮不会跳走（它们仍然真实存在）。
   *  - 每步改动前留一份快照，Ctrl+Z 能回退；连续拖滑块合成一步，不会淹没历史。
   * ========================================================================== */
  var EDIT={ on:false, selId:null, undo:[], lastPush:0, inline:false };

  function editCurrent(){
    if(!EDIT.selId||!blueprint) return null;
    var list=blueprint.blocks||[];
    for(var i=0;i<list.length;i++) if(String(list[i].id)===String(EDIT.selId)) return list[i];
    return null;
  }
  function editElOf(id){ return document.getElementById('blk-'+id); }

  function replaceObj(target,src){
    Object.keys(target).forEach(function(k){ delete target[k]; });
    Object.keys(src).forEach(function(k){ target[k]=src[k]; });
    return target;
  }

  function enterEdit(on,quiet){
    on = on!==false;
    if(on&&!blueprint){ status('先「开工」建一次站，再来点选编辑。'); return; }
    if(on===EDIT.on) return;
    EDIT.on=on;
    document.body.classList.toggle('sw-editing',on);
    page.classList.toggle('sw-edit',on);
    $('#btn-edit').classList.toggle('on',on);
    $('#btn-edit').textContent=on?'✓ 完成编辑':'✎ 点选编辑';
    if(!on){
      endInline();
      selectBlock(null);
      if(!quiet) status('已退出编辑。改动都留在蓝图里，重播和导出都会带上。');
      return;
    }
    // 进编辑=直接看成品：施工还没完就先收尾
    if(engine){ try{ engine.finish(); }catch(e){} engine=null; }
    showGoLive(false);showExport(true);
    // 施工镜头一直在往下跟，进编辑先回到首屏，从开头改起
    try{ stage.scrollTo({top:0,behavior:'smooth'}); }catch(e){ stage.scrollTop=0; }
    status('点任意元素开始改 · 双击文字直接输入 · 方向键微调 1px（Shift 10px）· Esc 退出');
  }

  function selectBlock(el){
    var prev=page.querySelector('.blk.sw-sel');
    if(prev) prev.classList.remove('sw-sel');
    if(!el){ EDIT.selId=null; $('#insp').hidden=true; return; }
    var id=String(el.id||'').replace(/^blk-/,'');
    var list=(blueprint&&blueprint.blocks)||[];
    var b=null;
    for(var i=0;i<list.length;i++) if(String(list[i].id)===id) b=list[i];
    if(!b){ EDIT.selId=null; $('#insp').hidden=true; return; }
    EDIT.selId=b.id;
    el.classList.add('sw-sel');
    fillInspector(b);
    positionInspector();
  }

  function positionInspector(){
    var box=$('#insp');
    if(!EDIT.on||!EDIT.selId){ box.hidden=true; return; }
    var el=editElOf(EDIT.selId);
    if(!el){ box.hidden=true; return; }
    box.hidden=false;
    var r=el.getBoundingClientRect();
    var W=box.offsetWidth||278, H=box.offsetHeight||320;
    var vw=window.innerWidth, vh=window.innerHeight;
    var minTop=($('#bar')?$('#bar').getBoundingClientRect().bottom:56)+10;

    var x=r.right+14;
    if(x+W>vw-12) x=r.left-W-14;                       // 右边放不下就翻到左边
    if(x<12) x=Math.min(vw-W-12,Math.max(12,r.left));   // 两边都放不下就压在元素上
    var y=r.top;
    y=Math.min(y,vh-H-16);
    y=Math.max(y,minTop);
    box.style.left=Math.round(x)+'px';
    box.style.top=Math.round(y)+'px';
  }

  /* 把 hex / rgb() 转成 <input type=color> 认的 #rrggbb；认不出返回空串 */
  function toHex(v){
    if(!v) return '';
    var s=String(v).trim();
    var m=/^#([0-9a-f]{3})$/i.exec(s);
    if(m) return '#'+m[1][0]+m[1][0]+m[1][1]+m[1][1]+m[1][2]+m[1][2];
    if(/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    m=/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
    if(m) return '#'+[1,2,3].map(function(i){var n=Math.max(0,Math.min(255,parseInt(m[i],10)));return ('0'+n.toString(16)).slice(-2);}).join('');
    return '';
  }

  var TYPE_CN={text:'文字',rect:'色块',image:'图片',line:'线条',guide:'参考线',duplicate:'复制块'};
  var LABEL_CN={'hero image':'主图','card image':'卡片图','button':'按钮','nav link':'导航项','footer link':'页脚链接',
    'contact line':'联系方式','card master':'卡片','section title':'区块标题','stat number':'数字','cta band':'CTA 区',
    'cta title':'CTA 标题','footer brand':'页脚品牌','float card':'浮卡','hero overlay':'首屏遮罩'};
  function titleFor(b){
    var t=String(b.text||'').replace(/\s+/g,' ').trim();
    if(t) return t.length>18?t.slice(0,18)+'…':t;
    return LABEL_CN[b.label]||b.label||TYPE_CN[b.type]||b.type||'元素';
  }

  function fillInspector(b){
    var st=b.style||{};
    var isText=b.type==='text', isRect=b.type==='rect', isImg=b.type==='image';
    $('#insp-title').textContent=titleFor(b);
    $('#insp-type').textContent=TYPE_CN[b.type]||b.type;

    $('#row-text').hidden=!isText;
    $('#row-font').hidden=!isText;
    $('#row-align').hidden=!isText;
    $('#row-color').hidden=!isText;
    $('#row-fill').hidden=!isRect;
    $('#row-radius').hidden=!(isRect||isImg);
    $('#row-photo').hidden=!isImg;

    if(isText){
      $('#ir-text').value=b.text||'';
      $('#ir-size').value=Math.round(parseFloat(st.fontSize)||0)||'';
      var fw=parseInt(st.fontWeight,10);
      $('#ir-weight').value=String(fw||400);
      var lh=st.lineHeight;
      $('#ir-lh').value=(lh&&!isNaN(parseFloat(lh)))?parseFloat(lh):'';
      $('#ir-color').value=toHex(st.color)||'#111111';
      var al=b.align||(st.justifyContent)||'flex-start';
      [].slice.call($('#ir-align').children).forEach(function(btn){
        btn.classList.toggle('on',btn.getAttribute('data-v')===al);
      });
    }
    if(isRect){
      var hex=toHex(st.background);
      if(hex) $('#ir-fill').value=hex;
      $('#ir-fill-note').textContent=hex?'':(st.background?'当前是渐变/图片背景，改色会覆盖它':'');
    }
    if(isRect||isImg){
      $('#ir-radius').value=Math.round(parseFloat(st.borderRadius)||0);
      $('#ir-opacity').value=st.opacity!=null?Math.max(0.1,Math.min(1,parseFloat(st.opacity)||1)):1;
    }
    $('#ir-x').value=Math.round(b.x||0);
    $('#ir-y').value=Math.round(b.y||0);
    $('#ir-w').value=Math.round(b.w||0);
    $('#ir-h').value=Math.round(b.h||0);
    $('#ir-z').value=Math.round(b.z||1);
  }

  function pushSnap(kind){
    var now=Date.now();
    if(kind!=='all'&&now-EDIT.lastPush<900) return;   // 连续输入/拖滑块合成一步
    EDIT.lastPush=now;
    if(kind==='all'){
      EDIT.undo.push({kind:'all',data:JSON.stringify((blueprint&&blueprint.blocks)||[])});
    }else{
      var b=editCurrent(); if(!b) return;
      EDIT.undo.push({kind:'one',id:b.id,data:JSON.stringify(b)});
    }
    if(EDIT.undo.length>40) EDIT.undo.shift();
  }

  /* 改一块 → 刷一块：DOM、蓝图、内容面板、导出用的 JSON 全部保持同步 */
  function repaintSel(){
    var b=editCurrent(); if(!b) return;
    var el=editElOf(b.id); if(!el) return;
    SwarmRender.paintBlock(el,b,blueprint,true);
    el.classList.remove('pending','rough');
    el.classList.add('sw-sel');
    syncField(b);
    positionInspector();
  }

  function syncField(b){
    if(!b||!b.bind) return;
    var inp=document.querySelector('#edit-fields [data-field="'+b.bind+'"]');
    if(inp&&inp.value!==String(b.text==null?'':b.text)) inp.value=b.text==null?'':b.text;
  }

  function afterChange(){
    if(blueprint) $('#blueprint-json').value=JSON.stringify(blueprint,null,2);
  }

  function mutate(fn,keepPanel){
    var b=editCurrent(); if(!b) return;
    pushSnap('one');
    fn(b,blueprint);
    repaintSel();
    // 用户正在输入时不要回填面板：重设 value 会把光标顶到末尾、还会打断中文输入法
    if(!keepPanel) fillInspector(b);
    afterChange();
  }

  function undoEdit(){
    if(!blueprint) return;
    var snap=EDIT.undo.pop();
    if(!snap){ toast('没有可撤销的改动了'); return; }
    if(snap.kind==='all'){
      blueprint.blocks=JSON.parse(snap.data);
      repaintAll(EDIT.selId);
    }else{
      var b=null,list=blueprint.blocks||[];
      for(var i=0;i<list.length;i++) if(String(list[i].id)===String(snap.id)) b=list[i];
      if(!b){ toast('这块已经被删掉了，撤销不了'); return; }
      replaceObj(b,JSON.parse(snap.data));
      EDIT.selId=b.id;
      selectBlock(editElOf(b.id));   // 切到被撤销的那一块，用户能看见改了什么
      repaintSel();
      fillInspector(b);
    }
    EDIT.lastPush=0;
    afterChange();
    toast('已撤销');
  }

  /* 整页重刷（复制/删除/撤销结构时用），保留当前选中 */
  function repaintAll(keepId){
    SwarmRender.render(blueprint,page);
    (blueprint.blocks||[]).forEach(function(b){
      var el=document.getElementById('blk-'+b.id);
      if(!el) return;
      el.classList.remove('pending','rough');
      SwarmRender.paintBlock(el,b,blueprint,true);
    });
    page.classList.toggle('sw-edit',EDIT.on);
    bindActions();
    selectBlock(keepId?document.getElementById('blk-'+keepId):null);
    afterChange();
  }

  function newBlockId(){
    var n=0;
    (blueprint.blocks||[]).forEach(function(b){ if(/^e\d+$/.test(String(b.id))) n=Math.max(n,parseInt(String(b.id).slice(1),10)||0); });
    return 'e'+(n+1||1);
  }

  function duplicateBlock(){
    var b=editCurrent(); if(!b) return;
    pushSnap('all');
    var copy=JSON.parse(JSON.stringify(b));
    copy.id=newBlockId();
    copy.x=Math.round((b.x||0)+20); copy.y=Math.round((b.y||0)+20);
    copy.z=(b.z||1)+1;
    copy.deps=[];
    if(copy.bind) delete copy.bind;      // 副本别再抢同一个可编辑字段
    var list=blueprint.blocks, i=list.indexOf(b);
    list.splice(i+1,0,copy);
    repaintAll(copy.id);
    toast('已复制一份（Ctrl+Z 撤销）');
  }

  function deleteBlock(){
    var b=editCurrent(); if(!b) return;
    if((blueprint.blocks||[]).length<=1){ toast('这是最后一块，删了就空了'); return; }
    pushSnap('all');
    var id=String(b.id);
    blueprint.blocks=blueprint.blocks.filter(function(x){ return String(x.id)!==id; });
    blueprint.blocks.forEach(function(x){
      if(x.deps) x.deps=x.deps.filter(function(d){ return String(d)!==id; });
    });
    EDIT.selId=null;
    repaintAll(null);
    toast('已删除这一块（Ctrl+Z 撤销）');
  }

  /* 换一张内置照片：按当前图所在的场景组往后轮一个 */
  function nextPhoto(){
    var b=editCurrent(); if(!b||b.type!=='image') return;
    var groups=BlueprintGen.photos||{};
    var cur=/photo-[\w-]+/.exec(String(b.image||''));
    cur=cur?cur[0]:'';
    var group=null,k;
    for(k in groups){ if(groups[k].indexOf(cur)>=0){ group=groups[k]; break; } }
    if(!group){ var keys=Object.keys(groups); group=keys.length?groups[keys[0]]:null; }
    if(!group||!group.length){ toast('没有可切换的内置照片'); return; }
    var next=group[(group.indexOf(cur)+1)%group.length];
    pushSnap('one');
    b.image=BlueprintGen.photoUrl(next,b.w>=560?1400:600);
    repaintSel();fillInspector(b);afterChange();
    toast('换成了组里的下一张');
  }

  function useOwnPhoto(){
    var b=editCurrent(); if(!b||b.type!=='image') return;
    var inp=document.createElement('input');
    inp.type='file'; inp.accept='image/*';
    inp.onchange=function(){
      var f=inp.files&&inp.files[0]; if(!f) return;
      compressImage(f).then(function(r){
        if(!r||!r.dataUrl){ toast('这张图读不出来'); return; }
        pushSnap('one');
        blueprint.assets=blueprint.assets||{};
        var key='u'+Date.now().toString(36);
        blueprint.assets[key]=r.dataUrl;
        b.image='asset:'+key;
        repaintSel();fillInspector(b);afterChange();
        toast('已换成你的图（导出时会一起打进文件）');
      });
    };
    inp.click();
  }

  /* 双击文字 → 就地输入 */
  function startInline(el){
    var b=editCurrent();
    if(!b||b.type!=='text') return;
    var t=el.querySelector('.txt'); if(!t) return;
    endInline();
    EDIT.inline=true;
    t.setAttribute('contenteditable','true');
    t.focus();
    try{
      var r=document.createRange(); r.selectNodeContents(t);
      var sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }catch(e){}
    function commit(){
      var txt=t.textContent.replace(/\u00a0/g,' ');
      if(t.getAttribute('contenteditable')==='true') t.removeAttribute('contenteditable');
      EDIT.inline=false;
      if(txt===(b.text||'')) return;
      pushSnap('one');
      b.text=txt;
      repaintSel();fillInspector(b);afterChange();
    }
    t.addEventListener('blur',commit,{once:true});
    t.addEventListener('keydown',function(ev){
      if(ev.key==='Escape'||(ev.key==='Enter'&&!ev.shiftKey)){ ev.preventDefault(); t.blur(); }
    });
  }
  function endInline(){
    var t=page.querySelector('.txt[contenteditable="true"]');
    if(t) t.blur();
    EDIT.inline=false;
  }

  function editNudge(dx,dy){
    mutate(function(b){
      b.x=Math.max(0,Math.round((b.x||0)+dx));
      b.y=Math.max(0,Math.round((b.y||0)+dy));
    });
  }

  /* ---------- 编辑面板 ---------- */
  var FIELD_DEFS=[
    {k:'brand',label:'品牌 / 名字'},{k:'eyebrow',label:'顶部小字'},
    {k:'title1',label:'大标题·第一行'},{k:'title2',label:'大标题·第二行'},
    {k:'subtitle',label:'副标题段落',area:true},{k:'cta',label:'按钮文字'},
    {k:'nav1',label:'导航1'},{k:'nav2',label:'导航2'},{k:'nav3',label:'导航3'},{k:'nav4',label:'导航4'},
    {k:'feature1t',label:'卡片1·标题'},{k:'feature1b',label:'卡片1·正文',area:true},
    {k:'feature2t',label:'卡片2·标题'},{k:'feature2b',label:'卡片2·正文',area:true},
    {k:'feature3t',label:'卡片3·标题'},{k:'feature3b',label:'卡片3·正文',area:true},
    {k:'stat1n',label:'数字1'},{k:'stat1l',label:'数字1·说明'},
    {k:'stat2n',label:'数字2'},{k:'stat2l',label:'数字2·说明'},
    {k:'stat3n',label:'数字3'},{k:'stat3l',label:'数字3·说明'},
    {k:'trust',label:'信任条文案'},{k:'footer',label:'页脚文案'}
  ];
  function renderEditFields(fields){
    var host=$('#edit-fields');host.innerHTML='';
    FIELD_DEFS.forEach(function(f){
      var lab=document.createElement('label');lab.className='ef'+(f.area?' area':'');
      var span=document.createElement('span');span.textContent=f.label;lab.appendChild(span);
      var input;
      if(f.area){input=document.createElement('textarea');input.rows=2;input.value=fields[f.k]||'';}
      else{input=document.createElement('input');input.type='text';input.value=fields[f.k]||'';}
      input.setAttribute('data-field',f.k);
      lab.appendChild(input);host.appendChild(lab);
    });
  }
  function collectEdits(){
    var edits={};
    $('#edit-fields').querySelectorAll('[data-field]').forEach(function(el){edits[el.getAttribute('data-field')]=el.value;});
    edits.contact=$('#contact').value.trim();
    edits._ctaAction=$('#cta-action').value;
    edits._ctaValue=$('#cta-value').value.trim();
    return edits;
  }
  function applyAndRebuild(){
    if(!blueprint){status('先「开工」建一次站，才能编辑内容。');return;}
    var edits=collectEdits();
    BlueprintGen.applyEdits(blueprint,edits);
    $('#blueprint-json').value=JSON.stringify(blueprint,null,2);
    run(blueprint);
    status('已按你填的内容重新施工。按钮行为也已更新。');
  }

  /* LLM 生成的蓝图没有 bind 字段，这里按"字号最大 / 文本最长 / 带 action"猜出可编辑字段，
     并写回 bind，这样编辑面板改完真的会生效（而不是填了个假输入框）。 */
  function ensureBinds(bp){
    var blocks=(bp.blocks||[]).filter(function(b){return b.type==='text'&&b.text;});
    if(!blocks.length) return;
    function has(k){ return (bp.blocks||[]).some(function(b){return b.bind===k;}); }
    function fontOf(b){ return parseFloat((b.style&&b.style.fontSize))||0; }
    var byFont=blocks.slice().sort(function(a,b){return fontOf(b)-fontOf(a);});
    if(!has('brand')){
      var logo=(bp.blocks||[]).filter(function(b){return /logo|brand/i.test(b.label||'');})[0];
      if(logo) logo.bind='brand';
    }
    if(!has('title1')&&byFont[0]&&!byFont[0].bind) byFont[0].bind='title1';
    if(!has('title2')&&byFont[1]&&!byFont[1].bind) byFont[1].bind='title2';
    if(!has('cta')){
      var act=(bp.blocks||[]).filter(function(b){return b.action&&!b.bind;})[0];
      if(act) act.bind='cta';
    }
    if(!has('subtitle')){
      var long=blocks.filter(function(b){return !b.bind;}).sort(function(a,b){return (b.text||'').length-(a.text||'').length;})[0];
      if(long) long.bind='subtitle';
    }
    var navs=(bp.blocks||[]).filter(function(b){return /nav|menu|导航/i.test(b.label||'')&&!b.bind;});
    navs.slice(0,4).forEach(function(n,i){ n.bind='nav'+(i+1); });
  }

  function fillControlsFromBlueprint(bp){
    var f=BlueprintGen.extractFields(bp);
    renderEditFields(f);
    $('#contact').value=bp.meta.contact||'';
    $('#cta-action').value=bp.meta.ctaAction||'wechat';
    $('#cta-value').value=bp.meta.ctaValue||'';
    updateCtaValueLabel();
    if(bp.meta.paletteKey)$('#palette').value=bp.meta.paletteKey;
    if(bp.meta.sceneKey)$('#scene').value=bp.meta.sceneKey;
  }
  function updateCtaValueLabel(){
    var a=$('#cta-action').value;
    var labels={tel:'电话号码',wechat:'微信号',mailto:'邮箱地址',link:'网址链接'};
    $('#cta-value-label').textContent=labels[a]||'值';
    $('#cta-value').placeholder=a==='tel'?'13800138000':a==='mailto'?'hi@example.com':a==='link'?'https://...':'your_wechat_id';
  }

  function mount(bp){
    var err=BlueprintGen.validate(bp);
    if(err){status('蓝图有误：'+err);return false;}
    if(engine){engine.stop();engine=null;}
    if(EDIT.on) enterEdit(false,true);   // 重新施工就退出编辑态
    SwarmRender.render(bp,page);
    blueprint=bp;built=false;
    fit();
    $('#blueprint-json').value=JSON.stringify(bp,null,2);
    jsonDirty=false;
    showExport(false);showGoLive(false);
    stage.scrollTop=0;
    return true;
  }
  /* 提前把蓝图里的照片拉进浏览器缓存：施工时不会"先空一块再啪一下出图" */
  function preloadImages(bp){
    if(!bp||!bp.blocks) return;
    var seen={};
    bp.blocks.forEach(function(b){
      if(b.type!=='image') return;
      var v=String(b.image||'').trim();
      var m=/^url\(\s*['"]?(.*?)['"]?\s*\)$/.exec(v);
      if(!m||!m[1]||/^data:/i.test(m[1])) return;
      if(seen[m[1]]) return;
      seen[m[1]]=1;
      var im=new Image();
      im.decoding='async';
      im.src=m[1];
    });
  }

  function run(bp){
    bp=applyImages(bp);
    preloadImages(bp);
    if(!mount(bp))return;
    bindActions();
    var total=bp.blocks.length;
    engine=new SwarmEngine({
      blueprint:bp,page:page,layer:layer,stage:stage,scale:scale,
      speed:parseInt($('#speed').value,10)||1,
      followScroll:$('#follow').checked,
      theme:$('#theme').value,
      onBlockDone:function(b){
        var done=engine?engine.doneCount:0;
        status('施工中 '+done+'/'+total+' 块 · 已经建好的部分现在就能点（点导航会暂停镜头跟随）');
      },
      onComplete:function(){
        built=true;showGoLive(true);showExport(true);
        status('施工完成 — 整页已可交互：导航会滚动、卡片会引导、按钮会执行动作。也可以导出单文件发给别人。');
      }
    });
    engine.start();
    window.__swarmEngine=engine;
    status('施工中：'+bp.blocks.length+' 个任务由光标群协作完成…（边建边点，不用等全部完成）');
  }

  function buildLocal(){
    var pp=preparePrompt(), p=pp.text;
    if(!p){status('先写一句话，比如「做一个美甲店的预约页」');$('#prompt').focus();return;}
    currentPrompt=p;
    var sceneKey=$('#scene').value; // 'auto' 或具体场景
    var paletteKey=$('#palette').value; // 'auto' 或具体配色
    var opts={sceneKey:sceneKey==='auto'?null:sceneKey,paletteKey:paletteKey==='auto'?null:paletteKey};
    // 离线生成器默认用编辑面板里现填的品牌/联系/CTA（若有）
    var brand=($('#edit-fields')&&$('[data-field=brand]'))?$('[data-field=brand]').value.trim():'';
    if(brand)opts.brand=brand;
    var contact=$('#contact').value.trim();
    if(contact){opts.contact=contact;opts.ctaValue=$('#cta-value').value.trim();opts.ctaAction=$('#cta-action').value;}
    var bp=BlueprintGen.build(p,opts);
    currentSceneKey=bp.meta.sceneKey||sceneKey;
    fillControlsFromBlueprint(bp);
    run(bp);
    toast('离线引擎已生成：'+(bp.meta.industry||'通用场景')+' · '+bp.blocks.length+' 块');
  }

  /* ---------- 附件：像 WorkBuddy 一样，输入文字的同事可以带上电脑里的文件 ---------- */
  var ATTACH=[], ATTACH_SEQ=0, ATTACH_MAX=6;
  var TEXT_EXT=['txt','md','markdown','csv','tsv','json','html','htm','css','js','mjs','ts','tsx','jsx','xml','yml','yaml','log','py','java','go','rs','sql','sh','php','rb','c','cpp','h','ini','conf'];
  var DOC_EXT=['pdf','doc','docx','xls','xlsx','ppt','pptx'];
  var TEXT_CAP=24000, IMG_EDGE=1400;

  function extOf(name){ var m=/\.([a-z0-9]+)$/i.exec(String(name||'')); return m?m[1].toLowerCase():''; }
  function escAttr(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtSize(n){
    n=Number(n)||0;
    if(n<1024) return n+' B';
    if(n<1048576) return Math.round(n/1024)+' KB';
    return (n/1048576).toFixed(1)+' MB';
  }
  function kindOf(file){
    var t=String(file.type||''), e=extOf(file.name);
    if(t.indexOf('image/')===0||/^(png|jpe?g|gif|webp|bmp|svg|avif)$/.test(e)) return 'image';
    if(DOC_EXT.indexOf(e)>=0) return 'doc';
    if(TEXT_EXT.indexOf(e)>=0||t.indexOf('text/')===0||/json|xml|csv|javascript|markdown/.test(t)) return 'text';
    return 'other';
  }

  function compressImage(file){
    return new Promise(function(resolve,reject){
      var fr=new FileReader();
      fr.onerror=function(){ reject(new Error('读取失败')); };
      fr.onload=function(){
        var raw=String(fr.result||'');
        var img=new Image();
        img.onerror=function(){ resolve({dataUrl:raw}); };
        img.onload=function(){
          var w=img.naturalWidth||0,h=img.naturalHeight||0;
          var s=Math.min(1,IMG_EDGE/Math.max(w,h,1));
          if(s>=1&&file.size<400*1024) return resolve({dataUrl:raw});
          try{
            var cw=Math.max(1,Math.round(w*s)),ch=Math.max(1,Math.round(h*s));
            var cv=document.createElement('canvas'); cv.width=cw; cv.height=ch;
            var cx=cv.getContext('2d');
            cx.fillStyle='#ffffff'; cx.fillRect(0,0,cw,ch);
            cx.drawImage(img,0,0,cw,ch);
            resolve({dataUrl:cv.toDataURL('image/jpeg',0.82)});
          }catch(e){ resolve({dataUrl:raw}); }
        };
        img.src=raw;
      };
      fr.readAsDataURL(file);
    });
  }

  function readTextFile(file){
    return new Promise(function(resolve,reject){
      var fr=new FileReader();
      fr.onerror=function(){ reject(new Error('读取失败')); };
      fr.onload=function(){
        var t=String(fr.result||'');
        if(t.length>TEXT_CAP) t=t.slice(0,TEXT_CAP)+'\n…（已截断，原文件更长）';
        resolve(t);
      };
      fr.readAsText(file);
    });
  }

  function extractDoc(file){
    return new Promise(function(resolve,reject){
      var fr=new FileReader();
      fr.onerror=function(){ reject(new Error('读取失败')); };
      fr.onload=function(){
        var b64=String(fr.result||'').split(',')[1]||'';
        fetch(gwApi('/extract'),{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name:file.name,ext:extOf(file.name),data:b64})
        }).then(function(r){
          return r.json().catch(function(){return {error:'HTTP '+r.status};}).then(function(j){
            if(!r.ok||j.error) throw new Error(j.error||('HTTP '+r.status));
            return j;
          });
        }).then(function(j){
          resolve({text:String(j.text||'').slice(0,TEXT_CAP)});
        }).catch(reject);
      };
      fr.readAsDataURL(file);
    });
  }

  function loadOne(item,file){
    var ok=function(patch){ for(var k in patch) item[k]=patch[k]; item.state='ready'; renderFiles(); };
    var bad=function(msg){ item.state='error'; item.note=msg; renderFiles(); };
    if(item.kind==='image'){
      compressImage(file).then(function(r){ ok({dataUrl:r.dataUrl}); }).catch(function(e){ bad(e.message||'图片读取失败'); });
    }else if(item.kind==='text'){
      readTextFile(file).then(function(t){ ok({text:t}); }).catch(function(e){ bad(e.message||'读取失败'); });
    }else if(item.kind==='doc'){
      if(!GW.ok){ item.state='need-gateway'; item.note='需要先启动本机接口'; renderFiles(); return; }
      extractDoc(file).then(function(r){ ok({text:r.text}); }).catch(function(e){ bad(e.message||'解析失败'); });
    }else{
      item.state='unsupported'; item.note='暂不支持这种文件'; renderFiles();
    }
  }

  function addFiles(list){
    var arr=[].slice.call(list||[]).filter(Boolean);
    if(!arr.length) return;
    var room=ATTACH_MAX-ATTACH.length;
    if(room<=0){ toast('最多同时带 '+ATTACH_MAX+' 个文件，先删掉几个'); return; }
    if(arr.length>room){ toast('上限 '+ATTACH_MAX+' 个，先收下前 '+room+' 个'); arr=arr.slice(0,room); }
    arr.forEach(function(f){
      var item={id:'f'+(++ATTACH_SEQ),name:f.name||('文件'+ATTACH_SEQ),size:f.size||0,
        kind:kindOf(f),state:'reading',text:'',dataUrl:'',note:''};
      ATTACH.push(item);
      loadOne(item,f);
    });
    renderFiles();
  }

  function statusOf(a){
    if(a.state==='reading') return '读取中…';
    if(a.state==='need-gateway') return '需启动本机接口';
    if(a.state==='error') return a.note||'读取失败';
    if(a.state==='unsupported') return '暂不支持';
    if(a.kind==='image') return fmtSize(a.size);
    if(a.text) return a.text.length.toLocaleString('zh-CN')+' 字';
    return fmtSize(a.size);
  }

  function renderFiles(){
    var box=$('#file-list');
    if(!box) return;
    if(!ATTACH.length){ box.hidden=true; box.innerHTML=''; return; }
    box.hidden=false;
    box.innerHTML=ATTACH.map(function(a){
      var warn=(a.state==='need-gateway'||a.state==='error'||a.state==='unsupported');
      var badge;
      if(a.kind==='image'&&a.dataUrl){
        badge='<img src="'+escAttr(a.dataUrl)+'" alt="">';
      }else{
        var col=a.kind==='doc'?'#7a5cff':(a.kind==='text'?'#2b7cff':'#5a6678');
        badge='<span class="fi" style="background:'+col+'26;color:'+col+'">'+esc(extOf(a.name)||'FILE').toUpperCase().slice(0,4)+'</span>';
      }
      return '<div class="file-chip'+(warn?' warn':'')+'" data-fid="'+a.id+'" title="'+escAttr(a.name+' · '+statusOf(a))+'">'+
        badge+'<span class="fn">'+esc(a.name)+'</span><span class="fs">'+esc(statusOf(a))+'</span>'+
        '<button class="chip-x" data-del="'+a.id+'" title="移除">×</button></div>';
    }).join('');
  }

  /* 把附件里的文字拼成给模型的一段资料 */
  function attachContext(){
    var texts=ATTACH.filter(function(a){ return a.state==='ready'&&a.kind!=='image'&&a.text; });
    if(!texts.length) return '';
    return '\n\n【我提供的资料，请据此写真实内容】\n'+texts.map(function(a){
      return '--- '+a.name+' ---\n'+a.text;
    }).join('\n\n');
  }

  /* 用户上传的图片 → 蓝图素材，按面积从大到小替换到图片块上 */
  function applyImages(bp){
    var imgs=ATTACH.filter(function(a){ return a.state==='ready'&&a.kind==='image'&&a.dataUrl; });
    if(!imgs.length||!bp||!bp.blocks) return bp;
    bp.assets=bp.assets||{};
    var keys=imgs.map(function(a,i){
      var k='u'+(i+1); bp.assets[k]=a.dataUrl; return k;
    });
    var targets=bp.blocks.filter(function(b){ return b.type==='image'; })
      .sort(function(x,y){ return (y.w*y.h)-(x.w*x.h); });
    targets.forEach(function(b,i){ if(i<keys.length) b.image='asset:'+keys[i]; });
    return bp;
  }

  function preparePrompt(){
    var p=$('#prompt').value.trim();
    var ctx=attachContext();
    return {text:p,full:ctx?p+ctx:p};
  }

  function bindAttachUI(){
    var box=$('#file-list');
    if(box) box.addEventListener('click',function(e){
      var b=e.target.closest?e.target.closest('[data-del]'):null;
      if(!b) return;
      e.preventDefault(); e.stopPropagation();
      var id=b.getAttribute('data-del');
      ATTACH=ATTACH.filter(function(a){ return a.id!==id; });
      renderFiles();
    });
    var inp=$('#file-input');
    if(inp) inp.addEventListener('change',function(){ addFiles(inp.files); inp.value=''; });
    var btn=$('#attach');
    if(btn) btn.addEventListener('click',function(e){ e.preventDefault(); if(inp) inp.click(); });

    var hasFiles=function(e){
      var dt=e.dataTransfer;
      if(!dt) return false;
      if(dt.types) return [].indexOf.call(dt.types,'Files')>=0;
      return !!(dt.files&&dt.files.length);
    };
    ['dragenter','dragover'].forEach(function(t){
      document.addEventListener(t,function(e){
        if(!hasFiles(e)) return;
        e.preventDefault();
        var c=$('#composer'); if(c) c.classList.add('drag');
      });
    });
    document.addEventListener('dragleave',function(e){
      if(e.relatedTarget&&e.relatedTarget.nodeType===1) return;
      var c=$('#composer'); if(c) c.classList.remove('drag');
    });
    document.addEventListener('drop',function(e){
      var c=$('#composer'); if(c) c.classList.remove('drag');
      if(!e.dataTransfer||!e.dataTransfer.files||!e.dataTransfer.files.length) return;
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    });
    document.addEventListener('paste',function(e){
      if(!e.clipboardData) return;
      var fs=e.clipboardData.files;
      if(fs&&fs.length){ e.preventDefault(); addFiles(fs); }
    });

    var ta=$('#prompt');
    if(ta){
      var grow=function(){ ta.style.height='auto'; ta.style.height=Math.min(132,Math.max(25,ta.scrollHeight))+'px'; };
      ta.addEventListener('input',grow);
      setTimeout(grow,0);
    }
  }

  /* ---------- LLM 接入 ---------- */
  function mode(){ return ($('#llm-mode')&&$('#llm-mode').value)||'offline'; }

  function normUrl(u){
    if(!u) return '';
    u=String(u).replace(/\s+/g,'').replace(/\/+$/,'');
    if(/\/chat\/completions$/.test(u)) return u;
    if(/\/v\d+$/.test(u)) return u+'/chat/completions';
    try{
      var url=new URL(u);
      if(url.pathname==='/'||url.pathname==='') return url.origin+'/v1/chat/completions';
    }catch(e){}
    return u+'/chat/completions';
  }
  function llmConfig(){
    return {url:normUrl($('#llm-url').value.trim()),key:$('#llm-key').value.trim(),model:$('#llm-model').value.trim()};
  }

  /* ---------- 本机接口（gateway）----------
     双击打开是 file:// 页面，浏览器会以「跨域」为由拦掉一切发往 api.xxx.com 的请求，
     所以填了 Key 也没用。跑 server.js 之后页面与接口同源，Key 由本机服务注入，
     任何 OpenAI 兼容服务商都能直连。 */
  var GW={checked:false,ok:false,baseUrl:'',model:'',hasKey:false,keyTail:'',fileMode:location.protocol==='file:'};
  function gwApi(p){ return location.origin+'/api/llm'+p; }

  function probeGateway(force){
    if(GW.checked&&!force) return Promise.resolve(GW);
    GW.fileMode=(location.protocol==='file:');
    if(GW.fileMode){ GW.checked=true;GW.ok=false;window.__SWARM_IMG_PROXY=false;renderGateway();return Promise.resolve(GW); }
    return fetch(gwApi('/health'),{cache:'no-store'}).then(function(r){
      if(!r.ok) throw new Error('no gateway');
      return r.json();
    }).then(function(j){
      GW.checked=true;
      GW.ok=!!(j&&j.service==='swarmsite-gateway');
      if(GW.ok){
        GW.baseUrl=j.baseUrl||'';GW.model=j.model||'';GW.hasKey=!!j.hasKey;GW.keyTail=j.keyTail||'';
      }
      // 有本机接口就走同源图片代理（磁盘缓存 + 重试），否则直连 CDN
      window.__SWARM_IMG_PROXY=GW.ok;
      renderGateway();
      return GW;
    }).catch(function(){
      GW.checked=true;GW.ok=false;window.__SWARM_IMG_PROXY=false;renderGateway();return GW;
    });
  }

  function renderGateway(){
    var box=$('#gw-status');
    if(box){
      if(GW.fileMode){
        box.className='gwbar warn';
        box.innerHTML='<b>本机接口没启动</b><span>你是双击打开的（file://），浏览器不允许页面直接调 API。在项目目录跑 <code>node server.js</code>（或双击「启动.bat」），用 <code>http://127.0.0.1:5173</code> 打开本页就能填 Key 直接生成。</span>';
      }else if(GW.ok){
        box.className='gwbar ok';
        box.innerHTML='<b>本机接口已连通</b><span>'+esc(GW.baseUrl||'')+' · '+esc(GW.model||'')+' · '+(GW.hasKey?('Key 已存（'+esc(GW.keyTail)+'）'):'还没存 Key')+'</span>';
      }else{
        box.className='gwbar bad';
        box.innerHTML='<b>页面在本机、但接口没开</b><span>跑 <code>node server.js</code> 用它的地址打开，才不会卡跨域。</span>';
      }
    }
    var copyBtn=$('#gw-copy');
    if(copyBtn) copyBtn.style.display=GW.fileMode?'inline-block':'none';
    var clearBtn=$('#gw-clear');
    if(clearBtn) clearBtn.style.display=(GW.ok&&GW.hasKey)?'inline-block':'none';
    var keyInput=$('#llm-key');
    if(keyInput){
      keyInput.placeholder=(GW.ok&&GW.hasKey)?('已存在本机接口 · '+GW.keyTail+'（留空即用）'):'sk-…（填一次，点「保存到本机接口」）';
    }
  }
  function esc(s){
    return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /* 流式读取 SSE：边收边报进度，长蓝图不用干等 */
  function readSSE(resp,onDelta){
    if(!resp.body||!resp.body.getReader) return resp.text().then(function(t){ return t; });
    var reader=resp.body.getReader(),dec=new TextDecoder(),buf='',out='';
    function feed(block){
      var lines=String(block).split('\n');
      for(var i=0;i<lines.length;i++){
        var ln=lines[i].replace(/\r$/,'').trim();
        if(!ln||ln.indexOf('data:')!==0) continue;
        var data=ln.slice(5).trim();
        if(!data||data==='[DONE]') continue;
        var j=null; try{ j=JSON.parse(data); }catch(e){ continue; }
        if(j.error) throw new Error(typeof j.error==='string'?j.error:(j.error.message||'上游报错'));
        var ch=j.choices&&j.choices[0];
        var d=ch&&(ch.delta||ch.message);
        if(d&&typeof d.content==='string'&&d.content){ out+=d.content; if(onDelta)onDelta(out.length); }
        else if(d&&d.reasoning_content&&onDelta) onDelta(out.length);
        else if(typeof j.response==='string'&&j.response){ out+=j.response; if(onDelta)onDelta(out.length); }
      }
    }
    return new Promise(function(resolve,reject){
      (function pump(){
        reader.read().then(function(r){
          if(r.done){
            if(buf.trim()){ try{ feed(buf.replace(/\r\n/g,'\n')); }catch(e){ return reject(e); } }
            return resolve(out);
          }
          buf+=dec.decode(r.value,{stream:true});
          buf=buf.replace(/\r\n/g,'\n');
          var idx;
          while((idx=buf.indexOf('\n\n'))>=0){
            var block=buf.slice(0,idx); buf=buf.slice(idx+2);
            try{ feed(block); }catch(e){ try{reader.cancel();}catch(_){} return reject(e); }
          }
          pump();
        }).catch(reject);
      })();
    });
  }

  /* 统一的对话请求：优先走本机接口（同源、能流式），否则退回浏览器直连 */
  function chatRequest(cfg,messages,opts){
    opts=opts||{};
    var useGw=GW.ok;
    if(!useGw&&!cfg.url) return Promise.reject(new Error('还没填 API 地址'));
    if(useGw&&!cfg.url&&!GW.baseUrl) return Promise.reject(new Error('本机接口还没配上游地址'));
    var url=useGw?gwApi('/chat'):cfg.url;
    var headers={'Content-Type':'application/json'};
    var body={messages:messages,temperature:(typeof opts.temperature==='number')?opts.temperature:0.6};
    var stream=useGw&&!!opts.onDelta;
    if(useGw){
      body.stream=stream;
      if(cfg.url) body.baseUrl=cfg.url;
      if(cfg.model) body.model=cfg.model;
      if(cfg.key) body.apiKey=cfg.key;
      if(opts.max_tokens) body.max_tokens=opts.max_tokens;
    }else{
      headers.Authorization='Bearer '+(cfg.key||'');
      body.model=cfg.model||'gpt-4o-mini';
      body.stream=false;
      if(opts.max_tokens) body.max_tokens=opts.max_tokens;
    }
    return fetch(url,{method:'POST',headers:headers,body:JSON.stringify(body)}).then(function(r){
      var ct=(r.headers.get('content-type')||'');
      if(stream&&r.ok&&/event-stream/i.test(ct)) return readSSE(r,opts.onDelta);
      return r.text().then(function(t){
        var j=null;try{ j=JSON.parse(t); }catch(e){}
        if(!r.ok){
          var detail=(j&&j.error)?(typeof j.error==='string'?j.error:(j.error.message||JSON.stringify(j.error))):String(t).slice(0,180);
          var msg=/^HTTP\s+\d/.test(detail)?detail:('HTTP '+r.status+(detail?(' · '+detail):''));
          throw new Error(msg);
        }
        if(j&&typeof j.content==='string') return j.content;               // 本机接口
        if(j&&j.choices&&j.choices[0]){
          var c=j.choices[0];
          var txt=(c.message&&c.message.content)||c.text;
          if(txt) return String(txt);
        }
        if(j&&typeof j.response==='string') return j.response;             // Ollama 原生
        if(j&&j.error) throw new Error(typeof j.error==='string'?j.error:(j.error.message||'上游报错'));
        if(typeof t==='string'&&t.trim()&&t.trim().charAt(0)!=='{') return t; // 直接吐文本的服务
        throw new Error('响应里没有内容');
      });
    }).catch(function(e){
      var m=(e&&e.message)||String(e);
      if(/Failed to fetch|NetworkError|Load failed|ERR_/i.test(m)){
        if(GW.fileMode) throw new Error('浏览器拦住了跨域请求：双击打开（file://）不能用在线 API。跑一下 node server.js，用它给的地址打开就能填 Key 直接用。');
        throw new Error('连不上上游（地址不对或被跨域拦）。检查 API 地址，或跑本机接口。');
      }
      throw new Error(m);
    });
  }

  function currentGradKey(){
    try{
      var k=currentSceneKey||(blueprint&&blueprint.meta&&blueprint.meta.sceneKey)||'';
      var s=k&&BlueprintGen.SCENES[k];
      return s&&s.grad?s.grad:null;
    }catch(e){ return null; }
  }

  /* ---------- 自由版式：模型给 HTML，浏览器排版，编译器量尺寸 ---------- */
  function importHTML(html, source){
    if(!window.BlueprintCompiler){
      status('编译器没加载（compiler.js 缺失），这条路径用不了');
      return Promise.reject(new Error('no compiler'));
    }
    var clean=BlueprintCompiler.extractHTML(html);
    status('正在按语义结构排版、测量每块尺寸…');
    return BlueprintCompiler.compile(clean).then(function(bp){
      // 按用户那句话识别场景，给图片块配上对应行业的照片
      var gk=BlueprintGen.detectGrad($('#prompt').value)||currentGradKey();
      bp=BlueprintGen.enrichImages(bp,gk);
      ensureBinds(bp);
      $('#blueprint-json').value=JSON.stringify(bp,null,2);
      fillControlsFromBlueprint(bp);
      run(bp);
      status((source||'HTML')+'已排版：'+bp.blocks.length+' 块 · 施工中 · 这份版式由 CSS 排版后实测得来');
      toast('自由版式已生成：'+bp.blocks.length+' 块');
      window.__lastCompiled=bp;
      return bp;
    }).catch(function(e){
      status('HTML 排版失败：'+(e.message||e)+' —— 检查模型给的结构是否只用了允许的 class');
      toast('排版失败，看底部状态栏');
      throw e;
    });
  }

  /* 统一入口：模型给 HTML 就编译，给 JSON 就按坐标蓝图解析 */
  function ingest(text, source){
    if(window.BlueprintCompiler&&BlueprintCompiler.looksLikeHTML(text)){
      return importHTML(text, source);
    }
    return Promise.resolve(importText(text, source));
  }

  function importText(text,source){
    var res=BlueprintGen.repair(text, currentGradKey());
    if(res.error){ status((source||'导入')+'失败：'+res.error); toast('没能解析出蓝图，把 AI 的回答整段粘进来也可以'); return false; }
    var bp=res.blueprint;
    var err=BlueprintGen.validate(bp);
    if(err){ status('代码层面不合法：'+err); return false; }
    ensureBinds(bp);
    $('#blueprint-json').value=JSON.stringify(bp,null,2);
    fillControlsFromBlueprint(bp);
    run(bp);
    var n=(res.notes||[]).length;
    var notesTxt=n?('自动修好 '+n+' 处：'+(res.notes||[]).slice(0,2).join('；')):'';
    status((source||'导入')+'成功：'+bp.blocks.length+' 块 · 施工中'+(notesTxt?(' · '+notesTxt):''));
    // 施工状态栏马上会被施工进度刷新，把"修了什么"用气泡留 3 秒，别让它一闪而过
    toast(notesTxt||((source||'')+'已导入，开始施工'));
    return true;
  }

  function promptPayload(){
    var o={brand:($('[data-field=brand]')||{}).value||'',contact:$('#contact').value.trim()};
    if($('#cta-value').value.trim()){o.ctaAction=$('#cta-action').value;o.ctaValue=$('#cta-value').value.trim();}
    o.seed=Math.floor(Math.random()*1e9);
    var full=preparePrompt().full;
    return {text:(window.BlueprintCompiler?BlueprintCompiler.buildPrompt(full,o):BlueprintGen.buildPrompt(full,o))};
  }
  function copyPrompt(){
    var p=promptPayload().text;
    function ok(){ toast('提示词已复制 · 粘到任意 AI，把它的回答复制回来，再点「从剪贴板导入」'); status('提示词已复制。下一步：粘到 AI → 复制它的回答 → 回来点「从剪贴板导入」。'); }
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(p).then(ok,function(){fallbackCopy(p,'提示词已复制');});
    else fallbackCopy(p,'提示词已复制');
    return p;
  }
  function pasteBlueprint(){
    if(!navigator.clipboard||!navigator.clipboard.readText){
      $('#blueprint-json').focus();
      status('这个浏览器不让直接读剪贴板：按 Ctrl+V 把 JSON 粘进右边的框，再点「从 JSON 建站」。');
      return;
    }
    navigator.clipboard.readText().then(function(t){
      if(!t||!t.trim()){ $('#blueprint-json').focus(); status('剪贴板是空的。先把 AI 的回答复制下来。'); return; }
      ingest(t,'剪贴板');
    }).catch(function(){
      $('#blueprint-json').focus();
      status('读不到剪贴板（权限被拒）：按 Ctrl+V 粘到右边的 JSON 框，再点「从 JSON 建站」。');
    });
  }

  function llmReady(){
    if(mode()!=='api'&&mode()!=='local') return false;
    var cfg=llmConfig();
    if(GW.ok) return !!(cfg.url||GW.baseUrl)&&(!!cfg.key||GW.hasKey||mode()==='local');
    return !!cfg.url&&(!!cfg.key||mode()==='local');
  }

  function buildLLM(){
    var cfg=llmConfig();
    if(!GW.ok&&!cfg.url){ status('这个模式要填 API 地址；懒得配就用「剪贴板桥」或「离线引擎」。'); return; }
    if(mode()==='api'&&!cfg.key&&!GW.hasKey){
      status(GW.ok?'在线 API 需要 Key：填一次后点「保存到本机接口」，以后就不用再填。':'在线 API 需要 Key；本地模型可以留空。');
      $('#llm-key').focus();return;
    }
    var pp=preparePrompt();
    var p=pp.text||'一个现代感的产品落地页';
    var modelName=cfg.model||GW.model||'模型';
    var o={brand:($('[data-field=brand]')||{}).value||'',contact:$('#contact').value.trim(),seed:Date.now()};
    if($('#cta-value').value.trim()){o.ctaAction=$('#cta-action').value;o.ctaValue=$('#cta-value').value.trim();}
    var useHTML=!!window.BlueprintCompiler;
    status('正在请求 '+modelName+' 生成 '+(useHTML?'页面结构':'蓝图')+'…'+(GW.ok?'':'（浏览器直连，可能被跨域拦）'));
    chatRequest(cfg,[
      {role:'system',content:useHTML
        ?'你是网页结构设计师。只输出 HTML 片段，不要解释，不要 markdown 围栏，不要写任何 CSS。'
        :'你是网页布局工程师，只输出合法 JSON 蓝图，不要解释、不要 markdown。'},
      {role:'user',content:useHTML
        ?BlueprintCompiler.buildPrompt(pp.text?pp.full:p,o)
        :BlueprintGen.buildPrompt(pp.text?pp.full:p,o)}
    ],{temperature:useHTML?0.85:0.6,onDelta:function(n){ status('正在生成 · '+modelName+' 已返回 '+n+' 字符…'); }})
      .then(function(txt){ return ingest(txt,'LLM').then(function(){ saveLlm(true); },function(){}); })
      .catch(function(e){ status('生成失败：'+e.message); toast('没生成出来，看底部状态栏'); });
  }
  function testLLM(){
    var cfg=llmConfig();
    status('测试连接中…'+(GW.ok?'（走本机接口）':'（浏览器直连）'));
    chatRequest(cfg,[{role:'user',content:'只回复两个字：可以'}],{temperature:0,max_tokens:12})
      .then(function(){
        status('连接成功：'+(GW.ok?'本机接口 → ':'')+(cfg.url||GW.baseUrl)+(cfg.model?(' · '+cfg.model):''));
        toast('接口可用，可以直接生成');
      })
      .catch(function(e){
        var keyHint=/401|403|缺少 API Key/.test(e.message)?'（Key 不对或没生效）':'';
        status('连接失败：'+e.message+keyHint+' —— 检查地址与 Key；实在不行用「剪贴板桥」，不依赖接口也能拿到蓝图。');
        toast('连接失败，看底部状态栏');
      });
  }

  /* 配置持久化：有本机接口就存到接口（浏览器不留 Key），否则退回落 localStorage */
  function saveLlm(silent){
    var cfg=llmConfig();
    if(GW.ok){
      var payload={baseUrl:cfg.url,model:cfg.model};
      if(cfg.key) payload.apiKey=cfg.key;
      return fetch(gwApi('/config'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
        .then(function(r){ return r.json(); })
        .then(function(j){
          if(!j.ok) throw new Error(j.error||'保存失败');
          GW.hasKey=!!j.hasKey;GW.keyTail=j.keyTail||'';GW.baseUrl=j.baseUrl||GW.baseUrl;GW.model=j.model||GW.model;
          $('#llm-key').value='';   // 存进本机接口后，输入框里不再留 Key
          try{ localStorage.setItem(LS_KEY,JSON.stringify({mode:mode(),theme:$('#theme').value})); }catch(e){}
          renderGateway();
          if(!silent){ toast('已存到本机接口 · 浏览器里不再保存 Key'); }
          status('已保存：'+GW.baseUrl+' · '+GW.model+' · Key '+(GW.hasKey?GW.keyTail:'未设置'));
        })
        .catch(function(e){ if(!silent) toast('保存到本机接口失败：'+e.message); });
    }
    try{
      localStorage.setItem(LS_KEY,JSON.stringify({
        mode:mode(),url:$('#llm-url').value.trim(),key:$('#llm-key').value.trim(),
        model:$('#llm-model').value.trim(),theme:$('#theme').value
      }));
      if(!silent) toast(GW.fileMode?'已记住配置（只在这台电脑的浏览器里）':'已记住配置');
    }catch(e){ if(!silent) toast('这个浏览器禁用了本地存储，配置只在本次有效'); }
    return Promise.resolve();
  }
  function loadLlm(){
    var raw=null;
    try{ raw=localStorage.getItem(LS_KEY); }catch(e){}
    if(!raw) return;
    try{
      var c=JSON.parse(raw);
      if(c.mode)$('#llm-mode').value=c.mode;
      if(c.url)$('#llm-url').value=c.url;
      if(c.key)$('#llm-key').value=c.key;
      if(c.model)$('#llm-model').value=c.model;
      if(c.theme)$('#theme').value=c.theme;
    }catch(e){}
  }
  var PRESETS={
    deepseek:{url:'https://api.deepseek.com/v1',model:'deepseek-chat'},
    qwen:{url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen-plus'},
    moonshot:{url:'https://api.moonshot.cn/v1',model:'moonshot-v1-8k'},
    zhipu:{url:'https://open.bigmodel.cn/api/paas/v4',model:'glm-4-flash'},
    openai:{url:'https://api.openai.com/v1',model:'gpt-4o-mini'},
    siliconflow:{url:'https://api.siliconflow.cn/v1',model:'Qwen/Qwen2.5-7B-Instruct'},
    ollama:{url:'http://127.0.0.1:11434/v1',model:'qwen2.5:7b'},
    lmstudio:{url:'http://127.0.0.1:1234/v1',model:'local-model'}
  };
  function switchMode(){
    var m=mode();
    ['offline','bridge','local','api'].forEach(function(k){
      var box=$('#mode-'+k); if(box) box.hidden=(k!==m);
    });
    var needNet=(m==='local'||m==='api');
    $('#row-url').style.display=needNet?'flex':'none';
    $('#lab-key').style.display=(m==='api')?'flex':'none';
    $('#lab-model').style.display=needNet?'flex':'none';
    $('#test-llm').style.display=needNet?'inline-block':'none';
    $('#run-llm').style.display=needNet?'inline-block':'none';
    $('#save-llm').style.display=needNet?'inline-block':'none';
    $('#save-llm').textContent=(GW.ok?'保存到本机接口':'记住配置');
    $('#llm-hint').textContent=(m==='offline')?'离线引擎不需要任何配置。'
      :(m==='bridge')?'不需要 Key、不怕跨域，用你手边的任意 AI 就行。'
      :(GW.ok?'地址/Key/模型存在本机接口（.llm.json），浏览器不留 Key，也不会进导出的网页。'
      :'浏览器直连 API 大概率会被跨域拦住：建议跑 node server.js（或双击「启动.bat」）。');
    renderGateway();
  }

  function download(name,text,type){
    var blob=new Blob([text],{type:type||'text/plain;charset=utf-8'});
    var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(a.href);},1000);
  }

  function sharePitch(){
    var m=blueprint.meta;
    var action=m.ctaAction==='tel'?'电话预约':m.ctaAction==='wechat'?'加微信咨询':m.ctaAction==='mailto'?'邮件联系':'点击了解';
    return '我做了一个「'+(m.title||'网站')+'」的展示页，'+(m.contact?('可以直接'+action+'（'+m.contact+'）'):'按钮能直接点')+'。\n'+
      '发你看看，如果你或身边的朋友也需要一个这样的页面（个人名片、门店预约、作品集、课程报名都能做），告诉我，我也能帮忙做一个。';
  }

  /* ---------- 一句话改页面：把当前蓝图 + 要求交给模型，改完重新施工 ---------- */
  var PATCH_SYS=[
    '你是网页蓝图编辑器。用户给你一份蓝图 JSON 和一句修改要求你的任务是改这份蓝图。',
    '硬性要求：',
    '1. 只输出修改后的完整 JSON，不要解释、不要 markdown 代码围栏。',
    '2. 结构必须是 {"meta":{"title","width","height","bg",...},"blocks":[{"id","type","x","y","w","h",...}]}。',
    '3. 没被要求改的块原样保留，id 不要改；新增块用新 id（n1、n2…），不要与现有重复。',
    '4. 文字块 type:"text" 必须有 text；矩形 type:"rect"；线 type:"line"；图片 type:"image"。',
    '5. style 用驼峰（fontSize、fontWeight、lineHeight、borderRadius、background、color），颜色写 #rrggbb。',
    '6. x/y/w/h 都是数字（像素），新增块不要压住已有块；按现有版面的留白和对齐习惯来。',
    '7. 不要删 meta，不要删导航块，除非用户明确要求。',
    '8. 改完自己检查一遍：JSON 能解析、没有多余逗号、文字没被截断。'
  ].join('\n');

  var patchStack=[], patchBusy=false;

  function diffSummary(a,b){
    var am={},bm={};
    (a.blocks||[]).forEach(function(x){am[x.id]=x;});
    (b.blocks||[]).forEach(function(x){bm[x.id]=x;});
    var added=0,removed=0,changed=0;
    Object.keys(bm).forEach(function(k){
      if(!am[k]){ added++; return; }
      var p=am[k],q=bm[k];
      if(p.text!==q.text||p.x!==q.x||p.y!==q.y||p.w!==q.w||p.h!==q.h||
         JSON.stringify(p.style||{})!==JSON.stringify(q.style||{})) changed++;
    });
    Object.keys(am).forEach(function(k){ if(!bm[k]) removed++; });
    var parts=[];
    if(added) parts.push('新增 '+added+' 块');
    if(removed) parts.push('删掉 '+removed+' 块');
    if(changed) parts.push('改了 '+changed+' 块');
    return parts.join(' · ')||'只做了细微调整';
  }

  function addPatchLog(ins,sum){
    var host=$('#patch-log'); if(!host) return;
    var row=document.createElement('div');row.className='plog';
    var t=new Date();
    var hh=('0'+t.getHours()).slice(-2),mm=('0'+t.getMinutes()).slice(-2);
    row.innerHTML='<i>'+hh+':'+mm+'</i><b>'+esc(ins)+'</b><span>'+esc(sum)+'</span>';
    host.insertBefore(row,host.firstChild);
    while(host.children.length>6) host.removeChild(host.lastChild);
  }

  function applyPatch(){
    if(patchBusy) return;
    var ins=$('#patch-input').value.trim();
    if(!ins){ status('先写一句要改什么，比如「把主标题改得更直接」。'); $('#patch-input').focus(); return; }
    if(!blueprint){ status('先「开工」建一个页面，再来改。'); return; }
    var cfg=llmConfig();
    if(!(mode()==='api'||mode()==='local')||!llmReady()){
      status('改页面需要先接一个模型：去「LLM / 蓝图」选④填 Key，或用③本地模型。');
      switchTab('llm');return;
    }
    var before=JSON.stringify(blueprint);
    var btn=$('#patch-go');
    patchBusy=true;btn.disabled=true;btn.textContent='正在改…';
    $('#patch-result').textContent='正在让模型改…';
    status('正在改页面…');
    chatRequest(cfg,[
      {role:'system',content:PATCH_SYS},
      {role:'user',content:'修改要求：'+ins+'\n\n当前蓝图：\n'+before}
    ],{temperature:0.25,onDelta:function(n){ status('正在改…已收 '+n+' 字符'); }})
      .then(function(txt){
        var res=BlueprintGen.repair(txt, currentGradKey());
        if(res.error) throw new Error('模型的改法解析不了：'+res.error);
        var err=BlueprintGen.validate(res.blueprint);
        if(err) throw new Error('改出来的蓝图不合法：'+err);
        var next=res.blueprint;
        ensureBinds(next);
        var sum=diffSummary(JSON.parse(before),next);
        patchStack.push({bp:before,sum:sum,ins:ins});
        if(patchStack.length>5) patchStack.shift();
        $('#blueprint-json').value=JSON.stringify(next,null,2);
        fillControlsFromBlueprint(next);
        run(next);
        $('#patch-result').textContent='已应用：'+sum;
        addPatchLog(ins,sum);
        $('#patch-input').value='';
        toast('改好了：'+sum);
        status('已按「'+(ins.length>22?ins.slice(0,22)+'…':ins)+'」改完并重新施工 · '+sum);
      })
      .catch(function(e){
        $('#patch-result').textContent='没改成：'+e.message;
        status('改页面失败：'+e.message+'（原页面没动，可以直接重试）');
      })
      .then(function(){
        patchBusy=false;btn.disabled=false;btn.textContent='改完重新施工 →';
      });
  }

  function undoPatch(){
    if(!patchStack.length){ status('还没有可撤销的修改。'); return; }
    var last=patchStack.pop();
    var bp=JSON.parse(last.bp);
    $('#blueprint-json').value=JSON.stringify(bp,null,2);
    fillControlsFromBlueprint(bp);
    run(bp);
    $('#patch-result').textContent='已撤销：'+last.ins;
    status('已撤销上一次修改（'+last.sum+'）');
  }

  /* ---------- 导出用的图片处理 ----------
   * 页面里用 /img/<id>?w=<w> 走本机代理；导出时这些地址必须还原成公开 CDN，
   * 或者（勾了「内嵌图片」时）换成 base64 直接塞进文件。 */
  function cdnPhoto(id,w){
    return 'https://images.unsplash.com/'+id+'?w='+w+'&q=80&auto=format&fit=crop';
  }
  // 浏览器序列化 inline style 时会把 url() 里的地址加上引号；写进 HTML 属性后
  // 这对引号还会被转义成 &quot;。三种形态（无引号 / " / &quot;）都要认。
  function proxyImgRe(){
    return /url\(\s*(&quot;|&#34;|['"]?)\/img\/(photo-[\w-]+)\?w=(\d+)\1\s*\)/g;
  }
  function collectProxyImages(html){
    var re=proxyImgRe(),m,out={};
    while((m=re.exec(html))) out[m[2]+'@'+m[3]]={id:m[2],w:parseInt(m[3],10)};
    return Object.keys(out).map(function(k){return out[k];});
  }
  function rewriteProxyImages(html,map){
    return String(html).replace(proxyImgRe(),function(all,q,id,w){
      var d=map&&map[id+'@'+w];
      return 'url('+q+(d||cdnPhoto(id,w))+q+')';
    });
  }
  function embedImages(items){
    return fetch('/api/img/embed',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({items:items.slice(0,16)})
    }).then(function(r){
      return r.json().then(function(j){
        if(!r.ok||!j||!j.ok) throw new Error((j&&j.error)||('HTTP '+r.status));
        return j;
      });
    }).then(function(j){
      var map={};
      (j.images||[]).forEach(function(im){ if(im.dataUrl) map[im.id+'@'+im.w]=im.dataUrl; });
      return map;
    });
  }

  /* ---------- 导出单文件：静态优先 + 脚本增强 ---------- */
  function exportHTML(){
    if(!blueprint)return;
    var pageCss=document.getElementById('page-css').textContent;
    var renderSrc=document.getElementById('render-src').textContent;
    var engineSrc=document.getElementById('engine-src').textContent;
    var st=SwarmRender.staticHTML(blueprint);
    var bp=JSON.stringify(blueprint);
    var theme=$('#theme').value;

    var shellCss=pageCss+'\n'+
      'body{background:var(--sw-bg);overflow:hidden}#stage{position:fixed;inset:0}'+
      '#stage::before{position:fixed}'+
      '#goLive{position:fixed;right:18px;bottom:18px;z-index:90;display:none;background:#fff;color:#111;border:0;border-radius:9px;padding:11px 18px;font:600 14px Inter,sans-serif;cursor:pointer;box-shadow:0 8px 26px rgba(0,0,0,.4)}'+
      '#replay{position:fixed;left:18px;bottom:18px;z-index:90;background:rgba(255,255,255,.92);color:#111;border:0;border-radius:9px;padding:10px 15px;font:600 13px Inter,sans-serif;cursor:pointer;display:none}'+
      '#hint{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:90;color:#aab;font:12px Inter,sans-serif;background:rgba(0,0,0,.4);padding:6px 12px;border-radius:20px;white-space:nowrap}'+
      '#badge{position:fixed;right:18px;top:12px;z-index:90;color:#8ea3c4;font:600 11px Inter,sans-serif;text-decoration:none;background:rgba(0,0,0,.4);padding:6px 12px;border-radius:20px}'+
      '.shud{top:auto;bottom:70px;left:18px}'+
      '@media(max-width:720px){#hint{display:none}#badge{display:none}}';

    var bootJs=[
      '(function(){',
      'var BP='+bp+',THEME="'+theme+'";',
      'var stage=document.getElementById("stage"),zoom=document.getElementById("zoom"),page=document.getElementById("page"),layer=document.getElementById("layer");',
      'var go=document.getElementById("goLive"),replayBtn=document.getElementById("replay"),hint=document.getElementById("hint"),badge=document.getElementById("badge");',
      'var engine=null,started=false;',
      'function fit(){var w=BP.meta.width,h=BP.meta.height,s=Math.min(1,(stage.clientWidth-32)/w);zoom.style.width=w+"px";zoom.style.height=h+"px";zoom.style.zoom=s;if(engine)engine.setScale(s);}',
      'function bindSafe(){try{SwarmRender.bind(page,BP.meta,{scroller:stage,editable:false});}catch(e){}}',
      'function hideChrome(){go.style.display="none";hint.style.display="none";badge.style.display="none";}',
      'function goLive(){if(engine){engine.finish();engine=null;}hideChrome();bindSafe();try{stage.scrollTo({top:0,behavior:"smooth"});}catch(e){stage.scrollTop=0;}}',
      'function boot(){',
      '  if(engine){try{engine.stop();}catch(e){}engine=null;}',
      '  hideChrome();replayBtn.style.display="none";',
      '  engine=new SwarmEngine({blueprint:BP,page:page,layer:layer,stage:stage,theme:THEME,',
      '    scale:parseFloat(zoom.style.zoom)||1,',
      '    onComplete:function(){go.style.display="block";replayBtn.style.display="block";replayBtn.textContent="↻ 重播施工";}});',
      '  engine.start();',
      '  hint.style.display="block";badge.style.display="block";',
      '  window.__swarmEngine=engine;',
      '}',
      'function showStatic(){',
      '  if(engine){try{engine.finish();}catch(e){}engine=null;}',
      '  hideChrome();bindSafe();',
      '  replayBtn.textContent="▶ 播放施工动画";replayBtn.style.display="block";',
      '}',
      'window.addEventListener("resize",fit);',
      'replayBtn.onclick=function(){boot();};',
      'go.onclick=goLive;',
      'page.addEventListener("click",function(e){if(engine&&!engine.flocking)engine.pauseFollow(6);},true);',
      'var reduce=false;try{reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches;}catch(e){}',
      'var skipIntro=/[?&]nointro/i.test(location.search)||!!location.hash||(window.self!==window.top);',
      'fit();',
      'try{',
      '  if(reduce||skipIntro){showStatic();}else{boot();}',
      '}catch(e){showStatic();}',
      '})();'
    ].join('\n');

    var html='<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">'+
      '<meta name="viewport" content="width=device-width,initial-scale=1">'+
      '<title>'+String(blueprint.meta.title||'SwarmSite').replace(/[<>&"]/g,'')+'</title>\n'+
      '<meta name="description" content="'+String(blueprint.meta.contact||blueprint.meta.title||'').replace(/[<>&"]/g,'')+'">\n'+
      '<style>\n'+shellCss+'\n</style></head><body data-theme="'+theme+'">\n'+
      '<div id="stage"><div id="zoom"><div id="page" data-w="'+blueprint.meta.width+'" data-h="'+blueprint.meta.height+'" style="'+st.css+'">'+st.html+'</div><div id="layer"></div></div></div>\n'+
      '<button id="replay">↻ 重播施工</button><div id="hint">移动鼠标，光标群会追着你跑 · 建好的部分可以直接点</div><button id="goLive">完成 · 进入网站</button><span id="badge">built with SwarmSite</span>\n'+
      '<noscript><style>#hint,#replay,#badge,#goLive{display:none!important}</style></noscript>\n'+
      '<script id="render-src">\n'+renderSrc+'\n<\/script>\n'+
      '<script id="engine-src">\n'+engineSrc+'\n<\/script>\n'+
      '<script>\n'+bootJs+'\n<\/script>\n</body></html>';

    var name=(blueprint.meta.title||'site').replace(/[^\w\u4e00-\u9fa5-]+/g,'_')+'_swarm.html';
    var finish=function(finalHtml,note){
      window.__lastExport={name:name,html:finalHtml};
      download(name,finalHtml,'text/html;charset=utf-8');
      $('#share-text').value=sharePitch();
      $('#share-box').style.display='block';
      status('已导出：'+name+'（'+Math.round(finalHtml.length/1024)+' KB'+(note||'')+'）。直接双击就能看，发给别人也能播；别人禁用动画/爬虫抓取时看到的是完整静态页面。');
    };

    // 页面里如果走的是本机代理（/img/...），导出的文件必须还原成公开地址，
    // 否则别人拿到文件后打不开图。
    var embedBox=$('#exp-embed');
    var wantEmbed=!!(embedBox&&embedBox.checked&&location.protocol!=='file:');
    var items=wantEmbed?collectProxyImages(html):[];
    if(!items.length){ finish(rewriteProxyImages(html,null)); return; }

    status('正在把 '+items.length+' 张照片打包进这一个文件…');
    embedImages(items).then(function(map){
      var n=Object.keys(map).length;
      finish(rewriteProxyImages(html,map),'，已内嵌 '+n+' 张照片');
    }).catch(function(e){
      finish(rewriteProxyImages(html,null));
      status('照片内嵌失败（'+(e.message||e)+'），已改为外链图片导出。想内嵌请先双击「启动.bat」。');
    });
  }

  /* ---------- 场景与配色下拉初始化 ---------- */
  function initSelects(){
    var sc=$('#scene');Object.keys(BlueprintGen.SCENES).forEach(function(k){
      var o=document.createElement('option');o.value=k;o.textContent=BlueprintGen.SCENES[k].label;sc.appendChild(o);
    });
    var pal=$('#palette');Object.keys(BlueprintGen.PALETTES).forEach(function(k){
      var o=document.createElement('option');o.value=k;o.textContent=BlueprintGen.PALETTES[k].name;pal.appendChild(o);
    });
  }

  /* ---------- 事件 ---------- */
  $('#build').addEventListener('click',function(){
    var m=mode();
    if(m==='local'||m==='api'){ buildLLM(); return; }
    if(m==='bridge'){
      var txt=$('#blueprint-json').value.trim();
      if(jsonDirty&&txt&&(/[{\<]/.test(txt))){ ingest(txt,'剪贴板桥'); return; }
      copyPrompt();
      toast('提示词已复制：去 AI 拿结果，再点「从剪贴板导入」');
      return;
    }
    buildLocal();
  });
  $('#prompt').addEventListener('keydown',function(e){
    if(e.key!=='Enter'||e.shiftKey||e.isComposing) return;   // Shift+Enter 换行，中文输入法回车不误触
    e.preventDefault();
    $('#build').click();
  });
  $('#replay').addEventListener('click',function(){if(blueprint)run(blueprint);else status('先建一次站，才能重播。');});
  $('#speed').addEventListener('change',function(){if(engine)engine.setSpeed(parseInt(this.value,10)||1);});
  $('#follow').addEventListener('change',function(){if(engine)engine.setFollowScroll(this.checked);});
  $('#theme').addEventListener('change',function(){
    document.body.setAttribute('data-theme',this.value);
    try{ localStorage.setItem(LS_KEY+'.theme',this.value); }catch(e){}
    if(blueprint)run(blueprint);else status('主题已切换到「'+this.selectedOptions[0].textContent+'」。');
  });
  $('#advanced').addEventListener('click',function(){var p=$('#advanced-panel');p.hidden=!p.hidden;});
  $('#tab-content').addEventListener('click',function(){switchTab('content');});
  $('#tab-llm').addEventListener('click',function(){switchTab('llm');probeGateway(true);});
  $('#tab-patch').addEventListener('click',function(){switchTab('patch');probeGateway(true);});
  function switchTab(which){
    $('#pane-content').hidden=which!=='content';$('#pane-llm').hidden=which!=='llm';$('#pane-patch').hidden=which!=='patch';
    $('#tab-content').classList.toggle('on',which==='content');
    $('#tab-llm').classList.toggle('on',which==='llm');
    $('#tab-patch').classList.toggle('on',which==='patch');
  }
  $('#apply-edit').addEventListener('click',applyAndRebuild);
  $('#cta-action').addEventListener('change',updateCtaValueLabel);
  $('#palette').addEventListener('change',function(){
    if(!blueprint){return;}
    BlueprintGen.recolor(blueprint,this.value);
    $('#blueprint-json').value=JSON.stringify(blueprint,null,2);
    run(blueprint);status('已换配色并重新施工。');
  });
  $('#llm-mode').addEventListener('change',function(){switchMode();saveLlm(true);});
  $('#blueprint-json').addEventListener('input',function(){jsonDirty=true;});
  $('#copy-prompt').addEventListener('click',copyPrompt);
  $('#paste-bp').addEventListener('click',pasteBlueprint);
  $('#focus-json').addEventListener('click',function(){$('#blueprint-json').focus();status('把 AI 的回答粘到这里（含说明文字也行），然后点「从 JSON 建站」。');});
  $('#test-llm').addEventListener('click',testLLM);
  $('#run-llm').addEventListener('click',buildLLM);
  $('#save-llm').addEventListener('click',function(){saveLlm();});
  document.querySelectorAll('[data-preset]').forEach(function(b){
    b.addEventListener('click',function(){
      var p=PRESETS[b.getAttribute('data-preset')]; if(!p)return;
      $('#llm-url').value=p.url;$('#llm-model').value=p.model;
      if(mode()!=='api'&&mode()!=='local'){ $('#llm-mode').value='local'; switchMode(); }
      if(!(GW.ok&&GW.hasKey)) $('#llm-key').focus();
      status('已填入「'+b.textContent+'」的地址和模型。下一步：填 Key → 测试连接 → 保存到本机接口。');
    });
  });
  $('#patch-go').addEventListener('click',applyPatch);
  $('#patch-undo').addEventListener('click',undoPatch);
  $('#patch-input').addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){ applyPatch(); }
  });
  document.querySelectorAll('[data-chip]').forEach(function(b){
    b.addEventListener('click',function(){
      $('#patch-input').value=b.getAttribute('data-chip');
      $('#patch-input').focus();
      if(!blueprint) status('先「开工」建一个页面，再点这里改。');
    });
  });
  $('#gw-copy').addEventListener('click',function(){
    var dir=location.pathname.replace(/[\\/][^\\/]*$/,'');
    copyText('node server.js','启动命令已复制：在项目目录 '+dir+' 里执行（或直接双击「启动.bat」），然后用 http://127.0.0.1:5173 打开');
  });
  $('#gw-clear').addEventListener('click',function(){
    if(!GW.ok) return;
    fetch(gwApi('/config'),{method:'DELETE'}).then(function(r){return r.json();}).then(function(){
      GW.hasKey=false;GW.keyTail='';renderGateway();
      toast('已清掉本机接口里的 Key');
    });
  });
  $('#from-json').addEventListener('click',function(){
    var txt=$('#blueprint-json').value.trim();
    if(!txt){status('先把蓝图 JSON（或模型给的 HTML）粘进来。');return;}
    ingest(txt,'导入');
  });
  $('#copy-json').addEventListener('click',function(){
    if(!blueprint)return;
    copyText(JSON.stringify(blueprint,null,2),'蓝图 JSON 已复制。');
  });
  $('#copy-share').addEventListener('click',function(){
    copyText($('#share-text').value,'话术已复制，去发给对方吧。');
  });
  /* ---------- 点选编辑：事件 ---------- */
  $('#btn-edit').addEventListener('click',function(){ enterEdit(!EDIT.on); });
  $('#insp-close').addEventListener('click',function(){ selectBlock(null); });

  // 捕获阶段拦：编辑态下页面里的导航/按钮不跳走，只用来选中
  // 双击进入就地输入用自己算的连击（浏览器的 dblclick 会被 mousedown 的 preventDefault 吃掉）
  var lastTap={id:'',t:0};
  page.addEventListener('mousedown',function(e){
    if(!EDIT.on) return;
    if(e.target&&e.target.closest&&e.target.closest('[contenteditable="true"]')) return;
    e.preventDefault();                      // 别把整页文字刷蓝
  },true);
  page.addEventListener('click',function(e){
    if(!EDIT.on) return;
    if(e.target&&e.target.closest&&e.target.closest('[contenteditable="true"]')) return;
    e.preventDefault();e.stopPropagation();
    var el=e.target&&e.target.closest?e.target.closest('.blk'):null;
    selectBlock(el||null);
    if(!el) return;
    var id=String(el.id||''),now=Date.now();
    if(id===lastTap.id&&now-lastTap.t<450){
      lastTap={id:'',t:0};
      var b=editCurrent();
      if(b&&b.type==='text') startInline(el);
    }else{
      lastTap={id:id,t:now};
    }
  },true);

  function stylePatch(fn){
    mutate(function(b){ b.style=b.style||{}; fn(b,b.style); },true);
  }

  $('#ir-text').addEventListener('input',function(){
    var v=this.value;
    mutate(function(b){ b.text=v; },true);
  });
  $('#ir-size').addEventListener('input',function(){
    var v=parseFloat(this.value); if(!isFinite(v)) return;
    stylePatch(function(b,s){ s.fontSize=Math.round(v)+'px'; });
  });
  $('#ir-weight').addEventListener('change',function(){
    var v=this.value;
    stylePatch(function(b,s){ s.fontWeight=v; });
  });
  $('#ir-lh').addEventListener('input',function(){
    var v=parseFloat(this.value);
    stylePatch(function(b,s){ if(isFinite(v)) s.lineHeight=String(v); else delete s.lineHeight; });
  });
  $('#ir-color').addEventListener('input',function(){
    var v=this.value;
    stylePatch(function(b,s){ s.color=v; });
  });
  $('#ir-fill').addEventListener('input',function(){
    var v=this.value;
    stylePatch(function(b,s){ s.background=v; });
    $('#ir-fill-note').textContent='';
  });
  $('#ir-radius').addEventListener('input',function(){
    var v=parseFloat(this.value); if(!isFinite(v)) return;
    stylePatch(function(b,s){ s.borderRadius=Math.round(v)+'px'; });
  });
  $('#ir-opacity').addEventListener('input',function(){
    var v=parseFloat(this.value); if(!isFinite(v)) return;
    stylePatch(function(b,s){ s.opacity=String(Math.round(v*100)/100); });
  });
  $('#ir-align').addEventListener('click',function(e){
    var btn=e.target&&e.target.closest?e.target.closest('button[data-v]'):null;
    if(!btn) return;
    var v=btn.getAttribute('data-v');
    mutate(function(b){ b.align=v; });
  });
  ['x','y','w','h','z'].forEach(function(k){
    $('#ir-'+k).addEventListener('input',function(){
      var v=parseFloat(this.value); if(!isFinite(v)) return;
      var val=Math.round(v);
      mutate(function(b){
        if(k==='w') b.w=Math.max(8,val);
        else if(k==='h') b.h=Math.max(8,val);
        else if(k==='z') b.z=Math.max(0,Math.min(99,val));
        else b[k]=Math.max(0,val);
      },true);
    });
  });
  $('#ir-dup').addEventListener('click',duplicateBlock);
  $('#ir-del').addEventListener('click',deleteBlock);
  $('#ir-undo').addEventListener('click',undoEdit);
  $('#ir-photo-next').addEventListener('click',nextPhoto);
  $('#ir-photo-up').addEventListener('click',useOwnPhoto);

  // 选中块跟着页面滚动走
  var inspTick=false;
  stage.addEventListener('scroll',function(){
    if(!EDIT.on||!EDIT.selId||inspTick) return;
    inspTick=true;
    requestAnimationFrame(function(){ inspTick=false; positionInspector(); });
  },{passive:true});
  window.addEventListener('resize',function(){ if(EDIT.on) positionInspector(); });

  document.addEventListener('keydown',function(e){
    if(!EDIT.on) return;
    var ae=document.activeElement;
    var tag=ae?(ae.tagName||''):'';
    var typing=(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||tag==='OPTION'||!!(ae&&ae.isContentEditable));
    if(e.key==='Escape'){
      if(EDIT.inline){ endInline(); e.preventDefault(); return; }
      if(EDIT.selId){ selectBlock(null); e.preventDefault(); return; }
      enterEdit(false); e.preventDefault(); return;
    }
    if((e.ctrlKey||e.metaKey)&&(e.key==='z'||e.key==='Z')&&!typing){ undoEdit(); e.preventDefault(); return; }
    if(typing||!EDIT.selId) return;
    var step=e.shiftKey?10:1,dx=0,dy=0;
    if(e.key==='ArrowLeft') dx=-step;
    else if(e.key==='ArrowRight') dx=step;
    else if(e.key==='ArrowUp') dy=-step;
    else if(e.key==='ArrowDown') dy=step;
    else if(e.key==='Delete'||e.key==='Backspace'){ deleteBlock(); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    editNudge(dx,dy);
  });

  $('#goLive').addEventListener('click',function(){
    if(engine){engine.finish();engine=null;}
    bindActions();
    // 施工时镜头一直往下跟，进入网站时先回到首屏，像真的打开一个网页
    try{stage.scrollTo({top:0,behavior:'smooth'});}catch(e){stage.scrollTop=0;}
    showGoLive(false);showExport(true);
    status('已进入真实页面：导航可跳转、卡片可点、按钮可拨号/复制微信/发邮件，底部有真实联系方式。');
  });
  // 施工中用户自己点内容 → 镜头别抢，让他先看
  page.addEventListener('click',function(){if(engine&&!built)engine.pauseFollow(6);},true);
  $('#exp-html').addEventListener('click',exportHTML);
  $('#exp-blueprint').addEventListener('click',function(){
    if(!blueprint)return;
    download((blueprint.meta.title||'site')+'_blueprint.json',JSON.stringify(blueprint,null,2),'application/json');
  });
  window.addEventListener('resize',fit);

  initSelects();updateCtaValueLabel();loadLlm();switchMode();bindAttachUI();
  // 探测本机接口：通了就把地址/模型补上；已经存过 Key 就默认走在线 API，开箱即用
  probeGateway().then(function(g){
    if(!g.ok){ switchMode(); return; }
    if(!$('#llm-url').value&&g.baseUrl) $('#llm-url').value=g.baseUrl;
    if(!$('#llm-model').value&&g.model) $('#llm-model').value=g.model;
    var hasSaved=false;try{ hasSaved=!!localStorage.getItem(LS_KEY); }catch(e){}
    if(g.hasKey&&mode()==='offline'&&!hasSaved){ $('#llm-mode').value='api'; }
    switchMode();
    if(g.hasKey) status('本机接口已就绪（'+g.baseUrl+' · '+g.model+'）· 直接点「开工」就让模型生成蓝图。');
  });
  var savedTheme=null;try{ savedTheme=localStorage.getItem(LS_KEY+'.theme'); }catch(e){}
  if(savedTheme&&$('#theme').querySelector('option[value="'+savedTheme+'"]')) $('#theme').value=savedTheme;
  document.body.setAttribute('data-theme',$('#theme').value);
  $('#prompt').value='做一个美甲店的预约页';
  // 初始就渲染一份默认字段，保证第一次点 ⚙ 能看到可编辑内容
  (function(){
    var demo=BlueprintGen.build($('#prompt').value,{});
    fillControlsFromBlueprint(demo);
  })();
  window.addEventListener('DOMContentLoaded',function(){fit();});
  fit();
})();
