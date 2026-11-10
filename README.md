# 课程助手 · B 站课程实时知识地图

> 看课时自动把课程变成结构化笔记：识别前台视频 → 判断学科 → 抓简介/字幕/弹幕/热评 → 生成知识地图 → 导出 Word。

![界面](docs/ui.png)

一个 Windows 本地小应用 + 一组 DeepSeek Harness（DSH）插件。核心玩法只有一句话：**把 B 站课程视频放在前台 20 秒，笔记自己就长出来了。**

---

## 它解决什么问题

看网课最常见的浪费是「看完了、没留下」。手动记笔记嫌慢，事后补又全忘了。这个项目把这段流程自动化：

1. 检测到你正在看的 B 站课程视频（**不需要浏览器扩展，也不需要 CDP**）
2. 让模型判断这是不是「有知识含量」的内容，属于哪个学科
3. 按标题反查 B 站，抓取**视频简介、字幕（如有）、弹幕（≤150 条）、热评（≤20 条）**
4. 用这些真实内容 + 弹幕/评论里的讨论焦点，生成 Markdown 知识地图（含 Mermaid 思维导图）
5. 转成 Word：《课程总览.docx》+ 每个学科一本《学习手册.docx》

同一视频再看一遍不会重复生成；换个学科的视频会自动新建一本手册。

## 功能

| | |
| --- | --- |
| **实时检测** | 轮询 Windows 前台窗口标题，进程白名单（Edge/Chrome/360/QQ/搜狗/B 站客户端…），标题清洗后连续 N 次稳定才确认 |
| **学科分类** | 模型输出 `isCourse / subject / keywords`；旧学科追加，新学科自动建手册 |
| **内容总结** | 结合简介、字幕、弹幕、热评；弹幕/评论里的争议点单独成节 |
| **Word 导出** | Mermaid 思维导图渲染成 Word 原生分级大纲（不是代码块） |
| **控制台** | 轮询间隔可调（2s–300s，立即生效）、一键启停、实时轮询事件流、流式生成预览、笔记库、按视频/学科删除 |
| **两副面孔** | 独立桌面应用（不用开 DSH）；也可作为 DSH 插件在会话里用工具驱动 |
| **降级可用** | 没有模型 Key 时仍可检测、记录、浏览已有笔记 |

## 工作原理

```
前台窗口 (user32!GetForegroundWindow)
        │  PowerShell 读标题 + 进程名，写临时文件再读（规避编码问题）
        ▼
cleanTitle()  ── 剥掉「_哔哩哔哩_bilibili - 用户配置 1 - Microsoft Edge」这类尾巴
        │
        ▼
seen 去重表 ──命中──► 静默
        │ 未命中
        ▼
连续 2 次标题稳定 ──► LLM 分类（isCourse / subject / keywords）
        │                     │ 非课程 → 记 seen，静默
        ▼                     ▼
B 站搜索反查（前 12 条取相似度最高）→ view / 弹幕 XML / 热评 API
        │
        ▼
LLM 生成 Markdown+Mermaid ──► 追加到 <学科>/学习手册.md
        │
        ▼
python-docx 转 Word ──► 学习手册.docx + 课程总览.docx
```

同一份核心代码（`plugins/dsh-video-coursemap/lib/core/*`）被两个入口复用：

```
app/server.mjs（HTTP + SSE + 调度）──────────────────┐
                                                    ├──► core/pipeline.mjs
plugins/dsh-video-coursemap/lib/index.js（DSH 适配层）┘
        ▲
   模型适配器：独立应用用 OpenAI 兼容 HTTP，DSH 里用 ctx.llm
```

两个入口共用同一个输出目录，靠 `.state/lock.json` **进程锁互斥**，不会重复处理同一个视频。

## 快速开始

### 前置

- **Windows 10/11**（前台窗口检测依赖 user32）
- **Node.js ≥ 18**
- **Python 3 + python-docx**（只用于出 Word；没有也能跑，只是不生成 docx）

```powershell
pip install python-docx
```

### A. 独立应用（推荐，不需要 DSH）

```powershell
git clone <this repo> 课程助手
cd 课程助手
copy config.example.json app\config.json
node app\server.mjs
```

浏览器打开 <http://127.0.0.1:3456>，右上「设置」填入模型 `baseUrl / model / API Key`（任意 OpenAI 兼容端点；本地 Ollama 填 `http://127.0.0.1:11434/v1` 也可）。

**做桌面快捷方式**：给 `app\start.vbs` 建一个快捷方式放到桌面即可（目标 `wscript.exe "…\app\start.vbs"`，图标用 `app\icon.ico`）。脚本会先探测服务是否已在跑，没跑就无窗口启动，然后打开浏览器。

### B. 作为 DSH 插件

