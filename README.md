# 电商内容与运营助手工作台

## E-commerce Content and Operations Assistant Workbench

> 中文说明优先，英文说明见下方。

这是一个面向个体商家的**本地优先、审核优先、证据治理型电商研究与内容生产工作台**。它把商品资料、公开市场研究、竞品与价格情景、图文内容、爆款视频拆解和交付审核放到同一条可追踪流程中。

**当前状态：内部开发工作台，不是已经审核通过的 SaaS 或公开发行包。** 当前分支保留业务实现和内部工作流；发布前仍需单独审计源代码、测试、历史、许可证、真实数据和隐私边界。

- 仓库：<https://github.com/simonshi-stu/E-commerce-Content-and-Operations-Assistant-Agent-for-Individual-Merchants>
- 运行形态：本机 Node.js HTTP 服务 + 浏览器多页面工作区
- 核心原则：`输入/导入 → 规范化 → 人工确认 → 受控执行 → 保存证据 → 审核 → 导出`
- 当前不是：自动登录店铺、自动改价、自动发消息、自动支付、自动投放或自动发布的 Autonomous Commerce Agent

---

# 中文说明

## 1. 为什么要做这个项目

个体商家通常需要同时处理几类互相影响的工作：

1. 先判断一个商品是否值得研究和进入市场；
2. 从公开详情页获取价格、规格、评论和差异化配置；
3. 把采购成本、头程、履约、平台费、广告、退货和促销放进同一个价格情景；
4. 用已经核验的商品事实生成多平台图文；
5. 从有权限使用的参考视频中提炼钩子、节奏和叙事，而不是直接复制人物、声音和画面；
6. 在上传、付费、联系客户和发布之前，明确谁授权、花多少钱、使用哪些素材、结果是否经过审核。

如果这些工作分散在浏览器标签、表格、聊天记录和临时脚本里，最容易出现四类问题：

- 把页面声明当成真实销量或利润；
- 把样本评论比例当成全量差评率；
- 把未经确认的采购成本带入售价结论；
- 把参考视频的结构、人物、音乐、Logo、功能声明和商品事实一起复制。

这个项目的目标不是让模型替商家“自己经营”，而是提供一条**可检查、可暂停、可重做、可导出**的工作链，让模型只在明确的输入、权限和预算内工作。

## 2. 项目定位和目标

### 一句话定位

> 带受控 Agent 内核的证据治理型电商研究与内容生产工作台。

### 目标

- 把商品机会、市场证据和内容生产放在同一个项目上下文中；
- 保留来源、链接、观察时间、单位、币种和证据口径；
- 把观察值、用户确认值、假设、估算和推断分开；
- 对外部请求、模型调用、文件导出和任务执行设置权限与审核门；
- 在未配置账号或未获授权时明确显示“未连接/未执行”，不伪造成功；
- 为未来接入 Hypit、WhisperX、Seedance 等服务保留清晰的交接边界。

## 3. 项目大纲

```text
商品名称 / 品类 / 市场 / 用户需求
                │
                ▼
       商品资料与公开市场证据
       ├─ PDP 价格、规格、评论、配置
       ├─ 竞品可比性与价格带
       └─ 成本、物流、平台费情景
                │
                ▼
          选品与定价决策
          ├─ 事实 / 假设 / 缺口
          ├─ 保本价 / 目标利润价
          └─ 证据和风险说明
                │
       ┌────────┴────────┐
       ▼                 ▼
    图文内容          爆款视频
    事实约束          参考拆解
    多平台草稿        分镜与 Hypit 交接
       │                 │
       └────────┬────────┘
                ▼
          审核、修订、导出
```

视频的未来执行链单独受控：

```text
参考视频与权利记录
  → Hypit media 技术证据
  → WhisperX 逐词转录（获授权后）
  → 语义拆解 Agent：钩子 / 镜头 / 节奏 / 声音 / 可迁移结构
  → 本地商品素材 + Script / Brief / SVML / SVRUN
  → plan / pricing / 账号 / 预算 / 外传授权确认
  → Seedance 或其他已批准 Provider
  → Build、逐镜审片、导出
```

## 4. 当前项目做了什么

### 4.1 工作台入口和项目上下文

