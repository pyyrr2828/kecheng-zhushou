# 第三方组件与许可

本项目以 [MIT](LICENSE) 许可发布。以下组件来自第三方，按各自许可分发。

## dsh-video-coursemap

- **来源**：<https://github.com/linner1224/dsh-video-coursemap>（v2.0.0）
- **许可**：MIT，见 [plugins/dsh-video-coursemap/LICENSE](plugins/dsh-video-coursemap/LICENSE)
- **位置**：`plugins/dsh-video-coursemap/`
- **说明**：本项目在其基础上做了修改与重构，原始版权归上游贡献者所有。

### 上游原样保留的部分

- `scripts/md2docx.py`：Markdown → Word 转换（含 Mermaid mindmap → 原生分级大纲）
- B 站抓取逻辑（搜索反查、视频信息、弹幕 XML、热评接口）
- 轮询脚本形态（PowerShell + user32 读前台窗口标题）

### 本项目做的修改

| 文件 | 改动 |
| --- | --- |
| `lib/core/searchBili`（原 `lib/index.js`） | 原实现只比较搜索首条结果、相似度阈值 0.5，实测首条常是合集/推广视频（相似度 0.15）导致 `bvid=none`、弹幕评论全空；改为前 12 条取最优、阈值 0.35 |
| `lib/core/cleanTitle` | 原实现只按后缀表剥离，Edge 多 profile 标题残留「- 用户配置 1」导致被误判成 B 站首页整条丢弃；改为去零宽字符 + 剥离平台名后的短尾段 |
| `lib/core/*` | 从单体 `index.js` 抽取为 7 个模块（title/poll/docx/bili/note/store/pipeline），供独立应用与 DSH 插件共用 |
| `lib/index.js` | 退化为 DSH 适配层，只负责读配置、接 `ctx.llm`、注册工具与定时器 |
| `lib/core/store` | 新增「读—改—写」原子状态与 `.state/lock.json` 进程锁、去重表上限 500 |
| `plugins/dsh-course-notes` | 新增（本项目原创）：文档收件箱与投递工具 |

## 其他

- 前端使用原生 JS / CSS，**无第三方运行时依赖**（无框架、无 CDN）。
- Word 生成依赖 `python-docx`（MIT，由使用者自行安装）。
- B 站接口的数据版权归 B 站及相应 UP 主所有；本工具仅抓取公开页面用于个人学习整理，请遵守站点条款与相关法律法规。
