# 选品与视频工作台

## 当前交付范围

- `/`：跨品类项目简报入口；项目存当前浏览器 localStorage（不存成本/媒体）。
- `/reports.html?entry=track&category=…&market=…`：打开无 PDF 研究入口，不隐式恢复上一个品类任务。历史头盔报告折叠保留，不改写历史事实。
- `/content.html`：保留原内容草稿编辑器。`/intel.html` 和 `/tasks.html` 原有能力保留。
- `/video.html`：两条制作路线、用户记录的抖音/TikTok 候选按播放量排序、商品/人物/素材本地选择与预览、参考视频播放、手动切点、画面变化候选扫描、四维观察笔记、逐字稿、分镜编辑、文字草稿和交接包导出。
- `POST /api/video/plan`：纯校验/规划，返回 `output.status=not_generated`。不读媒体、不写文件、不联网、不运行 CLI。
- `POST /api/video/rank-candidates`：只校验和排序用户从已登录平台搜索页记录的候选；`completeSearch=false`，不声称全平台最高播放量。
- `POST /api/video/analysis-brief`：把候选元数据、逐字稿和用户观察组织成待审核拆解简报，不把参考视频的画面、人物、声音或事实变成可发布素材。
- `GET /api/video/capabilities`：明确报告 `handoff_only`，不能误报 Hypit Runtime 或生成模型已接通。

## 尚未接通（不是已完成能力）

没有抖音/TikTok 搜索 API、自动语音转录/完整视频语义分析，没有镜头内商品分割、跟踪、去物或重绘，没有实际 Hypit Build 或 MP4 渲染。画面变化扫描是浏览器约 0.5 秒采样的启发式候选（最多前 60 秒），不是音频节拍或精确切镜检测。四维笔记、逐字稿和模板分镜不会伪装为模型分析。

## Hypit 交接

选素材、写商品事实/约束与四维笔记 → 选择路线 → 编辑连续分镜并绑定素材 → 确认素材使用权 → 生成并下载 `hypit-task.json` 与 `hypit-brief.md`。

JSON 是本工作台的交接格式，**不是 Hypit 可直接执行的 SVML**。原媒体不打包/不上传；操作者应将清单对应文件复制到交接目录的 `assets/`。已安装 Hypit skill 的 Agent 可据此建立 reference notes、Brief/Treatment、`.svml` / `.svs` / `.svrun` 及 Build Results。实际运行前仍需核验账号、模型条款、素材外传范围与预算；本交接包不授予执行权限。

参考源码与 API 并非通用视频替换保证：路线 A 须逐镜评估遮罩/跟踪/透视/遮挡/去旧商品/重绘，无法保真的镜头应重建；路线 B 用自有商品实拍和授权 AI 人物重建，不复制无授权画面、音乐或声音。商品参数、Logo 和功能必须复核。

## 接入要求与许可证（2026-10-27 核验）

- [Hypit LICENSE](https://github.com/hypit-ai/hypit/blob/main/LICENSE)：修改版 Apache-2.0，允许单组织内部商业工作；第三方托管功能、多租户及商业再分发需另行授权，并有标识保留要求。不是标准 Apache-2.0。
- [开发指南](https://github.com/hypit-ai/hypit/blob/main/docs/guide/develop.md)：Node 22.15+、pnpm 10.33.x；真实 Build 还涉及 ffmpeg/ffprobe、Chromium，以及按功能选择的 Python/WhisperX/OpenCV 等环境。
- [Agent 工作流](https://github.com/hypit-ai/hypit/blob/main/docs/guide/skill.md)：参考笔记/可编辑源文件/账号与预算授权。生成服务独立计费，费用与保真度待实测。

不在本次改动中安装全局 skill/CLI，不更改现有任务注册表、审核与预算机制，不触发真实外部生成或发布。

## 2026-10-28 本地 Runtime 验证

- 已在独立目录 `E:\Projects\ag68-hypit-demo` 使用 `E:\Projects\hypit-runtime` 的本地 CLI
  执行 `check`、`plan`、`runtime up` 和 Route B `build`。
- 验证输入为本地 AG68 商品素材；输出为独立目录中的确定性 15 秒 MP4。该结果证明本地
  Hypit 组合与导出链路可运行，不证明镜头内商品替换、转录、语义分析或远程生成可用。
- 已将选定抖音参考片保存在该独立目录供本地非发布分析，权利状态仍为未确认；它没有被上传、
  发布或用于付费生成。候选记录见 `docs/DOUYIN-REFERENCE-7522327170364083496.json`。

## 验证

`node --test test/video-workbench.test.js test/server.test.js`：两路线契约、权利与素材门、连续时间线、路径/文件类型校验、不能伪造生成权限，以及 HTTP/静态页面回归。浏览器另检查跨品类项目→研究简报、素材预览、两路线切换、分镜校验与草稿重开。