- `/` 是跨品类工作台首页；可以创建项目名称、品类和目标市场。
- 项目简报保存在当前浏览器 `localStorage`，用于带着相同上下文进入选品或视频页面。
- 不把成本、媒体文件或外部任务写进这个项目简报。
- 支持深色/浅色主题，页面之间使用统一导航和状态提示。

### 4.2 选品洞察

- `/sourcing.html` 接受产品大类、用户需求、目标市场、英文 Amazon 公开页检索词和特征提示。
- 读取可访问的 Amazon.com 搜索页和商品详情页，记录价格、品牌、标题、图片、重量、评分、评论数量、页面声明、可见好评/差评和特征出现情况。
- 对差评率标明口径：公开星级分布、可见评论样本，或暂无口径。
- 保留请求次数、检索词和观察日期等来源信息，并把不可访问页面记录为缺口。
- 可以导出 JSON 或 CSV。
- 不把详情页字段当成供应商成本、真实销量、后台销售额或利润；不声称候选是平台全量最高播放量。

### 4.3 竞品、市场和价格情景

`/intel.html` 及其 API 提供确定性计算和受控解释：

- 价格统计、竞品比较和候选批量评估；
- CSV/粘贴文本导入和市场行解析；
- 规格、成本、物流、平台佣金、广告、退货、税费、折扣和目标利润的情景计算；
- 汇率查询和多币种换算；
- 对完整成本输入计算保本价、目标利润价、建议价和计划售价利润；
- 缺少型号、变体、单位、币种、采购条款、成本或费用确认时，返回缺口，不强行给出“能赚钱”的结论；
- 模型解释只解释已经计算出的结果，不替代来源证据和成本确认。

### 4.4 产品资料与报告中心

`/reports.html` 支持受审核门控制的任务流：

```text
上传 PDF / 创建任务
  → 解析和证据审计
  → 用户确认或修正型号、成本、单位、币种、条款
  → 研究 / 计算 / 构建工作簿
  → 预览指定版本
  → 独立审核通过
  → 下载 Excel 或其他允许的交付物
```

报告任务使用服务端会话签名、版本号和构建版本校验；未通过审核时不能下载可交付工作簿。

### 4.5 图文内容生成

- `/content.html` 支持商品名称、描述、卖点、规格、价格信息、售后、目标受众、语气和平台选择。
- 支持 PNG/JPEG/WebP 图片输入；图片在调用模型前经过数量、大小、格式和真实文件头校验。
- `/api/generate` 调用本地配置的 OpenAI-compatible Provider，返回多平台草稿和审核结果。
- 内容生成后仍可编辑、重开本地历史、导出 Markdown/JSON 等工作结果。
- 生成内容会经过事实和风险检查；模型输出不是商品事实的来源。

### 4.6 爆款视频工作台和 Hypit 交接

`/video.html` 当前是**参考拆解和制作交接工作台**，不是已经接通的自动视频生成器：

- 用户记录抖音/TikTok 候选，系统只在用户输入的候选中按播放量排序；
- 本地选择商品图片、已授权人物图片、实拍图片/视频和一条参考视频；
- 浏览器本地播放参考视频，手动记录切点，或用约 0.5 秒采样做画面变化候选扫描；
- 记录四个观察维度：节奏、文案、流程、氛围，并可粘贴已获授权的逐字稿；
- 编辑连续时间线、动作、文案、剪辑说明和创作素材绑定；
- 必须确认素材权利；使用人物时必须单独确认形象授权；
- 导出 `hypit-task.json` 和 `hypit-brief.md`，供安装 Hypit skill 的 Agent 继续创建 reference notes、Brief/Treatment、`.svml`、`.svs`、`.svrun` 和 Build Results。

当前视频接口返回 `handoff_only`：不自动上传媒体、不调用生成模型、不运行 Hypit Build、不生成 MP4、不扣费、不发布。详见 [视频工作台边界](docs/VIDEO-WORKBENCH.md) 和 [Hypit 视频开发流程](docs/HYPIT-VIDEO-DEVELOPMENT.md)。

