# B 站课程实时笔记应用（dsh-video-coursemap + dsh-memory-evolve）

一个跑在 DeepSeek Harness 桌面端里的「看课即记」应用：浏览器前台播放 B 站课程 →
自动识别视频 → 按学科归类 → 抓简介/字幕/弹幕/热评做知识总结 → 生成 Word 知识地图与学习手册 →
投递到会话对话框。

## 两种使用方式

### A. 独立应用（推荐，不用开 DSH）

双击桌面 **课程助手** 快捷方式 → 浏览器打开 `http://127.0.0.1:3456`。
可调轮询间隔、一键启停、实时看轮询与总结。详见 [app/README.md](app/README.md)。

### B. DSH 内插件

装好后在 DSH 会话里用 `course_map_status` / `course_map_scan` / `course_notes_inbox` / `course_notes_deliver`。
插件默认 `enabled: false`（让位给独立应用）；需要时在 profile patch 里改回 `true` 并重载。

两者共用同一份核心逻辑（`plugins/dsh-video-coursemap/lib/core/*`）和同一个输出目录，
通过 `知识地图/.state/lock.json` 进程锁互斥，避免同时处理同一个视频。

## 组成

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `dsh-video-coursemap` v2.0.0（引擎，官方发行版 + 本地补丁） | `plugins/dsh-video-coursemap` | 轮询前台窗口标题 → 判课/分类 → 抓 B 站内容 → 生成 docx |
| `dsh-course-notes`（本方扩展） | `plugins/dsh-course-notes` | 文档收件箱 + 投递到会话对话框（`present` 文件卡片） |
| `dsh-memory-evolve`（已装） | `~/.dsh/plugins/dsh-memory-evolve` | 长期记忆：学科索引、进度日志、待办 |

输出目录（可在 profile patch 里改）：`D:/course-notes/知识地图`

```
知识地图/
├── 课程总览.docx            # 全局知识地图
├── <学科>/学习手册.docx      # 该学科所有视频的知识总结（Mermaid 思维导图 → Word 原生分级大纲）
└── .state/
    ├── state.json           # 学科/视频/去重表
    ├── poll.log             # 观测与分类日志（排查「为什么没生成」先看它）
    ├── manuals/*.md         # docx 的 Markdown 源
    └── delivered.json       # 投递记录（dsh-course-notes 维护）
```

## 检测通道（关键设计）

**不用 CDP、不用浏览器扩展**，用 `powershell.exe` + `user32!GetForegroundWindow/GetWindowText`
取**前台窗口标题**，配进程白名单（msedge 等）与平台后缀剥离；标题连续 2 次稳定（默认 15s 一轮）
才认定为新视频，处理过的标题进 `seen` 表静默。

代价：拿不到 URL，只能靠标题反查 B 站；后台播放/最小化不触发。

## 本地方便起见改了什么

1. 引擎 `searchBili()`：原实现只比对搜索**第 1 条**（常是合集/推广），相似度阈值 0.5 →
   实测 `bvid=none`，弹幕/评论全抓空。改为前 12 条取相似度最高、阈值放宽到 0.35。
2. 新增 `dsh-course-notes` 插件：`course_notes_inbox` / `course_notes_deliver`。
3. profile 配置：`outputDir` 指到工作区。

## 用法

- 看课：Edge 前台播放 B 站课程视频即可，约 30 秒后自动生成/更新 Word。
- 手动触发：`course_map_scan`（可传 `title`）。
- 看产出：`course_notes_inbox`；投递到对话框：`course_notes_deliver` + `present`。
- 改插件代码后**必须重启 DSH**（ESM 模块缓存）；只改配置可用
  `dsh plugin --profile desktop add <路径>` 触发重载。

## 已知限制

- B 站匿名评论接口封顶 3 条；字幕多数课程没有（尽力抓、失败静默）。
- 课程视频弹幕常很少甚至为 0（不是接口问题，热门视频实测可抓 7200 条）。
- 标题反查可能匹配到「同名不同 UP」的视频，日志里带 `matchScore` 可核对。
