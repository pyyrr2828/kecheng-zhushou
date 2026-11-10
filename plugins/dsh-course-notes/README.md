# dsh-course-notes · 课程笔记投递插件

配合 [dsh-video-coursemap](../dsh-video-coursemap/README.md) 使用：

- **coursemap**：轮询浏览器前台窗口标题 → 识别 B 站视频课程 → LLM 判学科 → 抓简介/字幕/弹幕/热评 → 生成 Word 知识地图与学习手册。
- **本插件**：把生成好的 Word 文档「收件箱化」，并把它投递到会话对话框（配合 DSH 的 `present` 工具显示文件卡片）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `course_notes_inbox` | 列出已生成的 docx（学科 / 文件 / 大小 / 是否已投递），可按学科过滤、只看待投递 |
| `course_notes_deliver` | 取出待投递文档并标记已投递，返回给 agent 用 `present` 呈现（单次最多 4 份） |

## 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `outputDir` | `<用户目录>/课程知识地图` | 与 coursemap 的 outputDir 保持一致（例如 `D:/notes/知识地图`） |
| `presentLimit` | 4 | 单次投递返回的文档数上限（present 上限 4） |

## 投递状态

记录在 `<outputDir>/.state/delivered.json`（路径 → 首次投递时间），重复投递不会重复标记。

## 坑

- 改插件代码后需重启 DSH 才生效（ESM 模块缓存），改配置可用 `dsh plugin --profile desktop add <path>` 触发重载。