本项目记录并使用 Hypit 上游仓库：<https://github.com/hypit-ai/hypit>。主应用不 vendoring Hypit 源码；本地验证和未来 Seedance 接入均需要独立核验版本、许可、Provider、账号、预算和外传范围。当前仓库和本地配置中没有火山引擎、Ark、Seedance 或 HypiHub API key。

### 4.7 受控 Agent 内核和任务中心

`lib/commerce/` 包含项目、证据、内存、Provider 注册、预算、幂等、隐私 profile、租约、取消、恢复和有限 DAG 编排能力：

- 只能执行预先注册、带 Schema 和角色白名单的工具；
- 计划、上下文、输入和输出有大小和字段限制；
- 外部调用需要权限、项目/任务范围、预算和稳定操作身份；
- 运行结果保存证据和质量检查点；
- 任务中心没有可信本地配置时，`/tasks-api/` fail closed；
- 当前不开放自动登录、改价、发消息、支付、投流、发布或视频付费生成。

## 5. 架构介绍

### 5.1 分层结构

```text
┌────────────────────────────────────────────┐
│ Browser UI                                 │
│ public/*.html + public/*.js + CSS          │
│ 表单、预览、状态、草稿、审核门、导出       │
└───────────────────┬────────────────────────┘
                    │ fetch / local state
┌───────────────────▼────────────────────────┐
│ Local HTTP boundary                         │
│ server.js                                   │
│ 静态文件、JSON、multipart、路径和方法校验   │
└───────────────────┬────────────────────────┘
                    │
┌───────────────────▼────────────────────────┐
│ Deterministic domain services               │
│ lib/validate.js, pricing.js, market.js      │
│ candidates.js, product-insights.js          │
│ video-workbench.js, viral-replica.js        │
│ report-workflow.js, report-jobs.js           │
└───────────────────┬────────────────────────┘
                    │ optional provider calls
┌───────────────────▼────────────────────────┐
│ Provider and governed execution             │
│ lib/provider.js                              │
│ lib/commerce/{orchestrator,worker,budget,  │
│ privacy,evidence,run-store,...}.js          │
└───────────────────┬────────────────────────┘
                    │ explicit outbound boundary
┌───────────────────▼────────────────────────┐
│ Amazon public pages / FX / configured model │
│ / future Hypit Runtime / future Seedance    │
└────────────────────────────────────────────┘
```

### 5.2 目录大纲

```text
server.js                 本地 HTTP 服务、静态页面和 API 路由
public/
  index.html              项目工作台首页
  sourcing.html           跨品类公开页面选品
  intel.html              竞品、价格和成本计算
  reports.html            PDF 任务、审计、研究和工作簿
  content.html            多平台图文草稿
  video.html              爆款参考拆解和 Hypit 交接
  tasks.html              受控任务中心
  *.js / *.css            页面交互、国际化和视觉系统
lib/
  commerce/               证据、预算、隐私、幂等、任务和 Agent 编排
  amazon-research.js      Amazon 公开前台研究适配器
  product-insights.js     产品页面字段和品类特征摘要
  pricing.js              多币种、费用和价格情景计算
  provider.js             DeepSeek/OpenAI-compatible 模型边界
  video-workbench.js      视频任务包校验和 Hypit 交接数据
  viral-replica.js        候选排序和参考拆解简报
  report-*.js             报告任务、审核、版本和导出
docs/
  PROJECT-CLASSIFICATION.md
  VIDEO-WORKBENCH.md
  HYPIT-VIDEO-DEVELOPMENT.md
  PRD-WORKFLOW.md
test/                     Node 内置测试和拒绝路径测试
```

### 5.3 API 分组

| API | 作用 | 当前边界 |
|---|---|---|
| `GET /api/health` | 检查本地服务和模型配置 | 不验证业务账号余额 |
| `POST /api/sourcing/insights` | Amazon 公开详情页研究 | 用户触发时才可能联网 |
| `POST /api/intel/*` | 候选、市场、价格、定价和解释 | 计算不等于事实或利润保证 |
| `POST /api/generate` | 多平台图文草稿 | 需要本地模型配置，结果需审核 |
| `GET /api/video/capabilities` | 报告视频能力状态 | 当前是 `handoff_only` |
| `POST /api/video/rank-candidates` | 排序用户输入的候选 | 不是平台全量搜索 |
| `POST /api/video/analysis-brief` | 组织人工观察和逐字稿 | 不声称已经完成模型语义分析 |
| `POST /api/video/plan` | 校验素材、权利、分镜并生成交接数据 | 不读媒体、不上传、不 Build |
| `/api/reports/jobs/*` | 报告任务、审计、研究、构建、预览和下载 | 下载受独立审核门控制 |
| `/tasks-api/*` | 受控任务中心 | 未配置 `COMMERCE_TASKS_CONFIG` 时关闭 |

