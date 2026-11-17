const puppeteer=require('puppeteer-core');
const http=require('http');
const path=require('path');
const ROOT=path.resolve(__dirname,'..');
const APP='file:///'+ROOT.split('\\').join('/')+'/index.html';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;
function ok(n,c,e){ if(c){pass++;console.log('  PASS '+n)}else{fail++;console.log('  FAIL '+n+(e?' :: '+e:''))} }

const BP = JSON.stringify({
  meta:{title:'接口生成站',width:1200,height:900,bg:'#0b1220'},
  blocks:[
    {id:'h1',type:'text',x:80,y:60,w:600,h:60,style:{fontSize:'48px',fontWeight:'800',color:'#fff'},text:'模型写的标题'},
    {id:'p1',type:'text',x:80,y:140,w:600,h:80,style:{fontSize:'16px',color:'#9fb0c9'},text:'这段文字来自一个 OpenAI 兼容接口。'},
    {id:'n1',type:'text',x:800,y:44,w:90,h:26,text:'产品',label:'nav link'},
    {id:'n2',type:'text',x:900,y:44,w:90,h:26,text:'联系',label:'nav link'},
    {id:'btn',type:'rect',x:80,y:260,w:200,h:56,style:{background:'#1f6feb',borderRadius:'8px'},label:'button',action:'wechat',actionValue:'api_demo'},
    {id:'sec',type:'text',x:80,y:600,w:500,h:40,style:{fontSize:'28px'},text:'下半屏区块'},
    {id:'card',type:'rect',x:80,y:660,w:300,h:200,style:{background:'#16233a',borderRadius:'12px'},label:'card master'},
    {id:'card2',type:'duplicate',x:420,y:660,w:300,h:200,master:'card',style:{background:'#16233a',borderRadius:'12px'},label:'card copy'}
  ]
});

let mode='ok';
const srv=http.createServer((req,res)=>{
  const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Content-Type':'application/json'};
  if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}
  let body='';
  req.on('data',c=>body+=c);
  req.on('end',()=>{
    if(mode==='500'){ res.writeHead(500,cors); res.end(JSON.stringify({error:'boom'})); return; }
    // 故意返回"带前言 + 代码围栏"的内容，模拟真实模型
    const content='好的，这是蓝图：\n```json\n'+BP+'\n```\n需要调整告诉我。';
    res.writeHead(200,cors);
    res.end(JSON.stringify({choices:[{message:{content:content}}]}));
  });
});

(async()=>{
  await new Promise(r=>srv.listen(18089,'127.0.0.1',r));
  const b=await puppeteer.launch({executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:'new',args:['--no-sandbox','--allow-file-access-from-files']});
  const p=await b.newPage(); await p.setViewport({width:1440,height:900});
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(APP,{waitUntil:'load'});
  await p.click('#advanced');
  await p.click('#tab-llm');

  console.log('\n=== 模式切换 ===');
  await p.select('#llm-mode','bridge');
  const bridge=await p.evaluate(()=>({
    box:!document.querySelector('#mode-bridge').hidden,
    url:getComputedStyle(document.querySelector('#row-url')).display,
    key:getComputedStyle(document.querySelector('#lab-key')).display
  }));
  ok('剪贴板桥显示说明、隐藏网络配置', bridge.box && bridge.url==='none' && bridge.key==='none', JSON.stringify(bridge));

  await p.select('#llm-mode','api');
  const api=await p.evaluate(()=>({
    box:!document.querySelector('#mode-api').hidden,
    url:getComputedStyle(document.querySelector('#row-url')).display,
    key:getComputedStyle(document.querySelector('#lab-key')).display,
    test:getComputedStyle(document.querySelector('#test-llm')).display
  }));
  ok('API 模式显示地址/Key/测试按钮', api.box && api.url!=='none' && api.key!=='none' && api.test!=='none', JSON.stringify(api));

  await p.select('#llm-mode','local');
  const local=await p.evaluate(()=>({key:getComputedStyle(document.querySelector('#lab-key')).display,model:getComputedStyle(document.querySelector('#lab-model')).display}));
  ok('本地模型模式不需要 Key', local.key==='none' && local.model!=='none', JSON.stringify(local));

  await p.evaluate(()=>{
    document.querySelector('[data-preset=ollama]').click();
  });
  const preset=await p.evaluate(()=>({url:document.querySelector('#llm-url').value,model:document.querySelector('#llm-model').value}));
  ok('Ollama 预设能一键填入', /11434/.test(preset.url) && !!preset.model, JSON.stringify(preset));

  console.log('\n=== 真实接口调用 ===');
  await p.select('#llm-mode','local');
  await p.evaluate(()=>{
    document.querySelector('#llm-url').value='http://127.0.0.1:18089/v1';
    document.querySelector('#llm-model').value='fake-model';
    document.querySelector('#prompt').value='做一个 AI 写作工具落地页';
  });
  await p.click('#test-llm');
  await sleep(900);
  const testStatus=await p.evaluate(()=>document.querySelector('#status').textContent);
  ok('测试连接成功并给出地址', /连接成功/.test(testStatus) && /chat\/completions/.test(testStatus), testStatus);

  await p.click('#run-llm');
  await sleep(1400);
  const built=await p.evaluate(()=>({
    blocks:document.querySelectorAll('#page .blk').length,
    status:document.querySelector('#status').textContent,
    title:document.querySelector('#page [data-bind=title1]')?document.querySelector('#page [data-bind=title1]').getAttribute('data-text'):'',
    engine:!!window.__swarmEngine
  }));
  ok('接口返回的蓝图能直接建站', built.blocks===8, 'blocks='+built.blocks+' · '+built.status);
  const toastTxt=await p.evaluate(()=>document.querySelector('#toast')?document.querySelector('#toast').textContent:'');
  ok('围栏+前言被自动剥掉（并提示修了什么）', /自动修好|已导入/.test(toastTxt), 'toast='+toastTxt+' status='+built.status);
  ok('引擎已开始施工', built.engine);

  console.log('\n=== 接口报错可读 ===');
  mode='500';
  await p.click('#test-llm');
  await sleep(800);
  const errStatus=await p.evaluate(()=>document.querySelector('#status').textContent);
  ok('HTTP 500 会显示状态码并给出退路', /HTTP 500/.test(errStatus) && /剪贴板桥/.test(errStatus), errStatus);

  ok('全程无运行时错误', errs.length===0, errs.join(' | '));

  await b.close(); srv.close();
  console.log('\n通过 '+pass+'，失败 '+fail);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);srv.close();process.exit(2)});
