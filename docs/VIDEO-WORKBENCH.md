# 选品与视频工作台

## 当前交付范围

- `/`：跨品类项目简报入口；项目存当前浏览器 localStorage（不存成本/媒体）。
- `/reports.html?entry=track&category=…&market=…`：打开无 PDF 研究入口，不隐式恢复上一个品类任务。历史头盔报告折叠保留，不改写历史事实。
- `/content.html`：保留原内容草稿编辑器。`/intel.html` 和 `/tasks.html` 原有能力保留。
- `/video.html`：两条制作路线、用户记录的抖音/TikTok 候选按播放量排序、商品/人物/素材本地选择与预览、参考视频播放、手动切点、画面变化候选扫描、四维观察笔记、逐字稿、分镜编辑、文字草稿、后端 runtime 结果只读状态和分步本地审核记录。
- `POST /api/video/plan`：纯校验/规划，返回 `output.status=not_generated`。不读浏览器选择的媒体、不写文件、不联网、不运行 CLI；若配置了受信素材索引，只为哈希证据重新读取其受控根目录文件字节。
- `POST /api/video/plan` 可选 `snapshotRef: { briefId, version }`：仅在本地可信配置 `COMMERCE_TASKS_CONFIG.videoSnapshot` 提供只读 `dbPath`、`metaRoot` 和明确项目白名单时，按已持久化 `creative_briefs`/snapshot 文件解析；客户端不能提交快照哈希、路径或权限。绑定失败时拒绝，不降级成手工事实。
- `POST /api/video/rank-candidates`：只校验和排序用户从已登录平台搜索页记录的候选；`completeSearch=false`，不声称全平台最高播放量。
- `POST /api/video/analysis-brief`：把候选元数据、逐字稿和用户观察组织成待审核拆解简报，不把参考视频的画面、人物、声音或事实变成可发布素材。
- `GET /api/video/capabilities`：明确报告 `handoff_only`，不能误报 Hypit Runtime 或生成模型已接通。
- `GET /api/video/runtime-result?briefId=…&version=…&operationId=…`：只在后端显式配置 runtime 结果、媒体和导出受控目录时启用；浏览器只能提交安全引用，不能提交绝对路径、JSON、密钥或 URL。

### COM-11 durable runtime receipt 消费与本地审核

消费适配器严格按 `commerce.video-runtime-result.v1` 校验 `schemaVersion`、`mode`、`operationId`、`requestDigest`、当前 Creative snapshot binding、单调 `revision`、运行状态、媒体/QA/export 分项和 CNY 10.00 累计预算。当前快照、项目、brief 版本、operation 或 requestDigest 不匹配时拒绝；旧 revision 或同 revision 不同内容拒绝，unknown/in-flight 状态不自动重发。消费后的绑定、revision、requestDigest、当前 state 和受控 artifact scope 持久写入 runtime 结果根下的 `.runtime-consumption/index.json` 原子索引，服务重启后恢复同一判定；未完成替换、索引缺失或索引损坏时 fail closed。既有索引可将源回执缺失或损坏恢复为 `blocked`，分别追加 `RUNTIME_RESULT_SOURCE_UNAVAILABLE` 或 `RUNTIME_RESULT_SOURCE_INVALID`，不把旧结果恢复为 ready。

结果 JSON 只是声明。服务端通过 `artifactId` 映射到显式受控根，拒绝遍历、点段和 symlink，并重新读取媒体/导出字节；媒体只有声明哈希与重读字节一致才变为 `verified`，v1 导出只有受控文件重读后与该次已验证媒体的实际字节、长度和 SHA-256 完全一致时才保留 `ready`。缺失、变造、换文件或范围不安全的 artifact 会安全降级为 `blocked`/`not_ready` 并追加大写安全错误码；`needs_review` 不得导出真实成片，不把 `state=succeeded`、`qa=passed` 或 `export=ready` 自动显示为可交付。页面显示继续审核/阻塞原因；`mode=simulated` 始终显著标为合成测试，不能切换成真实生成，原交接包仍保持 `output.status=not_generated`。

后端本地配置在 `COMMERCE_TASKS_CONFIG` 中增加 `videoRuntime: { resultRoot, mediaRoot, exportRoot, projectId? | allowedProjects }`，并复用同一配置的 `videoSnapshot` 只读解析器。未配置或配置不安全时，能力接口将 runtime 消费标为禁用，页面不提供退化的浏览器自证入口。

页面的“分步本地审核”包含商品事实、素材元数据、本地参考节奏、原创分镜和审核交接五步；连续模式按顺序推进，独立模式可跳步。任何输入、路线、参考、快照或请求变化会清除旧审核确认和已读 runtime 结果。审核记录可保存到浏览器草稿并导出为 `video-local-review.json`；它不保存媒体、路径、权利授权，不代表 provider QA、真实生成或发布许可。

### Creative snapshot 交接状态

没有 `snapshotRef` 的旧请求仍返回 `handoff.status=draft_unverified`，商品事实、素材元数据和参考笔记不会被升级为受控证据。带有 `snapshotRef` 的请求返回只读快照文件哈希、项目/商品族/SKU/design 作用域、事实版本与 `contentSha256`、素材版本与内容哈希；当前版本不一致、跨项目或引用篡改均拒绝。

`/video.html` 在“商品约束与交接”区提供手工草稿/受控快照模式选择，可填写服务端签发的 `briefId` 和正整数 `version`。页面明确显示 `draft_unverified`、`trusted_snapshot_bound` 和“媒体哈希未验证”等状态；过期、不可用、未找到、项目未授权、作用域不匹配或篡改错误会显示服务端错误码。页面不提供本机路径、哈希或权限输入，也不新增快照列表读取接口；快照引用仍由 `/api/video/plan` 的可信配置解析。

快照中的素材哈希不是自动的媒体字节核验。只有可信素材索引同时提供 `assetId`、精确 project/passport/SKU/family/design/version 绑定、稳定索引哈希，并由服务端在受控根目录重新读取文件字节且与快照哈希一致时，才返回 `media.verified=true`。越界、过期、已替代、无法读取或字节哈希不一致的文件均保持 `unverified`；现有通用目录索引若没有这组精确绑定，handoff 不会声称已验证媒体哈希。

可信配置形状为 `COMMERCE_TASKS_CONFIG` 中的 `videoSnapshot: { dbPath?, metaRoot, projectId? | allowedProjects, assets? }`；未配置明确项目白名单时，快照路线关闭。`assets` 复用现有只读索引配置 `{ indexFilePath, roots }`，不接受浏览器传入的路径。

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

`COMMERCE_TEST_TMP=… node --test test/video-runtime-result.test.js test/video-snapshot-handoff.test.js test/video-workbench.test.js test/video-client-state.test.js test/server.test.js`：runtime 结果契约、受控 artifact 重读、binding/revision/预算/路径防护、持久索引重启/损坏恢复、分步审核与响应竞态，以及既有 handoff/HTTP/静态页面回归。浏览器另检查跨品类项目→研究简报、素材预览、两路线切换、分镜校验与草稿重开；本 COM-11 代码不启动真实 provider、Ark POST、外部上传或发布。