### 5.4 数据和权限模型

每个重要字段尽量保留：

```text
身份 / 项目 / SKU / 市场
数值 / 单位 / 币种 / 观察时间
来源链接或文件 / 权利依据
事实类型：observed / confirmed / assumption / estimate / inference
确认状态 / 版本 / 是否允许进入外部输出
```

对外部副作用采用 fail-closed：

```text
输入校验
  → 作用域确认
  → 权限确认
  → 预算预留
  → 幂等操作
  → 工具调用
  → 证据和质量检查点
  → 人工审核
  → 导出或下一步
```

没有明确证据时保留未知值；有明确假设时标记为假设；不能因为页面显示了一个数字，就自动把它写成利润、销量或认证结论。

## 6. 交互设计原则

### 6.1 统一的状态语言

页面不只显示“成功/失败”，还显示下一步能否执行：

- `未配置`：例如没有模型 key；
- `待确认`：需要用户确认型号、成本、权利或费用；
- `可规划`：输入完整，但还未产生外部副作用；
- `运行中`：已经进入有记录的任务；
- `需审核`：结果存在，但不能直接交付；
- `已交付`：通过审核且允许下载；
- `已阻断`：缺少权限、预算、证据或配置。

### 6.2 快速路径和审计路径分离

- 快速路径：创建项目、看页面、编辑草稿、生成本地交接数据。
- 审计路径：上传 PDF、确认成本、绑定来源、运行研究、生成工作簿、独立审核和下载。
- 任何需要联网、模型调用、上传、付费或发布的动作都不应被“预览”按钮隐式触发。

### 6.3 交互 Demo A：从项目进入选品

1. 打开 `http://127.0.0.1:5178/`。
2. 输入项目名称“秋冬通勤用品”、品类“骑行头盔”、市场“美国”。
3. 点击“新建本地项目”。项目只写入当前浏览器。
4. 点击项目卡片的“开始选品洞察”，页面通过 URL 参数带入项目、品类和市场。
5. 填写英文检索词，例如 `bike helmet with light`，选择是否读取评论页。
6. 提交后查看详情页数量、价格中位数、评分、评论数、重量、特征和差评率口径。
7. 导出 JSON/CSV；如果页面不可访问，在错误区显示缺口，而不是把缺口补成猜测。

### 6.4 交互 Demo B：选品研究 API

下面是一个最小请求示例；检索会访问公开页面，示例不会保证返回固定商品数量：

```http
POST /api/sourcing/insights
Content-Type: application/json

{
  "category": "bike helmet",
  "userNeed": "通勤、轻量、夜间可见",
  "marketplace": "Amazon.com",
  "queries": ["bike helmet with light", "commuter cycling helmet"],
  "featureHints": "front light, MIPS, visor",
  "maxProductPages": 5,
  "includeReviewPages": true
}
```

界面重点展示的是证据和口径，例如：

```json
{
  "metrics": {
    "productPages": 5,
    "price": { "median": 39.99 },
    "negativeReviewRate": { "ratePct": 12.5, "basis": "visible_review_sample" }
  },
  "provenance": {
    "queries": ["bike helmet with light"],
    "observedAt": "2026-10-28"
  },
  "errors": []
}
```

这类结果只能说明“本次读取到的公开页面观察值”，不能直接说明销量、利润或全市场结论。

### 6.5 交互 Demo C：成本和售价情景

在 `/intel.html` 中先确认商品型号、变体、采购成本和费用，再调用 `POST /api/intel/pricing`。典型输入如下：

