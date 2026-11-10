# 作为 DSH 插件使用

> 适合已经在用 DeepSeek Harness、希望在会话里用工具驱动的人。
> 不想装 DSH 的话直接用 `app/` 那个独立应用即可。

## 安装

```powershell
dsh plugin --profile <profile> add <repo>/plugins/dsh-video-coursemap
dsh plugin --profile <profile> add <repo>/plugins/dsh-course-notes
```

插件包自带 `cordis.patch.yml`，安装时会把插件行插进 profile 的插件清单，**不要**再手动 insert 同一 id（会报 duplicate loader entry id）。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-video-coursemap
  name: "dsh-video-coursemap"
  config:
    outputDir: 'D:/notes/知识地图'
    pollIntervalMs: 10000
    stablePolls: 2
    fetchContent: true
    enabled: true

- id: dsh-course-notes
  name: "dsh-course-notes"
  config:
    outputDir: 'D:/notes/知识地图'
    presentLimit: 4
```

改**配置**后重载即可生效：

```powershell
dsh plugin --profile <profile> add <repo>/plugins/dsh-video-coursemap
```

改**代码**必须重启 DSH（ESM 模块缓存，换目录重装也绕不过）。

## 工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `course_map_status` | — | 启用状态、输出目录、学科与视频数、最近观测标题 |
| `course_map_scan` | `{title?}` | 立即扫描；带 `title` 可跳过窗口读取直接处理 |
| `course_notes_inbox` | `{subject?, pendingOnly?, limit?}` | 列出 docx 与投递状态 |
| `course_notes_deliver` | `{subject?, path?, includeDelivered?}` | 取出待投递文档并标记已投递 |

## 在会话里投递 Word

插件不能主动往会话推消息，所以「把笔记发到对话框」是两步：

```
course_notes_inbox  →  course_notes_deliver  →  present（文件卡片出现在对话框）
```

投递记录写在 `<outputDir>/.state/delivered.json`，重复投递不会重复标记。

## 与独立应用共存

两边共用同一份 `core` 与同一个 `outputDir`，靠 `<outputDir>/.state/lock.json` 互斥：

- 独立应用启动即持锁 → 插件每轮先 `canRun()`，拿不到就跳过并记日志
- 应用启动时若发现锁被占用，页面会提示「另一个实例正在运行」

只想用一种：把不用的那个 `enabled` 设为 `false`（插件），或直接关掉应用。
