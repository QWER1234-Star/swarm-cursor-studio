# 回环测试

用本机已安装的 Edge / Chrome 跑端到端断言，不需要下载浏览器。对应 SwarmSite 2.3.0，七套共 **263 项**（67 + 10 + 28 + 29 + 45 + 33 + 51），约 7 分钟。

```bash
cd tests
npm install          # 只装 puppeteer-core
npm test             # 七套全跑
# 或在项目根目录：npm test（同一条命令）
```

测试分三层：`test.js` / `test-compiler.js` / `test-editor.js` 只开浏览器验证应用本身；`test-llm.js` 额外起一个假的 OpenAI 兼容上游；`test-gateway.js` / `test-files.js` / `test-images.js` 会真起 `server.js`，分别配假 LLM、真上传文档、假图库上游。所有临时配置与产物都在结束时清理，不会碰项目里真正的 `.llm.json`。

- `test.js` — 主流程：离线生成 → 施工 → 边建边点 → 进入网站交互 → CTA → 主题 → LLM 容错 → 导出单文件（含禁用 JS / `?nointro`）→ 减少动态效果 → 控制台零运行时错误
- `test-llm.js` — 在本地起一个假的 OpenAI 兼容服务，验证四种接入模式、测试连接、围栏+前言解析、HTTP 500 提示（file:// 直连路径）
- `test-gateway.js` — 真的把 `server.js` 拉起来：健康检查、静态托管、Origin 守卫、Key 存到 `.llm.json` 且浏览器不留、刷新后免重填、流式生成、一句话改页面与撤销、缺 Key 与上游 500 的报错文案
- `test-files.js` — 文件输入框与文档解析：真上传 txt / png，真调 `/api/llm/extract` 解 docx / xlsx / pptx / pdf，验证拖拽、粘贴、压缩、移除、Enter 与零错误
- `test-compiler.js` — HTML→蓝图 编译器：白名单清洗、自创 class 容错、未闭合标签、action 不重复、分段依赖、导出一致性
- `test-images.js` — 图片代理：回源落盘、二次命中、并发去重、上游宕机时缓存仍可用、非法 id、内嵌导出与 CDN 还原、`file://` 下不开代理
- `test-editor.js` — 点选编辑：选中与检查器、改字号/颜色/文案/坐标、方向键微调、Ctrl+Z、双击就地输入、复制删除与撤销、退出后交互恢复、重播与导出都带着改动

只跑其中一套：

```bash
npm run test:main
npm run test:llm
npm run test:gateway
npm run test:files
npm run test:compiler
npm run test:images
npm run test:editor
```

如果 Edge 不在默认路径：

```bash
EDGE_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npm test
```

## 测试素材

`test-files.js` 里的 docx / xlsx / pptx / pdf 都是**运行时现场生成的**（内置一个几百行的 minimal ZIP 写入器 + 一段手写 PDF），不依赖系统 Office，也不需要仓库里放二进制文件。图片素材用 `fixtures-photo.png`（一张 1440×940 的截图，用来触发压缩分支）。

`test-images.js` 在本地起一个**假图库上游**（返回一张 160 字节的 1×1 JPEG），所以不联网也能验证代理与缓存；缓存目录用 `tests/.img-cache-test/`，跑完自动删。

## 产物与残留

导出的 html 会落在 `tests/dl/`，每次运行前自动清空。`test-gateway.js` 用独立配置 `tests/.llm-test.json`，`test-files.js` 用 `.files-test.json`，都在结束后删除，不会碰你项目里真正的 `.llm.json`。临时文件目录 `.tmp-files/`、图片缓存 `.img-cache-test/` 同样会清掉。

## 关于「零控制台错误」

只统计**脚本运行时错误**（`pageerror` 与非网络类 `console.error`）。外链图片加载失败（`net::ERR_*`）属于网络环境问题，不计入——图片层本身有渐变兜底，稳定性由 `test-images.js` 单独覆盖。

## 新增测试时

- 在主流程里加断言用 `test.js`；涉及 LLM 输出契约放 `test-llm.js`；涉及 `server.js` 的路由放 `test-gateway.js` / `test-files.js` / `test-images.js`；编辑器交互放 `test-editor.js`。
- 起服务用随机端口，配置写 `tests/.llm-test.json` 一类的专用文件，**不要复用真实 `.llm.json`**。
- 所有下载落 `tests/dl/`、临时缓存落 `tests/.img-cache-test/`，并在用例结束时清理；这些路径都已在 `.gitignore` 中。
- 新增一套后，记得同时更新根目录 `package.json` 的 `test` 脚本和本文件的断言计数。