```powershell
dsh plugin --profile <profile> add <绝对路径>/plugins/dsh-video-coursemap
dsh plugin --profile <profile> add <绝对路径>/plugins/dsh-course-notes
```

然后在 profile 的 `cordis.patch.yml` 里配置：

```yaml
- id: dsh-video-coursemap
  name: "dsh-video-coursemap"
  config:
    outputDir: 'D:/notes/知识地图'
    pollIntervalMs: 10000
    stablePolls: 2
    fetchContent: true
    enabled: true
```

插件提供的工具：

| 工具 | 作用 |
| --- | --- |
| `course_map_status` | 查看启用状态、输出目录、学科与视频数、最近观测 |
| `course_map_scan` | 立即扫描一次（可传 `title` 手动指定） |
| `course_notes_inbox` | 列出已生成的 docx 及投递状态 |
| `course_notes_deliver` | 取出待投递文档并标记已投递（配合会话里 `present` 显示文件卡片） |

> 两个模式同时开也不会打架：先拿到锁的一方工作，另一方跳过并记日志。

## 配置

`app/config.json`（页面上的改动会即时写回）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | 3456 | 被占用会自动顺延 3457/3458 |
| `pollIntervalMs` | 10000 | 轮询间隔，2000–300000 |
| `stablePolls` | 2 | 连续几次稳定才处理，1–10 |
| `titleMinLen` | 4 | 标题最小长度 |
| `fetchContent` | true | 关掉就只按标题总结，不抓弹幕/评论 |
| `maxTokens` | 4096 | 单次生成上限 |
| `outputDir` | `%USERPROFILE%\课程知识地图` | 笔记输出目录（两个入口要一致） |
| `llm.baseUrl` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `llm.model` | `deepseek-chat` | 模型名 |
| `llm.apiKey` | 空 | 空 = 只检测不生成 |

> `config.json` 已在 `.gitignore` 里，不会被提交。

## 产出结构

```
<outputDir>/
├── 课程总览.docx              # 学科总览 mindmap + 学科列表
├── <学科>/学习手册.docx        # 该学科每个视频一节
└── .state/
    ├── state.json            # subjects（学科→视频）与 seen（去重表，上限 500）
    ├── manuals/<学科>.md     # Word 的 Markdown 源
    ├── lock.json             # 进程锁（谁在轮询）
    └── poll.log              # 观测/分类/抓取日志，排查先看它
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 运行状态、学科、文档、锁、模型配置（不回传 Key 明文） |
| POST | `/api/config` | 部分更新配置，非法值返回 400 + errors |
| POST | `/api/scan` | `{title?}` 立即扫描 |
| GET | `/api/events` | SSE：tick / decision / classify / fetch / generate-start / token / generate-done / error |
| GET | `/api/notes`、`/api/notes/:subject` | 文档清单 / 学科 Markdown + 视频章节 |
| POST | `/api/notes/:subject/rebuild` | 按 md 重建 Word |
| POST | `/api/notes/:subject/delete-video` | `{title}` 删除单章 |
| POST/DELETE | `/api/notes/:subject(/delete)` | 删除整个学科 |
| POST | `/api/rebuild` | 全量重建 |
| GET | `/api/log?tail=200` | poll.log 尾部 |
| POST | `/api/open` | 打开输出目录内文件（越界路径被拒绝） |
| POST | `/api/llm/test` | 试调模型 |
| POST | `/api/shutdown` | 退出服务 |

![删除与重建](docs/ui-delete.png)

## 已知限制

- **只有标题，没有 URL**：检测通道是窗口标题，内容靠「按标题反查 B 站」，同名不同 UP 的视频可能匹配错（日志里带 `matchScore` 可核对）。
- **必须真在前台**：后台播放、最小化、窗口被切走都不触发（连续 2 次稳定的代价）。
- B 站匿名评论接口最多 3 条；多数课程没有机器字幕（抓不到静默降级）。
- 课程类视频弹幕常常很少甚至为 0（接口本身没问题，热门视频实测单视频 7200 条）。
- 仅支持 Windows。

## 开发

```powershell
node --check app\server.mjs
node tests\run.mjs        # 核心逻辑测试（假模型 + 临时目录，不碰真实笔记）
```

关键约定：

- 改 `lib/core/*` 后独立应用重启即可；**DSH 插件需要重启 DSH**（ESM 模块缓存）。
- 只改 `config.json` 的话，页面保存即热生效。
- `scripts/md2docx.py` 是 Markdown→Word 的唯一出口，Mermaid mindmap 会被渲染成分级大纲。

## Roadmap

- [ ] 用浏览器扩展 / CDP 拿 URL 与 BV 号，替代标题反查
- [ ] 同一视频增量更新（只补新弹幕与热评）
- [ ] 周报：把一周的学习手册汇总成复习提纲
- [ ] 打包成免 Node 的独立 exe

## 许可

[MIT](LICENSE)
