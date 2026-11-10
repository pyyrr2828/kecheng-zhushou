# 使用手册：B 站课程实时笔记

## 0. 前提

- **DSH 桌面端必须开着**（插件跑在 DSH 进程里，关掉就停止观察）。
- 输出目录：`D:\course-notes\知识地图\`

## 1. 日常使用：三步

1. 用浏览器打开 B 站课程视频（Edge / Chrome / 360 / QQ / 搜狗 等都在白名单）。
2. **让视频窗口停在前台连续 20 秒左右**（10 秒一轮、连续 2 轮标题稳定才动手）。
3. 什么都不用做。到点后它在后台自己完成：

   ```
   读窗口标题 → 剥掉「_哔哩哔哩_bilibili - 用户配置 1 - Microsoft Edge」这类尾巴
   → LLM 判断是不是课程 + 归类学科（中文 ≤8 字）
   → 按标题反查 B 站，抓 简介 / 标签 / 字幕 / 弹幕(≤150) / 热评(≤20)
   → 生成/追加 Markdown + Mermaid → 转成 Word
   ```

**同一个视频再看一遍不会重复生成**（标题进 `seen` 表，静默）。切走窗口也不会误触发。

## 2. 产物在哪、长什么样

```
知识地图/
├── 课程总览.docx            全局：学科总览思维导图 + 学科列表
├── <学科>/学习手册.docx       该学科每看一个视频就追加一篇
└── .state/
    ├── poll.log            观测/分类/抓取日志（排查先看它）
    ├── state.json          学科、视频、去重表
    ├── manuals/*.md        Word 的 Markdown 源
    └── delivered.json      投递记录
```

每篇包含：一句话简介 → 核心知识点（8~20 条，2~3 层）→ **弹幕与评论讨论焦点** → Mermaid 思维导图
（Word 里渲染成原生分级大纲，不是代码块）。

## 3. 三个操作入口

| 你说 | 会发生什么 |
| --- | --- |
| 「看看现在的状态」 | `course_map_status`：是否启用、输出目录、各学科视频数、最近观测标题 |
| 「扫描一下当前视频」/「把《xxx》整理成笔记」 | `course_map_scan`：立即处理前台窗口（或指定 `title`），绕过 20 秒等待 |
| 「投递课程笔记」 | `course_notes_inbox` → `course_notes_deliver` → `present`，docx 作为文件卡片出现在对话框 |

**投递到新会话**：在新会话里（工作目录选 `D:\course-notes`）说「投递课程笔记」即可，一次出全部待投递文档；
已投过的说「**连已投过的也再投一次**」（对应 `includeDelivered: true`）。

## 4. 想调整行为

配置文件：`C:\Users\一 一\.dsh\profiles\desktop\cordis.patch.yml` 里两段 `- id:` 配置。

| 配置项 | 当前值 | 说明 |
| --- | --- | --- |
| `pollIntervalMs` | 10000 | 轮询间隔，改小更灵敏、更耗 CPU |
| `stablePolls` | 2 | 连续几次稳定才算新视频，改 1 更急但易误判 |
| `outputDir` | D:/course-notes/知识地图 | 换目录后旧文档不会自动搬 |
| `fetchContent` | true | 关掉就只按标题总结（不抓弹幕评论） |
| `titleMinLen` | 4 | 标题最小长度 |
| `presentLimit` | 4 | 单次投递上限（present 最多 4 个） |

改完执行（改**配置**不必重启应用）：

```powershell
& 'D:\edge下载\下载\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\course-notes\plugins\dsh-video-coursemap'
```

改**代码**（`plugins/*/lib/index.js`）则必须**重启 DSH**。

## 5. 出问题时怎么查

1. 看 `.state\poll.log`：
   - 只有 `fg proc=...` 没有 `browser proc=...` → 窗口进程不在白名单，或标题被当首页过滤
   - 有 `browser ... cleaned="..."` 但没有 `classify` → 没到 2 次稳定（窗口被切走）
   - `bvid=none` → 标题反查没找到匹配视频（会把 `matchScore` 写进日志）
   - `classify ... isCourse:false` → LLM 判为无知识含量内容
2. 说「扫描一下当前视频」手动触发一次，能立刻看到结果。
3. `~$xxx.docx` 是 Word 打开时的锁文件，`course_notes_inbox` 会自动忽略。

## 6. 已知限制

- **窗口必须真在前台**：后台播放、最小化、切到别的窗口都不算。
- 只有标题没有 URL，靠标题反查 B 站，同名不同 UP 的视频可能匹配错（日志里有相似度分可核对）。
- B 站匿名评论接口最多 3 条；多数课程没有机器字幕（抓不到就静默降级）。
- 弹幕数量取决于视频本身，课程类常常很少甚至为 0。
- 联想浏览器（`SLBrowser`）**不在**白名单里，用它看课不会被检测到。