```json
{
  "payoutCurrency": "USD",
  "rates": { "CNY": 0.138, "USD": 1 },
  "productCost": { "amount": 40, "currency": "CNY" },
  "shipping": { "amount": 4, "currency": "USD", "mode": "per_unit" },
  "fulfillmentFee": { "amount": 5.2, "currency": "USD" },
  "adCost": { "amount": 12, "mode": "percent" },
  "referralFeeRate": 15,
  "targetMarginRate": 25,
  "price": { "amount": 39.99, "currency": "USD" },
  "marketplace": "Amazon.com"
}
```

结果包含 `breakEvenPrice`、`suggestedPrice` 和 `atPlannedPrice`。如果缺少成本单位、汇率日期、履约费、退货准备金或其他关键输入，系统返回 `incomplete` 和缺口，不把情景值包装成真实净利润。

### 6.6 交互 Demo D：图文生成

1. 打开 `/content.html`。
2. 填写商品事实、平台和语气，可添加最多 4 张经过格式校验的图片。
3. 点击生成；没有模型配置时，页面明确返回“provider not configured”，不会伪造草稿。
4. 有配置时，`/api/generate` 返回 `drafts` 和 `review`；用户修改后再导出。

最小请求形态：

```json
{
  "locale": "en",
  "productName": "Commuter Bike Helmet",
  "productDescription": "A lightweight helmet for daily city riding.",
  "platforms": ["Amazon", "Xiaohongshu"],
  "tone": "clear and helpful",
  "sellingPoints": ["adjustable fit", "front light only if verified"],
  "specifications": [{ "name": "weight", "value": "user-confirmed value" }],
  "images": []
}
```

### 6.7 交互 Demo E：爆款视频到 Hypit 交接

1. 在 `/video.html` 的候选区粘贴用户从已登录抖音/TikTok 页面记录的 JSON。
2. 点击“按播放量排序”，系统只说明“输入候选中的排序”，不声称平台全量第一。
3. 选择有权使用的本地参考视频；浏览器本地预览，不从 URL 自动抓取。
4. 手动记录切点，或执行画面变化候选扫描；页面明确标记这些候选不是精确切镜、音频节拍或语义分析。
5. 填写节奏、文案、流程、氛围、逐字稿、商品事实和禁止事项。
6. 选择“商品替换”或“素材重组”，编辑连续分镜并绑定商品/人物/实拍素材。
7. 勾选素材权利和人物授权后，点击“生成 Hypit 交接包”。
8. 下载 `hypit-task.json` 和 `hypit-brief.md`；此时视频仍未生成。

能力状态的实际形态类似：

```json
{
  "engine": "hypit",
  "mode": "handoff_only",
  "renderConnected": false,
  "paidExecutionEnabled": false,
  "features": ["local_asset_preview", "local_visual_cut_candidates", "editable_storyboard", "hypit_brief_export"]
}
```

未来接入 Seedance 时，仍需先完成 Provider、凭据、预算、素材外传和权利确认；不会因为生成按钮存在就自动上传、扣费或发布。

### 6.8 交互 Demo F：报告任务审核门

```text
上传 PDF
  ↓
查看解析字段和证据图片
  ↓
修正并确认型号 / 成本 / 单位 / 币种 / 条款
  ↓
运行研究和构建
  ↓
预览当前 revision / buildVersion
  ↓
独立审核通过
  ↓
允许下载 Excel
```

如果用户尝试下载未审核工作簿，服务端返回 `release_blocked`；如果客户端持有旧版本链接，服务端返回版本不匹配，而不是静默交付旧文件。

## 7. 本地运行

### 环境要求

- Node.js 18 或更高版本；
- `npm install` 安装依赖；
- 需要真实模型调用时，配置一个本地、被忽略的 `.env.deepseek.local`；
- 不要把任何真实 API key 写入源码、README、SVML、Runtime Profile 或 Git。

```sh
npm install
npm start
```

打开 <http://127.0.0.1:5178>。

### 模型配置示例

复制 `.env.example` 为 `.env.deepseek.local`，只在本机填写：

```dotenv
DEEPSEEK_API_KEY=replace_with_your_own_key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_VISION_MODEL=
DEEPSEEK_BASE_URL=https://api.deepseek.com
PORT=5178
```

当前仓库没有 Volcengine/Ark/Seedance/HypiHub 凭据配置。未来凭据应通过安全的本地环境或凭据存储提供，并在真正执行前单独确认预算和素材外传范围。

