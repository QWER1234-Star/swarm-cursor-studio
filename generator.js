/* generator.js — 自然语言 -> 结构化蓝图（离线可用，也是 LLM 输出格式的参照实现）
   蓝图 schema v2:
   {
     meta:{ title, industry, palette, paletteKey, width, height, bg, contact, ctaAction },
     blocks:[{
       id, type: rect|text|line|image|guide|duplicate,
       x,y,w,h,z, style:{ css属性名:值 },
       text, role, label, code, orient, image,
       deps:[id], master:id,
       bind:'brand|title1|title2|subtitle|cta|feature1t|...',  // 可编辑字段绑定
       action:'tel|wechat|mailto|link', actionValue:'...'      // CTA 行为
     }]
   }
*/
window.BlueprintGen = (function(){
  'use strict';

  var PALETTES = {
    warm:  { key:'warm',  name:'暖纸', bg:'#f6f1e8', ink:'#2b2119', accent:'#a8613c', soft:'#efe0cf', muted:'#7a6a5c', surface:'#fffaf2', border:'#e3d8c8', paper:'#fffaf2' },
    dark:  { key:'dark',  name:'夜航', bg:'#0d1117', ink:'#f0f6fc', accent:'#4f8cff', soft:'#152238', muted:'#8b949e', surface:'#161b22', border:'#2a323d', paper:'#f0f6fc' },
    paper: { key:'paper', name:'编辑', bg:'#faf9f6', ink:'#141414', accent:'#d94f2b', soft:'#f0ece4', muted:'#666666', surface:'#ffffff', border:'#e6e2da', paper:'#ffffff' },
    green: { key:'green', name:'苔原', bg:'#f2f7f2', ink:'#17301c', accent:'#2f7d4f', soft:'#dcecdc', muted:'#5d7a63', surface:'#ffffff', border:'#d6e6d8', paper:'#ffffff' },
    violet:{ key:'violet',name:'星云', bg:'#f7f4fb', ink:'#241635', accent:'#7c4dcc', soft:'#e9ddf6', muted:'#73658a', surface:'#ffffff', border:'#e4d9f0', paper:'#ffffff' },
    blueprint:{ key:'blueprint', name:'工程', bg:'#f2f6fb', ink:'#14263d', accent:'#2563eb', soft:'#dce8fb', muted:'#64748b', surface:'#ffffff', border:'#d8e3f2', paper:'#ffffff' },
    rose:  { key:'rose',  name:'胭脂', bg:'#fdf3f4', ink:'#331a20', accent:'#c8416b', soft:'#f7dfe6', muted:'#8a6670', surface:'#ffffff', border:'#f0dbe1', paper:'#ffffff' },
    mint:  { key:'mint',  name:'薄荷', bg:'#f0faf7', ink:'#12342b', accent:'#0f9b7a', soft:'#d5f0e7', muted:'#5c8077', surface:'#ffffff', border:'#d3ebe2', paper:'#ffffff' }
  };

  var GRADIENTS = {
    coffee:'linear-gradient(135deg,#c8a27a 0%,#8a5a3b 48%,#3d2418 100%)',
    tech:'linear-gradient(140deg,#1b2a4a 0%,#2f6df6 48%,#63d3ff 100%)',
    food:'linear-gradient(135deg,#e8b26a 0%,#c45b3a 55%,#5d1f18 100%)',
    studio:'linear-gradient(135deg,#d9c3f0 0%,#7c4dcc 50%,#241635 100%)',
    nature:'linear-gradient(135deg,#bfe0b5 0%,#3f8f5c 52%,#123a22 100%)',
    event:'linear-gradient(135deg,#ffd28a 0%,#f24822 55%,#6b1220 100%)',
    personal:'linear-gradient(135deg,#cfe3ff 0%,#5b8cff 50%,#243b73 100%)',
    craft:'linear-gradient(135deg,#f3d9c4 0%,#c98a63 50%,#6b3f2a 100%)'
  };

  /* ---------- 内置照片库：全部为已验证可访问的无版权摄影作品（Unsplash CDN 直链） ----------
     设计取舍：只放固定 ID，不做运行时搜索 —— 零 Key、零配置、不依赖任何接口。
     每张图都配一个渐变兜底（imageFallback），图片加载失败时自动露出渐变，绝不裂图。 */
  var PHOTOS = {
    coffee:['photo-1509042239860-f550ce710b93','photo-1495474472287-4d71bcdd2085','photo-1501339847302-ac426a4a7cbb','photo-1521017432531-fbd92d768814','photo-1442512595331-e89e73853f31'],
    tech:['photo-1497366216548-37526070297c','photo-1498050108023-c5249f4df085','photo-1461749280684-dccba630e2f6','photo-1516321318423-f06f85e504b3','photo-1531482615713-2afd69097998'],
    food:['photo-1517248135467-4c7edcad34c4','photo-1414235077428-338989a2e8c0','photo-1504674900247-0877df9cc836','photo-1546069901-ba9599a7e63c','photo-1490645935967-10de6ba17061'],
    studio:['photo-1558655146-9f40138edfeb','photo-1452587925148-ce544e77e70d','photo-1524758631624-e2822e304c36','photo-1497366811353-6870744d04b2','photo-1497215728101-856f4ea42174'],
    nature:['photo-1441974231531-c6227db76b6e','photo-1470071459604-3b5ec3a7fe05','photo-1501785888041-af3ef285b470','photo-1469474968028-56623f02e42e','photo-1506905925346-21bda4d32df4'],
    event:['photo-1540575467063-178a50c2df87','photo-1501281668745-f7f57925c3b4','photo-1511578314322-379afb476865','photo-1531058020387-3be344556be6'],
    personal:['photo-1519085360753-af0119f7cbe7','photo-1507003211169-0a1dd7228f2d','photo-1522202176988-66273c2fd55f','photo-1521737604893-d14cc237f11d','photo-1524504388940-b1c1722653e1'],
    craft:['photo-1604654894610-df63bc536371','photo-1610992015732-2449b76344bc','photo-1519014816548-bf5fe059798b','photo-1522337360788-8b13dee7a37e','photo-1487412947147-5cebf100ffc2']
  };
  var PHOTO_FALLBACK = ['tech','studio','nature','personal','coffee','event','food','craft'];

  function photoUrl(id, w){
    var ww=w||1200;
    // 跑在本机接口下（http://127.0.0.1）时走同源代理：有磁盘缓存、可重试，
    // 不会再出现"批量生成时图间歇性加载失败只剩渐变"的情况。
    // 双击 index.html 或导出后的单文件没有代理，回落到公开 CDN。
    if(typeof window!=='undefined'&&window.__SWARM_IMG_PROXY){
      return 'url(/img/'+id+'?w='+ww+')';
    }
    return 'url(https://images.unsplash.com/'+id+'?w='+ww+'&q=80&auto=format&fit=crop)';
  }
  /* 同一个 grad 组里按 seed 稳定取图：同一句话每次生成同一张，不会刷新就换脸 */
  function pickPhoto(gradKey, seed, step){
    var list = PHOTOS[gradKey] || PHOTOS[PHOTO_FALLBACK[(seed>>>0)%PHOTO_FALLBACK.length]] || PHOTOS.studio;
    var i = ((seed>>>0) + (step||0)*3) % list.length;
    return list[i];
  }
  function hashSeed(str){
    var h=2166136261;
    str=String(str||'');
    for(var i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); }
    return h>>>0;
  }

  // 场景 = 当下真实需求。每个场景是一份文案包，共用同一套施工骨架。
  var SCENES = {
    personal:{
      label:'个人名片 / 个人品牌', kw:['个人名片','名片','自由职业','副业','自我介绍','关于我','个人品牌','找我聊','个人主页'],
      name:'你好，我是自己', palette:'blueprint', grad:'personal',
      eyebrow:'HELLO · I AM', title:['你好，我是', '一个认真做事的人。'],
      sub:'我把复杂的东西讲清楚，把想法落地成能用的东西。如果你想聊聊合作、聊聊想法，或者只是想认识一下，都欢迎找我。',
      cta:'加我聊聊', nav:['关于我','我能做什么','联系方式','作品'],
      features:[['我能帮你做什么','从想法到落地，陪你把一件事想清楚、做出来、讲明白。'],['我的工作方式','先听清楚问题，再动手。过程透明，结果可交付。'],['找我聊什么','合作邀约、职业建议、项目咨询，或者一场坦诚的对话。']],
      stats:[['8','年行业经验'],['120+','合作过的人'],['认真','是默认设置']],
      foot:'个人主页 · 用作品和行动说话', trust:'合作过的朋友这样说'
    },
    portfolio:{
      label:'求职作品集', kw:['作品集','portfolio','设计师','开发','求职','应聘','简历','项目展示','案例'],
      name:'MY WORK', palette:'paper', grad:'studio',
      eyebrow:'SELECTED WORK · 2024—2026', title:['用作品', '说话。'],
      sub:'这里是我的精选项目。每个项目我都写清楚了问题、我的角色和最后的结果——因为过程比漂亮的截图更重要。',
      cta:'查看完整作品集', nav:['作品','关于','技能','联系'],
      features:[['项目一 · 从0到1','一个真实业务场景，从需求梳理到上线，我负责设计与实现。'],['项目二 · 体验优化','找到关键摩擦点，用数据和用户反馈驱动迭代，指标显著改善。'],['项目三 · 跨界协作','和不同角色一起把复杂想法落地，过程透明、结果可交付。']],
      stats:[['12','个完整项目'],['3','年实战经验'],['100%','按时交付']],
      foot:'作品集 · 期待与你聊聊下一个项目', trust:'合作方评价'
    },
    localbiz:{
      label:'本地生意 / 门店获客', kw:['美甲','理发','健身','宠物','家政','门店','探店','预约','到店','洗车','瑜伽馆','工作室','实体店','服务'],
      name:'巷子里的小店', palette:'warm', grad:'craft',
      eyebrow:'COME AS YOU ARE', title:['在你身边，', '做点踏实的小事。'],
      sub:'我们是一家认真做事的小店。没有花哨的套路，只有稳定的手艺和舒服的相处。来过的人，大多会再来。',
      cta:'立即预约', nav:['项目','价格','环境','联系'],
      features:[['招牌服务','做的最多、也最拿手的那件事，回头客都冲着它来。'],['透明价格','明码标价，没有隐形消费，来之前心里就有数。'],['舒服的环境','干净、放松、不催促，把这段时间留给自己。']],
      stats:[['4.9','真实评分'],['2000+','服务过的人'],['8年','开店时间']],
      foot:'巷子里的小店 · 期待见到你', trust:'客人们的真实反馈'
    },
    course:{
      label:'课程 / 社群招募', kw:['课程','培训','社群','训练营','报名','学习','知识付费',' taught','教学','陪跑','打卡'],
      name:'一起做件事', palette:'violet', grad:'event',
      eyebrow:'LEARN BY DOING', title:['别再收藏了，', '这次真的做出来。'],
      sub:'这不是一套看完就忘的课。我们边讲边做，四周时间，带你从零完成一个属于自己的作品。看完不是终点，做出来才是。',
      cta:'报名登记', nav:['课程介绍','适合谁','学员作品','报名'],
      features:[['边学边做','每节课都有明确的产出，四周后你手里会有一个真实的东西。'],['真人陪跑','有问题随时问，卡住的地方我们一起过，不让你一个人硬扛。'],['同伴同行','一群同频的人一起做，互相看、互相鼓励，比你想象的有动力。']],
      stats:[['6','期已开营'],['800+','学员'],['92%','完成率']],
      foot:'一起做件事 · 下期见', trust:'学员们的真实反馈'
    },
    bio:{
      label:'自媒体 / 链接主页', kw:['自媒体','博主','公众号','小红书','抖音','b站','bilibili','链接','主页','关注','内容创作','vlog'],
      name:'@我的主页', palette:'dark', grad:'tech',
      eyebrow:'FIND ME EVERYWHERE', title:['在这里，', '找到我做的东西。'],
      sub:'我写文章、拍视频、分享正在学的东西。所有内容和联系方式都整理在这里，谢谢你路过，希望有一样对你有用。',
      cta:'关注我', nav:['精选内容','关于我','联系','更多'],
      features:[['每周更新','写点真实的观察和思考，不追热点，只写想明白的事。'],['视频与播客','用更轻松的方式聊复杂的话题，通勤路上也能听。'],['找我合作','商务合作、内容共创、读者交流，都欢迎在下面找到我。']],
      stats:[['50+','原创内容'],['12k','关注者'],['每周','稳定更新']],
      foot:'我的主页 · 感谢你的关注', trust:'平台与合作伙伴'
    },
    coffee:{ label:'咖啡 / 茶饮', kw:['咖啡','coffee','咖啡馆','茶饮','奶茶','烘焙'], name:'MORNING BREW', palette:'warm', grad:'coffee',
      eyebrow:'COFFEE · COMMUNITY · CRAFT', title:['Good mornings,','brewed slowly.'],
      sub:'我们从产区挑豆，用心烘焙，把每一杯都当作一次日常里的小小仪式。来坐一会儿，咖啡刚好的温度。',
      cta:'看看菜单', nav:['首页','菜单','门店','关于我们'],
      features:[['单品手冲','每周更换豆单，诚恳地呈现产地风土与烘焙师的判断。'],['季节特调','当季水果与香料，克制而清醒的甜，适合慢慢喝。'],['社区空间','长桌、杂志和不太吵的音乐，欢迎带书来坐一下午。']],
      stats:[['12','年烘焙经验'],['28','支合作庄园'],['9am','每天开门']], foot:'早安咖啡 · 认真做咖啡的第 12 年', trust:'被这些朋友推荐过' },
    tech:{ label:'科技 / AI 产品', kw:['科技','ai','AI','写作','工具','saas','SaaS','软件','开发者','平台','api','API','效率','智能'], name:'LUMEN', palette:'dark', grad:'tech',
      eyebrow:'AI WRITING, REIMAGINED', title:['Write at the speed','of thought.'],
      sub:'Lumen 是懂你语气的 AI 写作搭档。从一句灵感出发，到一篇成稿，保持你的声音，不被模板吞掉。',
      cta:'免费开始', nav:['产品','能力','价格','文档'],
      features:[['你的语气，被记住','读几段你的旧文字，Lumen 学会你的节奏、用词和停顿。'],['从零到成稿','大纲、初稿、改写、润色，一条时间线里全部完成。'],['团队共享声音','把风格变成团队资产，每个人写出来都像一个人写的。']],
      stats:[['40k+','创作者在用'],['18ms','首字延迟'],['99.9%','服务可用性']], foot:'Lumen Labs · 让写作更像思考', trust:'这些团队已经在用' },
    food:{ label:'餐厅 / 美食', kw:['餐厅','餐饮','美食','food','饭店','料理','厨房'], name:'TABLE & CO.', palette:'warm', grad:'food',
      eyebrow:'SEASONAL KITCHEN · EST. 2019', title:['A table worth','coming back to.'],
      sub:'只用当季食材，简单直接的烹饪。我们相信好味道不需要解释太多，坐下来尝一口就懂了。',
      cta:'预订座位', nav:['菜单','故事','预订','联系'],
      features:[['当日食材','每天早上从合作农场直送，菜单跟着节气走。'],['开放厨房','看得见的烹饪过程，厨师乐意聊聊每道菜的来处。'],['慢慢吃','我们不赶客人，一顿饭值得两三个小时。']],
      stats:[['4.9','平均评分'],['12','道当季菜'],['2019','开店年份']], foot:'餐桌公司 · 好好吃饭，认真生活', trust:'媒体与食客的推荐' },
    studio:{ label:'工作室 / 创意', kw:['工作室','设计','创意','画室','studio','摄影'], name:'STUDIO NORTH', palette:'paper', grad:'studio',
      eyebrow:'SELECTED WORK · 2021—2026', title:['Small studio,','careful work.'],
      sub:'我们是一间做品牌与数字体验的小工作室。每年只接少量项目，把时间花在真正重要的问题上。',
      cta:'看看作品', nav:['作品','关于','服务','联系'],
      features:[['品牌系统','从名字到语气，从标志到应用，建立一套能自己生长的语言。'],['数字体验','网站与产品界面，兼顾美感、可用性和工程的现实。'],['长期陪伴','我们不做一次性交付，而是和团队一起把事情做久。']],
      stats:[['38','完成项目'],['11','合作年限'],['6','人的小团队']], foot:'北边工作室 · 认真对待每一次合作', trust:'合作伙伴' },
    nature:{ label:'自然 / 环保', kw:['环保','自然','植物','旅行','户外','yoga','瑜伽','健康','养生','花','花园'], name:'FIELD NOTES', palette:'green', grad:'nature',
      eyebrow:'SLOW LIVING · OUTDOORS', title:['Grow slowly,','live fully.'],
      sub:'关于植物、土地和慢下来的日常。我们分享实用的种植笔记，也分享在户外重新找回节奏的方法。',
      cta:'开始阅读', nav:['笔记','指南','商店','关于'],
      features:[['种植笔记','从阳台到院子，可复制的季节性种植清单。'],['户外指南','轻装出发，找到离家不远的好路线。'],['生活商店','耐用的工具与器皿，少而好用。']],
      stats:[['120+','种植笔记'],['46','条路线'],['8k','订阅读者']], foot:'田野笔记 · 与自然保持联系', trust:'被这些地方报道过' },
    event:{ label:'活动 / 峰会', kw:['活动','会议','大会','conference','峰会','沙龙','音乐节','展会','派对'], name:'GATHER', palette:'violet', grad:'event',
      eyebrow:'ONE DAY · MANY IDEAS', title:['ideas collide,','people connect.'],
      sub:'一场关于创意与技术的聚会。一天，六场分享，一百个新认识的人。带上好奇心来就够了。',
      cta:'立即报名', nav:['日程','讲者','地点','报名'],
      features:[['六场深度分享','没有空泛的口号，只有讲者真正做过的事和数据。'],['自由交流','长长的茶歇和晚餐，让认识一个人变得自然。'],['现场工作坊','带着笔记本离开，而不是只带一张名片。']],
      stats:[['600','现场席位'],['18','位讲者'],['1','天足够了']], foot:'GATHER · 让好想法遇见彼此', trust:'往届合作伙伴' },
    // 兜底场景：关键词都没命中时，把用户那句话里的"业务词"填进来，文案照样像人写的
    generic:{ label:'通用 · 按你的话生成', kw:[], name:'你的品牌', palette:'paper', grad:'studio',
      eyebrow:'{svc} · 认真做的一件事', title:['{svc}，','做得再认真一点。'],
      sub:'这一页只讲一件事：{svc}。我们不做很多，只把这件事做到让人愿意推荐给朋友。价格、时间、联系方式都在下面，随时可以找我。',
      cta:'现在联系', nav:['在做什么','为什么选我们','价格','联系'],
      features:[['{svc}是怎么做的','不赶工、不糊弄，每一步都能跟你说清楚。'],['为什么值得选我们','回头客占大多数，口碑比广告更实在。'],['怎么开始','点下面的按钮联系我，说清楚你的需求就行。']],
      stats:[['1','件事做到极致'],['100%','认真对待'],['随时','可以联系']],
      foot:'{svc} · 随时可以聊', trust:'来自客户的真实反馈' }
  };

  var DEFAULT = SCENES.generic;

  function detect(prompt){
    var p=String(prompt||'');
    // 优先匹配更具体的当下场景，再退回通用
    var priority=['personal','portfolio','localbiz','course','bio','coffee','food','tech','studio','nature','event'];
    for(var i=0;i<priority.length;i++){
      var s=SCENES[priority[i]];
      for(var j=0;j<s.kw.length;j++) if(p.indexOf(s.kw[j])>=0) return s;
    }
    return DEFAULT;
  }
  // 从一句话里抠出"到底在卖什么/做什么"，用来填 {svc}
  function extractService(prompt){
    var p=String(prompt||'');
    var m=p.match(/(?:做一个|做个|帮我做|帮我|生成|设计|搭一个|来个|要一个)([^，。,;；\n]{2,18})/);
    var seg=m?m[1]:p;
    seg=seg.replace(/(的)?(落地页|预约页|主页|官网|网站|页面|网店|小程序|名片|介绍页|展示页|宣传页|报名页|单页)$/,'');
    seg=seg.replace(/^(一个|个|家|间|做|卖|关于|给)/,'');
    var hit=seg.match(/^([\u4e00-\u9fa5A-Za-z0-9·]{2,10}?)(店|馆|工作室|公司|品牌|服务|项目|中心|学院|事务所|厨房|咖啡|餐厅)/);
    if(hit) return hit[1]+hit[2];
    seg=seg.trim();
    return seg.length>=2?seg.slice(0,12):'这件事';
  }
  function detectPalette(prompt, fallback){
    var p=String(prompt||'');
    if(/暗|深|黑|night|dark|科技/i.test(p)) return PALETTES.dark;
    if(/咖啡|暖|米|奶油|木|warm|brown/i.test(p)) return PALETTES.warm;
    if(/绿|森林|自然|植物|薄荷|green|mint/i.test(p)) return PALETTES.green;
    if(/紫|梦幻|星|violet|purple/i.test(p)) return PALETTES.violet;
    if(/粉|胭脂|玫瑰|rose|pink/i.test(p)) return PALETTES.rose;
    if(/蓝|工程|技术|blue|blueprint/i.test(p)) return PALETTES.blueprint;
    if(/编辑|杂志|报纸|红|editorial/i.test(p)) return PALETTES.paper;
    return PALETTES[fallback]||PALETTES.paper;
  }
  function extractBrand(prompt){
    var m=String(prompt||'').match(/[“"'「]([^”"'」]{1,24})[”"'」]/);
    if(m) return m[1];
    m=String(prompt||'').match(/(?:叫|名为|品牌名|名字是|名叫)\s*([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5·&]{0,20})/);
    return m?m[1]:null;
  }

  // options: { sceneKey, paletteKey, brand, edits, contact, ctaAction, ctaValue }
  function build(prompt, options){
    options=options||{};
    var s=options.sceneKey&&SCENES[options.sceneKey]?SCENES[options.sceneKey]:detect(prompt);
    var pal=options.paletteKey&&PALETTES[options.paletteKey]?PALETTES[options.paletteKey]:detectPalette(prompt,s.palette);
    var brand=options.brand||extractBrand(prompt)||s.name;
    var grad=GRADIENTS[s.grad]||GRADIENTS.studio;
    var seed=hashSeed(prompt+'|'+(s.grad||''));
    function photo(step,w){ return photoUrl(pickPhoto(s.grad,seed,step),w||1200); }
    var W=1200,PAD=80,CW=W-PAD*2;
    var blocks=[];
    var uid=0;
    function add(type,x,y,w,h,style,extra){
      var b={id:'b'+(++uid),type:type,x:x,y:y,w:w,h:h,z:(extra&&extra.z)||1,style:style||{}};
      if(extra) for(var k in extra) if(extra.hasOwnProperty(k)) b[k]=extra[k];
      blocks.push(b); return b;
    }
    function T(x,y,w,h,text,style,extra){
      var st={fontSize:'18px',lineHeight:'1.5',color:pal.ink,fontWeight:'400'};
      for(var k in (style||{})) st[k]=style[k];
      return add('text',x,y,w,h,st,Object.assign({text:text},extra||{}));
    }
    function R(x,y,w,h,style,extra){return add('rect',x,y,w,h,style,extra);}

    var gL=add('guide',PAD,0,1,1800,{}, {orient:'v',label:'left guide',deps:[]});
    var gN=add('guide',0,96,1200,1,{}, {orient:'h',label:'nav baseline',deps:[]});

    var logo=T(PAD,34,280,38,brand,{fontSize:'24px',fontWeight:'700',letterSpacing:'-.02em',color:pal.ink},{role:'logo',label:'logo',bind:'brand',deps:[gL.id]});
    var navIds=[];
    s.nav.forEach(function(n,i){
      var b=T(730+i*112,44,106,28,n,{fontSize:'15px',color:pal.muted},{label:'nav link',bind:'nav'+(i+1),deps:[logo.id]});
      navIds.push(b.id);
    });

    var eyebrow=T(PAD,176,600,28,s.eyebrow,{fontSize:'14px',fontWeight:'600',letterSpacing:'3px',color:pal.accent},{label:'eyebrow',bind:'eyebrow',deps:[gL.id]});
    var gT=add('guide',0,452,1200,1,{}, {orient:'h',label:'title baseline',deps:[eyebrow.id]});
    var t1=T(PAD,214,660,78,s.title[0],{fontSize:'64px',fontWeight:'800',lineHeight:'1.04',color:pal.ink},{role:'title',label:'headline',code:'<h1 />',bind:'title1',deps:[eyebrow.id]});
    var t2=T(PAD,294,660,78,s.title[1],{fontSize:'64px',fontWeight:'800',lineHeight:'1.04',color:pal.ink},{role:'title',label:'headline',code:'<h1 />',bind:'title2',deps:[t1.id,gT.id]});
    var sub=T(PAD,390,540,88,s.sub,{fontSize:'19px',lineHeight:'1.65',color:pal.muted},{label:'paragraph',bind:'subtitle',deps:[t2.id]});
    var btn=R(PAD,500,190,56,{background:pal.accent,borderRadius:'8px',boxShadow:'0 8px 20px rgba(0,0,0,.12)'},{label:'button',code:'<Button />',action:options.ctaAction||'wechat',actionValue:options.ctaValue||'',deps:[sub.id]});
    var btnLabel=T(PAD,500,190,56,s.cta,{fontSize:'16px',fontWeight:'700',color:pal.paper,justifyContent:'center'},{label:'button label',bind:'cta',deps:[btn.id]});
    var link2=T(304,516,160,28,'了解更多 →',{fontSize:'15px',color:pal.ink},{label:'text link',deps:[sub.id]});
    var heroImg=add('image',700,176,420,370,{borderRadius:'18px',boxShadow:'0 18px 48px rgba(0,0,0,.18)'},{image:photo(0),imageFallback:grad,label:'hero image',deps:[gL.id]});
    add('rect',700,176,420,370,{background:'linear-gradient(162deg,rgba(10,14,22,0) 36%,rgba(10,14,22,.52) 100%)',borderRadius:'18px'},{label:'image overlay',deps:[heroImg.id],z:2});
    R(636,496,180,72,{background:'rgba(255,255,255,.72)',backdropFilter:'blur(16px)',WebkitBackdropFilter:'blur(16px)',border:'1px solid rgba(255,255,255,.55)',borderRadius:'14px',boxShadow:'0 12px 32px rgba(0,0,0,.16)'},{label:'float card',deps:[heroImg.id],z:3});
    T(658,516,140,24,'✦ 精选',{fontSize:'15px',fontWeight:'700',color:pal.ink},{label:'float label',deps:[heroImg.id],z:4});

    var trust=T(PAD,624,340,26,s.trust,{fontSize:'13px',color:pal.muted,letterSpacing:'1px'},{label:'trust label',bind:'trust',deps:[btnLabel.id]});
    ['NORTH','Atelier','MONO','Fieldwork'].forEach(function(n,i){
      T(PAD+i*250,660,220,32,n,{fontSize:'20px',fontWeight:'700',color:pal.muted,opacity:'.75'},{label:'logo',deps:[trust.id]});
    });

    var sec=T(PAD,764,620,52,'Why people choose us',{fontSize:'36px',fontWeight:'800',letterSpacing:'-.02em',color:pal.ink},{role:'title',label:'section title',deps:[trust.id]});
    var cardX=[PAD,PAD+366,PAD+732], cardW=346;
    var master=R(cardX[0],842,cardW,252,{background:pal.surface,border:'1px solid '+pal.border,borderRadius:'14px',boxShadow:'0 4px 16px rgba(0,0,0,.04)'},{label:'card master',code:'<Card />',deps:[sec.id]});
    function cardContent(idx,x,title,body,depCard){
      var mx=x+24;
      add('image',mx,866,56,56,{borderRadius:'12px'},{image:photo(idx+1,600),imageFallback:grad,label:'card photo',deps:[depCard]});
      T(mx+70,876,180,30,String(idx+1).padStart(2,'0'),{fontSize:'18px',fontWeight:'800',color:pal.accent},{label:'icon number',deps:[depCard]});
      var tt=T(mx,930,cardW-118,32,title,{fontSize:'21px',fontWeight:'700',color:pal.ink},{label:'card title',bind:'feature'+(idx+1)+'t',deps:[depCard]});
      T(mx,972,cardW-48,100,body,{fontSize:'15px',lineHeight:'1.65',color:pal.muted},{label:'card body',bind:'feature'+(idx+1)+'b',deps:[tt.id]});
    }
    cardContent(0,cardX[0],s.features[0][0],s.features[0][1],master.id);
    var c2=add('duplicate',cardX[1],842,cardW,252,{background:pal.surface,border:'1px solid '+pal.border,borderRadius:'14px',boxShadow:'0 4px 16px rgba(0,0,0,.04)'},{master:master.id,label:'card copy',deps:[master.id]});
    cardContent(1,cardX[1],s.features[1][0],s.features[1][1],c2.id);
    var c3=add('duplicate',cardX[2],842,cardW,252,{background:pal.surface,border:'1px solid '+pal.border,borderRadius:'14px',boxShadow:'0 4px 16px rgba(0,0,0,.04)'},{master:master.id,label:'card copy',deps:[c2.id]});
    cardContent(2,cardX[2],s.features[2][0],s.features[2][1],c3.id);

    var gS=add('guide',0,1150,1200,1,{}, {orient:'h',label:'stats baseline',deps:[c3.id]});
    var statIds=[];
    s.stats.forEach(function(st,i){
      var n=T(PAD+i*350,1182,300,64,st[0],{fontSize:'52px',fontWeight:'800',color:pal.accent},{role:'title',label:'stat number',bind:'stat'+(i+1)+'n',deps:[gS.id]});
      statIds.push(n.id);
      T(PAD+i*350,1254,300,30,st[1],{fontSize:'16px',color:pal.muted},{label:'stat label',bind:'stat'+(i+1)+'l',deps:[n.id]});
    });

    var band=add('image',PAD,1360,CW,224,{borderRadius:'18px'},{image:photo(4,1400),imageFallback:grad,label:'cta band photo',deps:[statIds[2]]});
    add('rect',PAD,1360,CW,224,{background:'linear-gradient(90deg,rgba(8,11,17,.95) 0%,rgba(8,11,17,.80) 54%,rgba(8,11,17,.42) 100%)',borderRadius:'18px'},{label:'band overlay',deps:[band.id],z:2});
    var ch=T(PAD+44,1400,620,52,'Ready when you are.',{fontSize:'36px',fontWeight:'800',color:pal.paper},{role:'title',label:'cta title',deps:[band.id],z:3});
    T(PAD+44,1462,600,36,'今天开始，比明天开始更容易。',{fontSize:'17px',color:pal.paper,opacity:'.82'},{label:'cta sub',deps:[ch.id],z:3});
    var b2=R(PAD+780,1444,200,56,{background:pal.accent,borderRadius:'8px'},{label:'button',action:options.ctaAction||'wechat',actionValue:options.ctaValue||'',deps:[band.id],z:4});
    var b2l=T(PAD+780,1444,200,56,s.cta,{fontSize:'16px',fontWeight:'700',color:pal.paper,justifyContent:'center'},{label:'button label',bind:'cta',deps:[b2.id],z:4});

    var hr=add('line',PAD,1646,CW,1,{background:pal.border},{label:'divider',deps:[b2l.id]});
    T(PAD,1682,320,32,brand,{fontSize:'19px',fontWeight:'700',color:pal.ink},{label:'footer brand',bind:'brand',deps:[hr.id]});
    var footNote=T(PAD,1720,620,26,s.foot,{fontSize:'14px',color:pal.muted},{label:'footer note',bind:'footer',deps:[hr.id]});
    ['Twitter','Instagram','Email'].forEach(function(n,i){
      T(820+i*120,1686,110,26,n,{fontSize:'14px',color:pal.muted},{label:'footer link',deps:[hr.id]});
    });

    // 联系方式条（始终生成，由编辑面板控制内容，保证后来填了也能显示）
    var contact=options.contact||'';
    T(PAD,1762,900,24,contact?('联系我：'+contact):'',{fontSize:'14px',color:pal.accent,fontWeight:'600'},{label:'contact line',bind:'contact',deps:[footNote.id]});

    // 通用场景里的 {svc} 用用户那句话里的业务词替换掉，文案立刻"像为他写的"
    var svc=options.svc||extractService(prompt);
    blocks.forEach(function(b){
      if(typeof b.text==='string'&&b.text.indexOf('{svc}')>=0) b.text=b.text.split('{svc}').join(svc);
    });

    var bp={
      meta:{
        title:brand, industry:s.label, sceneKey:(options.sceneKey&&SCENES[options.sceneKey])?options.sceneKey:null,
        palette:pal.name, paletteKey:pal.key, width:W, height:1810, bg:pal.bg,
        contact:contact, ctaAction:options.ctaAction||'wechat', ctaValue:options.ctaValue||''
      },
      blocks:blocks
    };
    if(options.edits) applyEdits(bp,options.edits);
    return bp;
  }

  // 提取当前蓝图里所有可编辑字段（按 bind 聚合，多个同 bind 取第一个）
  function extractFields(bp){
    var out={brand:'',eyebrow:'',title1:'',title2:'',subtitle:'',cta:'',trust:'',footer:'',contact:bp.meta.contact||''};
    for(var i=1;i<=4;i++) out['nav'+i]='';
    for(var j=1;j<=3;j++){out['feature'+j+'t']='';out['feature'+j+'b']='';out['stat'+j+'n']='';out['stat'+j+'l']='';}
    (bp.blocks||[]).forEach(function(b){
      if(b.bind&&out.hasOwnProperty(b.bind)&&out[b.bind]==='') out[b.bind]=b.text||'';
    });
    return out;
  }

  // 把编辑后的字段写回蓝图
  function applyEdits(bp,edits){
    if(!edits)return bp;
    var seen={};
    (bp.blocks||[]).forEach(function(b){
      if(b.bind&&edits.hasOwnProperty(b.bind)){
        // 同 bind 的模块（brand/cta）所有出现都同步；其余同步即可
        b.text=String(edits[b.bind]);
      }
      if(b.action&&edits.hasOwnProperty('_ctaAction')) b.action=edits._ctaAction;
      if(b.action&&edits.hasOwnProperty('_ctaValue')) b.actionValue=edits._ctaValue;
      if(b.label==='contact line'&&edits.hasOwnProperty('contact')) b.text=edits.contact?('联系我：'+edits.contact):'';
    });
    if(edits.hasOwnProperty('contact')) bp.meta.contact=edits.contact;
    if(edits.hasOwnProperty('_ctaAction')) bp.meta.ctaAction=edits._ctaAction;
    if(edits.hasOwnProperty('_ctaValue')) bp.meta.ctaValue=edits._ctaValue;
    if(edits.hasOwnProperty('brand')) bp.meta.title=edits.brand;
    return bp;
  }

  // 换配色：就地替换所有 hex 颜色（保留文案编辑）
  function recolor(bp,paletteKey){
    var pal=PALETTES[paletteKey];if(!pal)return bp;
    var old=null;
    for(var k in PALETTES) if(PALETTES[k].name===bp.meta.palette){old=PALETTES[k];break;}
    if(!old)old=PALETTES.paper;
    function swap(v){
      if(typeof v!=='string')return v;
      return v.replace(/#([0-9a-fA-F]{6})/gi,function(m){
        var hex=m.toLowerCase();
        var map={};[['bg','bg'],['ink','ink'],['accent','accent'],['soft','soft'],['muted','muted'],['surface','surface'],['border','border'],['paper','paper']].forEach(function(p){map[old[p[1]].toLowerCase()]=pal[p[0]];});
        return map[hex]||m;
      });
    }
    bp.meta.bg=pal.bg;bp.meta.palette=pal.name;bp.meta.paletteKey=pal.key;
    bp.blocks.forEach(function(b){
      for(var k in b.style) b.style[k]=swap(b.style[k]);
    });
    return bp;
  }

  function validate(bp){
    if(!bp||!bp.meta||!Array.isArray(bp.blocks)) return '蓝图缺少 meta 或 blocks';
    var ids={};
    for(var i=0;i<bp.blocks.length;i++){
      var b=bp.blocks[i];
      if(!b.id||ids[b.id]) return '第 '+i+' 个 block 的 id 缺失或重复';
      ids[b.id]=true;
      if(!/^(rect|text|line|image|guide|duplicate)$/.test(b.type)) return 'block '+b.id+' 的 type 不合法: '+b.type;
      for(var k in {x:1,y:1,w:1,h:1}) if(typeof b[k]!=='number') return 'block '+b.id+' 的 '+k+' 必须是数字';
    }
    for(var j=0;j<bp.blocks.length;j++){
      var d=bp.blocks[j].deps||[];
      for(var m=0;m<d.length;m++) if(!ids[d[m]]) return 'block '+bp.blocks[j].id+' 依赖了不存在的 id: '+d[m];
      if(bp.blocks[j].master&&!ids[bp.blocks[j].master]) return 'block '+bp.blocks[j].id+' 的 master 不存在';
    }
    return null;
  }

  /* ==================================================================
     LLM 接入层
     1) buildPrompt —— 生成一段"贴到任何 AI 都能用"的提示词（剪贴板桥）
     2) parseLLM    —— 从 AI 的回答里把 JSON 抠出来（含围栏、解释文字、尾逗号）
     3) repair      —— 容错修复：补 meta、改 id、补坐标、改类型、修依赖、限高
     目标是"AI 怎么乱来都能建出来"，而不是要求模型完美。
     ================================================================== */

  var TYPE_MAP={
    rect:'rect',box:'rect',div:'rect',container:'rect',section:'rect',frame:'rect',block:'rect',
    button:'rect',btn:'rect',card:'rect',panel:'rect',badge:'rect',
    text:'text',heading:'text',title:'text',paragraph:'text',p:'text',label:'text',h1:'text',h2:'text',h3:'text',span:'text',copy:'text',
    image:'image',img:'image',picture:'image',photo:'image',media:'image',video:'image',
    line:'line',divider:'line',hr:'line',rule:'line',separator:'line',
    guide:'guide',ruler:'guide',grid:'guide',
    duplicate:'duplicate',copycard:'duplicate',clone:'duplicate',repeat:'duplicate'
  };
  var STYLE_MAP={
    font_size:'fontSize',fontsize:'fontSize','font-size':'fontSize',
    font_weight:'fontWeight',fontweight:'fontWeight','font-weight':'fontWeight','font-weight:':'fontWeight',
    'line-height':'lineHeight',lineheight:'lineHeight',
    'letter-spacing':'letterSpacing',letter_spacing:'letterSpacing',
    'border-radius':'borderRadius',border_radius:'borderRadius',
    'box-shadow':'boxShadow',box_shadow:'boxShadow',
    'text-align':'textAlign',text_align:'textAlign',
    'background-color':'backgroundColor',background_color:'backgroundColor',
    'font-family':'fontFamily',font_family:'fontFamily'
  };

  function num(v,d){
    if(typeof v==='number') return isFinite(v)?v:d;
    if(typeof v==='string'){ var n=parseFloat(v); return isFinite(n)?n:d; }
    return d;
  }
  function clampNum(v,dflt,min,max){ v=num(v,dflt); return Math.max(min,Math.min(max,v)); }
  function normAction(a){
    var s=String(a||'').toLowerCase().trim();
    if(!s||s==='none') return '';
    if(/tel|phone|call|电话|拨号/.test(s)) return 'tel';
    if(/mail|email|邮件|邮箱/.test(s)) return 'mailto';
    if(/wechat|weixin|wx|微信/.test(s)) return 'wechat';
    if(/link|url|open|链接|网址/.test(s)) return 'link';
    return '';
  }
  function fixStyle(st){
    var raw={};
    if(!st) return raw;
    if(typeof st==='string'){
      st.split(';').forEach(function(pair){
        var i=pair.indexOf(':');
        if(i>0) raw[pair.slice(0,i).trim()]=pair.slice(i+1).trim();
      });
    }else if(typeof st==='object'){
      for(var k in st) if(st.hasOwnProperty(k)) raw[k]=st[k];
    }
    var out={};
    for(var key in raw){
      if(!raw.hasOwnProperty(key)) continue;
      var name=STYLE_MAP[key.toLowerCase()]||key;
      var val=raw[key];
      if(val==null) continue;
      if(typeof val==='number') val=/fontSize|lineHeight|letterSpacing|borderRadius|padding|margin|width|height|top|left|right|bottom|gap/i.test(name)?val+'px':String(val);
      out[name]=String(val);
    }
    return out;
  }

  function parseLLM(text){
    var notes=[];
    var s=String(text==null?'':text).trim();
    if(!s) return {error:'内容为空'};
    var fence=s.match(/```(?:json|javascript|js|JSON)?\s*([\s\S]*?)```/);
    if(fence){ s=fence[1].trim(); notes.push('去掉了代码围栏'); }
    var a=s.indexOf('{'), b=s.lastIndexOf('}');
    if(a>=0&&b>a&&(a>0||b<s.length-1)){ s=s.slice(a,b+1); notes.push('去掉了 JSON 前后的说明文字'); }
    try{ return {bp:JSON.parse(s),notes:notes}; }catch(e1){}
    var fixed=s.replace(/,\s*([}\]])/g,'$1').replace(/[\u201c\u201d]/g,'"').replace(/[\uff0c]\s*([}\]])/g,'$1');
    try{ return {bp:JSON.parse(fixed),notes:notes.concat(['修掉了多余的尾逗号 / 中文引号'])}; }catch(e2){
      return {error:'JSON 不合法：'+e2.message};
    }
  }

  /* 给蓝图补齐真实照片。
     模型只需要说"这里放照片"（image:"photo"），不必自己编图片地址 —— 编出来大概率是 404。
     本地按场景从内置图库挑，同一份标题稳定出同一张。 */
  function enrichImages(bp, gradKey){
    var gk=(gradKey&&PHOTOS[gradKey])?gradKey:PHOTO_FALLBACK[hashSeed((bp.meta&&bp.meta.title)||'site')%PHOTO_FALLBACK.length];
    var seed=hashSeed(((bp.meta&&bp.meta.title)||'')+'|'+gk);
    var n=0;
    (bp.blocks||[]).forEach(function(b){
      if(b.type!=='image') return;
      var v=String(b.image==null?'':b.image).trim();
      if(/^asset:/i.test(v)) return;                      // 用户上传的图，原样保留
      if(/url\(\s*(https?:|data:|\/img\/)/i.test(v)) return;   // 已经是真图/已走代理，别覆盖
      if(v && v!=='photo' && /gradient|^#|^rgb/i.test(v)) b.imageFallback=v;
      var big=(b.w>=560||b.h>=260);
      b.image=photoUrl(pickPhoto(gk,seed,n++), big?1400:600);
      // 兜底一律用场景深色渐变：编译器给的浅灰兜底配白字会看不清，
      // 而首屏大图恰恰最容易加载失败（外链 + 整屏）
      if(big||!b.imageFallback) b.imageFallback=GRADIENTS[gk]||GRADIENTS.studio;
    });
    return bp;
  }

  function repair(input, gradKey){
    var notes=[],src=input;
    if(typeof src==='string'){
      var pr=parseLLM(src);
      if(pr.error) return {error:pr.error};
      src=pr.bp;notes=notes.concat(pr.notes||[]);
    }
    if(!src||typeof src!=='object'||Array.isArray(src)) return {error:'蓝图不是一个对象'};

    // 有些模型会包一层 {blueprint:{...}} / {site:{...}}
    if(!Array.isArray(src.blocks)){
      var wrapKeys=['blueprint','site','data','page','result','layout','website'];
      for(var wi=0;wi<wrapKeys.length;wi++){
        var w=src[wrapKeys[wi]];
        if(w&&Array.isArray(w.blocks)){ src=w;notes.push('从 '+wrapKeys[wi]+' 字段里取出蓝图');break; }
      }
    }
    if(!Array.isArray(src.blocks)) return {error:'缺少 blocks 数组'};
    if(!src.meta||typeof src.meta!=='object'){ src.meta={};notes.push('补了 meta'); }

    var raw0=src.blocks.slice(0,280);
    var W=clampNum(src.meta.width,1200,360,2400);
    if(num(src.meta.width,1200)!==W) notes.push('画布宽度修正为 '+W);

    // 大量块 y 坐标缺失/为 0 → 自动纵向排布，别让它们全叠在左上角
    var ys=[];
    raw0.forEach(function(b){ if(b&&typeof b==='object'){ var v=num(b.y,NaN); if(!isNaN(v)) ys.push(v); } });
    var zero=ys.filter(function(v){return v===0;}).length;
    var autoStack=ys.length>3&&zero/ys.length>0.6;
    if(autoStack) notes.push('y 坐标大量缺失，改按顺序纵向排列');

    var used={},out=[],stackY=60,unknownType=0,idFix=0,depsFix=0;

    raw0.forEach(function(raw,idx){
      if(!raw||typeof raw!=='object') return;
      var typeRaw=String(raw.type||'').toLowerCase().trim();
      var type=TYPE_MAP[typeRaw];
      if(!type){
        type=raw.text!=null?'text':(raw.image?'image':'rect');
        if(typeRaw) unknownType++;
      }

      var id=String(raw.id==null?('b'+(idx+1)):raw.id).replace(/[^\w\-]/g,'');
      if(!id) id='b'+(idx+1);
      if(used[id]){ var n=2; while(used[id+'_'+n]) n++; id=id+'_'+n; idFix++; }
      used[id]=1;

      var style=fixStyle(raw.style||raw.css);
      var w=num(raw.w,num(raw.width,0));
      var h=num(raw.h,num(raw.height,0));
      if(!(w>0)) w=(type==='text'?420:200);
      if(!(h>0)) h=(type==='text'?Math.max(26,parseFloat(style.fontSize||'16')*1.45):120);
      if(type==='line'){ if(!(h>0)) h=1; if(!(w>0)) w=W-160; }

      var x=num(raw.x,autoStack?80:90);
      var y=autoStack?stackY:num(raw.y,60);
      if(w>W-40) w=W-80;
      x=Math.max(0,Math.min(x,W-w-8));
      y=Math.max(0,y);
      if(autoStack) stackY=y+h+28;

      var b={id:id,type:type,x:x,y:y,w:w,h:h,z:num(raw.z,1),style:style};
      if(typeof raw.text==='string') b.text=raw.text;
      else if(typeof raw.content==='string') b.text=raw.content;
      else if(typeof raw.value==='string'&&type==='text') b.text=raw.value;
      if(type==='text'&&b.text==null) b.text='';
      if(type==='text'&&!style.fontSize) b.style.fontSize='18px';
      if(type==='text'&&!style.color) b.style.color='#222222';
      if(type==='image') b.image=String(raw.image||raw.src||style.background||'linear-gradient(135deg,#c9d4e5,#7f8ea8)');
      if(type==='guide') b.orient=raw.orient==='v'?'v':'h';
      if(raw.label!=null) b.label=String(raw.label);
      if(raw.role!=null) b.role=String(raw.role);
      if(raw.code!=null) b.code=String(raw.code);
      if(raw.bind!=null) b.bind=String(raw.bind);
      var act=normAction(raw.action);
      if(act){ b.action=act; b.actionValue=String(raw.actionValue||raw.action_value||raw.value||''); }
      if(type==='duplicate'&&raw.master!=null) b.master=String(raw.master);
      var deps=Array.isArray(raw.deps)?raw.deps:[];
      var kept=[];
      deps.forEach(function(d){
        d=String(d);
        if(d&&d!==id&&used[d]&&kept.indexOf(d)<0) kept.push(d); else if(d&&!used[d]) depsFix++;
      });
      if(kept.length) b.deps=kept;
      out.push(b);
    });

    if(!out.length) return {error:'blocks 里没有一个可用的块'};
    if(unknownType) notes.push(unknownType+' 个未知类型已按最接近的块处理');
    if(idFix) notes.push(idFix+' 个重复 id 已自动改名');
    if(depsFix) notes.push(depsFix+' 个无效依赖已忽略');

    // master 指向不存在的块 → 退化成普通矩形，别让引擎卡住
    out.forEach(function(b){
      if(b.master&&!used[b.master]){ delete b.master; b.type='rect'; }
      if(b.type==='duplicate'&&!b.master) b.type='rect';
    });

    var maxY=0;
    out.forEach(function(b){ if(b.type!=='guide') maxY=Math.max(maxY,b.y+b.h); });
    var height=Math.min(4200,Math.max(num(src.meta.height,0),maxY+70,900));
    var cta=normAction(src.meta.ctaAction)||'wechat';

    var meta={
      title:String(src.meta.title||src.meta.brand||src.meta.name||'未命名站点'),
      industry:String(src.meta.industry||''),
      sceneKey:null,
      palette:String(src.meta.palette||''),
      paletteKey:src.meta.paletteKey||null,
      width:W,height:height,
      bg:String(src.meta.bg||'#ffffff'),
      contact:String(src.meta.contact||''),
      ctaAction:cta,ctaValue:String(src.meta.ctaValue||'')
    };
    var bpOut={meta:meta,blocks:out};
    // 保留用户上传的图片素材（input 框里拖进来的图），别在校验修复时丢掉
    if(src.assets&&typeof src.assets==='object'&&!Array.isArray(src.assets)) bpOut.assets=src.assets;
    return {blueprint:enrichImages(bpOut, gradKey),notes:notes};
  }

  function buildPrompt(userPrompt,opts){
    opts=opts||{};
    var ask=String(userPrompt||'').trim()||'一个现代感的产品落地页';
    return [
      '你是网页布局工程师。请为一个"多光标施工动画"生成布局蓝图：一群光标会照着它把网页一块块画出来。',
      '只输出一个 JSON 对象，不要解释、不要 markdown 代码围栏。',
      '',
      'JSON 结构：',
      '{"meta":{"title":"品牌名","width":1200,"height":1800,"bg":"#ffffff","contact":"微信 xxx · 电话 138xxxx","ctaAction":"wechat","ctaValue":"微信号"},',
      '"blocks":[',
      ' {"id":"b1","type":"text","x":80,"y":40,"w":300,"h":38,"z":1,"style":{"fontSize":"24px","fontWeight":"700","color":"#111111"},"text":"品牌名","label":"logo"},',
      ' {"id":"b2","type":"text","x":730,"y":44,"w":106,"h":28,"style":{"fontSize":"15px","color":"#777777"},"text":"产品","label":"nav link","deps":["b1"]},',
      ' {"id":"b3","type":"rect","x":80,"y":500,"w":190,"h":56,"z":1,"style":{"background":"#1f6feb","borderRadius":"8px"},"label":"button","action":"wechat","actionValue":"微信号","deps":["b1"]}',
      ']}',
      '',
      '规则：',
      '1) 只有这一个 JSON，第一行就是 {，最后一行就是 }。',
      '2) 画布宽固定 1200；height = 内容底部 + 60，不超过 2400。',
      '3) 全部绝对定位 x/y/w/h；从上往下 y 递增，同一行的块 y 相同，块之间不要重叠。',
      '4) 文字必须是真实可用的中文内容，不要 lorem、不要"标题一"这类占位词。',
      '5) 每块都要有唯一 id；deps 只能引用前面已经出现过的 id。',
      '6) 推荐结构：导航(logo + 4 个 label="nav link") → 2 行大标题(fontSize 60px 左右) → 副标题 → 主按钮 → 主图(type="image"，image 写 "photo"，程序会自动配真实照片) → 3 张卡片(第 1 张 label="card master"，后 2 张 type="duplicate"，master 指向第 1 张 id；每张卡片里放一个 56×56 的 type="image" 小图) → 3 个数字 → 深色 CTA 条(可用 type="image" 做底图 + 一层深色 rect 遮罩，遮罩与文字 z 要高过底图) + 按钮 → 页脚(品牌 + 3 个 label="footer link") → 一行 label="contact line" 的联系方式。',
      '7) 需要点击的块加 action(wechat|tel|mailto|link) 和 actionValue；纯文字链接 label 写 "text link"。',
      '8) 配色自洽：浅底深字或深底浅字，只用一个主色；正文用 #666666 一类灰。',
      '9) 块数控制在 40–90 个之间，够撑满一屏长页面即可。',
      '10) 照片：需要图片的位置一律用 type="image"，image 写 "photo"。不要自己编图片网址（会 404），也不要用色块冒充照片。imageFallback 可给一个同色系渐变做兜底。',
      '',
      '用户需求：'+ask,
      opts.brand?('品牌/店名：'+opts.brand):'',
      opts.contact?('联系方式（写进 meta.contact）：'+opts.contact):'',
      opts.ctaAction?('主按钮行为：'+opts.ctaAction+(opts.ctaValue?(' = '+opts.ctaValue):'')):''
    ].filter(Boolean).join('\n');
  }

  /* 给"自由版式"（HTML 编译）路径用：按一句话猜该配哪组照片 */
  function detectGrad(prompt){
    var s=detect(prompt);
    return (s&&s.grad&&PHOTOS[s.grad])?s.grad:null;
  }

  return {build:build,validate:validate,extractFields:extractFields,applyEdits:applyEdits,recolor:recolor,
          repair:repair,parseLLM:parseLLM,buildPrompt:buildPrompt,extractService:extractService,
          enrichImages:enrichImages,detectGrad:detectGrad,photoUrl:photoUrl,pickPhoto:pickPhoto,
          photos:PHOTOS,
          PALETTES:PALETTES,SCENES:SCENES};
})();
