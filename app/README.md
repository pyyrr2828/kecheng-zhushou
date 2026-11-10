# app/ · 独立应用

不依赖 DeepSeek Harness 的本地控制台。整体说明见仓库根目录 [README](../README.md)。

## 组成

```
app/
├── server.mjs             本地 HTTP 服务：静态资源 + REST + SSE + 轮询调度
├── summarizer/openai.mjs  OpenAI 兼容模型适配（流式）
├── notes-ops.mjs          笔记删除/重建（按章节、按学科）
├── ui/                    单页前端（原生 JS，无构建）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── tools/delete-subject.mjs  命令行删除工具
├── start.vbs / start.cmd     启动器（无窗口起服务 + 开浏览器）
├── make-icon.py              生成 icon.ico（需要 Pillow）
└── config.json               运行时配置（首次运行用 config.example.json 复制）
```

## 运行

```powershell
copy config.example.json app\config.json
node app\server.mjs
```

默认 <http://127.0.0.1:3456>；端口被占用会自动顺延，实际端口写在 `runtime.json`。

## 前端约定

- 无构建、无 CDN：直接改 `ui/*`，刷新页面即生效。
- 事件流走 `GET /api/events`（SSE），连接时补发最近 100 条。
- Markdown 渲染器是自带的极简实现（先转义、再按白名单出标签），不引第三方库。

## 后端约定

- 所有写操作都经过 `plugins/dsh-video-coursemap/lib/core/store.mjs`，它做「读—改—写」并持有进程锁。
- 配置改动即时生效：重建定时器与模型客户端，无需重启进程。
- 服务只绑定 127.0.0.1；`/api/open` 只允许打开输出目录内的路径。