### 测试

```sh
npm test
```

测试覆盖验证、拒绝路径、路径穿越、外部 URL、成本和价格计算、幂等、预算、隐私 profile、报告版本、审核门、视频权利门和 HTTP 回归。

## 8. 当前明确没有做什么

- 没有抖音/TikTok 搜索 API；
- 没有绕过登录、验证码、付费墙或平台限制；
- 没有把参考视频自动上传给模型；
- 没有完成主应用内的完整 WhisperX 转录和多模态语义拆解；
- 没有连接主应用的 Hypit Runtime、Seedance 或火山引擎生成 Provider；
- 没有把静态图片轮播或简单叠图称为镜头内无痕商品替换；
- 没有自动发布、群发、支付、投流或修改店铺数据；
- 没有 RAG、向量数据库、MCP 或 LangChain 主链路；当前确定性证据和受控工具边界优先于框架堆叠。

## 9. 重要文档

- [项目定性与技术边界](docs/PROJECT-CLASSIFICATION.md)
- [独立报告审计说明](docs/INDEPENDENT-REPORT-AUDIT.md)
- [视频工作台范围和集成边界](docs/VIDEO-WORKBENCH.md)
- [Hypit 视频开发流程和上游声明](docs/HYPIT-VIDEO-DEVELOPMENT.md)
- [PRD 工作流和验收规则](docs/PRD-WORKFLOW.md)
- [Hypit 上游仓库](https://github.com/hypit-ai/hypit)

## 10. 发布边界和许可证

本 checkout 仍是内部工作台，不能直接当成公开 SaaS 或多租户服务发布。根目录 `LICENSE` 不等于私有业务资料、真实报告、提示词、数据和历史全部获得发布许可。未来公开仓库应只保留经过审查的通用 UI、无敏感示例和中性占位内容；内部策略、数据、报告和真实业务逻辑应留在内部库。

Hypit 的上游许可证、NOTICE、版本和服务条款以其仓库为准。当前文档记录的是上游使用和未来交接边界，不代表主应用已经取得 Hypit 托管、商业再分发或 Seedance 服务授权。

---

# English Documentation

## 1. What this project is

This repository is a **local-first, review-first, evidence-governed commerce research and content workbench for individual merchants**. It connects product facts, public market research, competitor and pricing scenarios, written content, viral-video reference analysis, and delivery review in one traceable workflow.

**Status: internal development workbench, not an approved SaaS or public release package.** The current branch contains business-specific implementation and internal workflow code. A separate source, history, privacy, licensing, and data audit is required before publication.

- Repository: <https://github.com/simonshi-stu/E-commerce-Content-and-Operations-Assistant-Agent-for-Individual-Merchants>
- Runtime: local Node.js HTTP server plus browser-based workspaces
- Core pattern: `input/import → normalize → confirm → execute under gates → persist evidence → review → export`
- Not an autonomous commerce agent: it does not automatically log in, change prices, message customers, pay, advertise, or publish.

## 2. Why it exists

An individual merchant must often make a connected sequence of decisions: whether a product is worth researching, what public pages actually show, whether confirmed costs can support a market price, how to write platform-specific content, and how to adapt a reference video without copying unauthorized identity, audio, footage, claims, or product facts.

The workbench exists to keep those decisions together while preserving provenance and stopping before external side effects. It separates observed values, user-confirmed facts, assumptions, estimates, and inferences. Missing evidence remains missing instead of being turned into a confident answer.

## 3. Project outline

```text
Product / category / market / need
              ↓
Public evidence and product facts
  PDP fields · competitors · reviews · costs · fees
              ↓
Decision support
  comparability · price band · break-even · target-price scenarios
              ↓
Creative production
  multi-platform copy · reference-video structure · storyboard
              ↓
Review and governed handoff
  evidence · rights · budget · provider · export
```

The future video route is deliberately separate from the current local handoff:

```text
Reference and rights record
  → Hypit media evidence
  → authorized WhisperX word-level transcript
  → semantic decomposition Agent
  → local product assets + Script / Brief / SVML / SVRUN
  → provider / credential / budget / upload authorization
  → Seedance or another approved provider
  → Build, shot review, and export
```

## 4. What has been implemented

### Workbench and project context

`/` creates a cross-category project brief with a name, category, and target market. The brief is stored in the current browser and can open the research or video workspace with the same query context. Cost records and media files are not stored in the project brief.

### Public product research

`/sourcing.html` accepts a category, user need, English Amazon public-page queries, marketplace text, and feature hints. The adapter can collect accessible PDP price, brand, title, image, weight, rating, review count, page claims, visible positive/negative samples, and feature observations. It exposes request provenance, observation date, and read errors, and can export JSON/CSV.

This is not a sales, profit, or platform-wide ranking oracle. A negative-rate value is labelled by its basis, such as a public rating histogram or visible review sample.

### Competitor, market, and pricing support

`/intel.html` and its APIs provide deterministic candidate assessment, competitor comparison, price statistics, pasted/CSV parsing, market analysis, FX conversion, and cost/fee scenarios. Confirmed product cost, freight, fulfillment, referral fees, advertising, returns, taxes, discounts, and target margin can produce break-even and target-price values. Incomplete inputs return explicit missing fields instead of a fabricated profitability conclusion.

### Reports

`/reports.html` supports PDF job upload, parsing, evidence audit, user confirmation, research, workbook build, versioned preview, independent review, and gated download. Report sessions are server-signed, and stale artifact versions are rejected.

### Written content

`/content.html` accepts product facts, selling points, specifications, audience, tone, platforms, and up to four validated PNG/JPEG/WebP images. `/api/generate` calls the locally configured OpenAI-compatible provider and returns drafts plus a review result. The provider is optional; a missing key is an explicit configuration error.

### Viral-video and Hypit handoff

`/video.html` ranks user-recorded Douyin/TikTok candidates, previews a local reference video, records manual cuts or visual-change candidates, captures rhythm/copy/flow/atmosphere notes and an authorized transcript, edits a continuous storyboard, validates rights, and exports `hypit-task.json` plus `hypit-brief.md`.

The current video API is `handoff_only`. It does not upload media, call a video model, run Hypit Build, render an MP4, charge a provider, or publish. The main application documents and hands off to the Hypit upstream project; it does not vendor Hypit source. See [VIDEO-WORKBENCH.md](docs/VIDEO-WORKBENCH.md) and [HYPIT-VIDEO-DEVELOPMENT.md](docs/HYPIT-VIDEO-DEVELOPMENT.md).

No Volcengine, Ark, Seedance, or HypiHub API key is stored in this repository or its checked-in configuration. Future credentials must be supplied through a secure local mechanism after budget, provider, upload scope, and rights are confirmed.

### Governed Agent kernel

`lib/commerce/` contains scoped projects, evidence, memory, provider schemas, budget controls, idempotency, privacy profiles, leases, cancellation/recovery, and finite DAG orchestration. Tools are registered with schemas and role allowlists. The optional task center fails closed without trusted local configuration. It does not expose automated login, price changes, customer messaging, payment, advertising, publishing, or paid video generation.

## 5. Architecture

```text
Browser pages: public/*.html, public/*.js, CSS
        │ local state and fetch
        ▼
server.js: static files, JSON/multipart input, route and method checks
        ▼
Deterministic services: validation, research, pricing, reports, video plans
        ▼
Optional provider boundary: model adapter, Amazon public pages, FX
        ▼
Governed execution: evidence, privacy, budget, idempotency, leases, quality gates
        ▼
Future independently authorized Hypit Runtime / Seedance path
```

Key directories:

```text
server.js                 local HTTP server and API router
public/                   workbench pages, browser interactions, styles
lib/commerce/              evidence, privacy, budget, tasks, orchestration
lib/                       research, pricing, providers, reports, video handoff
docs/                      scope, PRD, Hypit workflow, governance boundaries
test/                      Node built-in tests, happy paths, refusal paths
```

Important API groups:

| API | Purpose | Boundary |
|---|---|---|
| `GET /api/health` | local and model configuration status | does not verify business balance |
| `POST /api/sourcing/insights` | Amazon public-page research | outbound only when invoked |
| `POST /api/intel/*` | candidates, market, pricing, and interpretation | calculation is not evidence |
| `POST /api/generate` | multi-platform copy drafts | configured provider and review required |
| `GET /api/video/capabilities` | video capability status | currently `handoff_only` |
| `POST /api/video/rank-candidates` | rank user-supplied candidates | not a platform-wide search |
| `POST /api/video/analysis-brief` | organize user observations/transcript | not claimed model analysis |
| `POST /api/video/plan` | validate assets, rights, and storyboard | no upload, CLI, Build, or MP4 |
| `/api/reports/jobs/*` | report job lifecycle and artifacts | download requires review |
| `/tasks-api/*` | controlled task center | disabled without local config |

## 6. Interaction design demos

### Demo A: create a project and open a workflow

Open `/`, enter a project name, category, and market, then create the local brief. The project card opens `/sourcing.html` or `/video.html` with the same context in URL parameters. The UI states that the project is local and has not executed external research.

### Demo B: public research request

```http
POST /api/sourcing/insights
Content-Type: application/json

{
  "category": "bike helmet",
  "userNeed": "commuter use, light weight, night visibility",
  "marketplace": "Amazon.com",
  "queries": ["bike helmet with light", "commuter cycling helmet"],
  "featureHints": "front light, MIPS, visor",
  "maxProductPages": 5,
  "includeReviewPages": true
}
```

The UI renders metrics, product cards, feature bars, review themes, provenance, and errors. It does not turn the response into a profit claim.

### Demo C: copy generation

Open `/content.html`, enter verified product facts, choose platforms, optionally add images, and submit. With a configured model, the response contains `drafts` and `review`; without one, the server returns an explicit `provider_not_configured` error. The user edits before export.

### Demo D: reference video handoff

Paste user-recorded candidate metadata, rank it, select a local authorized reference, mark cuts, write four observation dimensions, define product constraints, edit continuous shots, confirm rights, and download:

```text
hypit-task.json       structured handoff metadata
hypit-brief.md        human/Agent production brief
```

The result has `output.status = "not_generated"`, `svmlCompiled = false`, and permissions for paid generation, upload, and publishing set to false. This is intentional and visible in the UI.

### Demo E: report release gate

```text
upload PDF → inspect evidence → confirm cost and identity
→ research/build → preview revision → independent review
→ download only after releaseAllowed=true
```

Old artifact versions and unreviewed workbooks are rejected server-side.

## 7. Local setup

Requirements: Node.js 18 or later.

```sh
npm install
npm start
```

Open <http://127.0.0.1:5178>. For optional model-backed operations, copy `.env.example` to the ignored `.env.deepseek.local` and configure the local provider. Never commit a real key.

```dotenv
DEEPSEEK_API_KEY=replace_with_your_own_key
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_VISION_MODEL=
DEEPSEEK_BASE_URL=https://api.deepseek.com
PORT=5178
```

Run tests with:

```sh
npm test
```

## 8. Explicit non-goals and limitations

- no Douyin/TikTok search API or login/CAPTCHA bypass;
- no automatic reference-video upload;
- no complete in-app WhisperX transcription or multimodal semantic decomposition yet;
- no connected Hypit Runtime, Seedance, Volcengine, or paid generation provider in the main app;
- no claim that image compositing is invisible in-shot product replacement;
- no automated publishing, customer messaging, payments, advertising, or store mutation;
- no RAG, vector database, MCP, or LangChain in the primary path; deterministic evidence and bounded tools currently fit the problem better.

## 9. Documentation and release boundary

- [Project classification and technical boundaries](docs/PROJECT-CLASSIFICATION.md)
- [Video workbench scope and integration boundaries](docs/VIDEO-WORKBENCH.md)
- [Hypit video development and upstream declaration](docs/HYPIT-VIDEO-DEVELOPMENT.md)
- [PRD workflow and acceptance rules](docs/PRD-WORKFLOW.md)
- [Hypit upstream repository](https://github.com/hypit-ai/hypit)

The root `LICENSE` is not clearance to publish private business data, reports, prompts, strategies, or repository history. A future public repository should contain only reviewed generic UI, neutral placeholders, and sanitized examples. Hypit's upstream license, notices, version, and service terms remain authoritative; this repository documents an internal handoff and future integration boundary, not a grant of Hypit hosting, commercial redistribution, or Seedance service rights.
