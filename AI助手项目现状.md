# AI助手项目现状

> 本文档是项目的长期维护记录。以后每次修改代码、配置、数据结构、部署方式或功能行为时，都应同步更新本文档的“最后更新时间”“当前状态”和“后续变更记录”。

## 1. 项目快照

- 项目名称：AI助手服务台
- 项目目录：`E:\Qwen-cc\aizhushou`
- GitHub 仓库：<https://github.com/chenallens/aizhushou>
- 当前分支：`main`
- 当前功能基线（不含本文档提交）：`29a7625`
- 最后更新时间：2026-09-04
- 当前部署服务器：Windows Server，内网地址 `172.28.200.119`
- 当前访问地址：`http://172.28.200.119/`
- 当前状态：管理员面板折叠功能已完成，并已生成 2026-09-04 Windows + Nginx 发布包；该新包尚待复制到内网服务器升级。

## 2. 项目目标

本项目是制造现场使用的内网 AI 服务工作台，当前集中提供以下能力：

1. 知识问答助手
2. 翻译助手
3. 标准解读助手（制造一厂、制造二厂、制造三厂）
4. PDF 转 Word
5. 使用统计、问题反馈及管理员后台

项目不建立普通用户账号体系。普通用户可直接使用助手和提交反馈，管理员通过独立账号登录后维护提示词、术语词库并回复反馈。

## 3. 技术架构

### 3.1 前端

- React 19
- Vite 8
- Lucide React 图标
- 浅色科技风界面
- 桌面端和移动端响应式布局

主要文件：

- `src/App.jsx`：页面、交互和接口调用
- `src/App.css`：整体视觉样式和响应式布局
- `src/main.jsx`：React 入口

### 3.2 后端

- Node.js
- Express 5
- `express-session` 管理管理员登录状态
- `multer` 处理文件上传
- `undici` 处理部分内网 HTTPS 请求
- 共享模型客户端位于 `server/model-client.js`

主要文件：

- `server/index.js`：API、数据库、文件处理和任务管理
- `server/model-client.js`：模型请求、流式响应和思考内容过滤

### 3.3 数据与文件

- SQLite 实现：`sql.js`
- 数据库：`storage/aizhushou.sqlite`
- 上传文件：`storage/uploads/`
- 转换过程文件：`storage/converted/`
- 结果文件：`storage/results/`
- 术语词库 Markdown：`storage/glossary.md`
- 模型审计日志：`storage/logs/`

`storage/` 中的运行数据不会提交到 GitHub。部署或升级时必须注意保留服务器上的数据库、词库、提示词和结果文件。

## 4. 当前界面

### 4.1 首页

- 顶部名称为“AI助手服务台”。
- 顶部提供“问题反馈”按钮。
- “核心功能”位于“统计指标”上方。
- 核心功能和统计指标标题均左对齐，与问题意见分区风格一致。
- 首页不再显示原先顶部的介绍块。
- 知识问答助手说明文字为“知识来源为云盘内相关文档”。
- 首页显示问答助手、翻译助手等入口和使用次数。
- 活跃访问支持日、月、年统计。
- 所有用户均可提交问题反馈并查看管理员回复。

### 4.2 管理员界面

管理员登录后可以：

- 回复用户反馈。
- 逐条新增、修改、删除中英文术语。
- 分别维护制造一厂、制造二厂、制造三厂的标准解读提示词。
- 查看模型调用审计信息。
- “翻译术语词库”“标准解读提示词”“模型思考模式检查”三个区域可分别点击展开或收起，进入管理员页面时默认全部收起。

管理员账号密码来自服务器 `.env`，不写入源代码和本文档。

## 5. 知识问答助手

### 5.1 当前调用方式

知识问答助手通过后端代理现有云盘知识问答接口：

```text
${QA_API_BASE_URL}/api/intelli-search/v2/bots/${QA_BOT_ID}/chat
```

当前机器人 ID 的默认配置为：

```text
7172f29d-69c1-4f71-9646-03ab127e8f53
```

身份认证流程适配了内网 OA：

- `QA_AUTH_CLIENT_ID` 和 `QA_AUTH_CLIENT_SECRET` 用于调用认证接口，不是用户的 OA 密码。
- 用户身份可以来自 OA 页面传入的信息。
- `QA_DEFAULT_ACCOUNT` 可用于本地或未从 OA 页面进入时的测试账号。
- 内网证书链无法被 Node.js 默认信任时，可设置 `QA_TLS_REJECT_UNAUTHORIZED=false`。

### 5.2 回答显示

- 当前使用 SSE 流式传输，不再长时间等待后一次性显示全文。
- 已过滤接口最初返回的 `status: processing` JSON，避免它显示在回答区域。
- 已过滤模型的 `<think>` 思考内容。
- 已清理接口返回的引用 HTML 标签。
- 回答内容经过排版处理。
- 引用资料可显示原文档链接，用户可以点击跳转查看。
- Nginx 对问答流式接口关闭代理缓冲，以免流式内容被攒成整段后再返回。

## 6. 翻译助手

### 6.1 使用形式

翻译助手当前是问答式界面，支持两种输入：

- 用户直接发送一段文字进行翻译。
- 用户上传 `.docx` Word 文件进行翻译。

界面明确提示不要上传 PDF、Excel 或其他文件。后端也会验证文件格式，避免只依靠前端提示。

### 6.2 翻译流程

翻译不是单次模型调用，而是三个阶段：

1. 直接翻译原文。
2. 根据管理员词库修正术语并润色。
3. 检查并修复错译、漏译、术语、语法、时态、指代和表达问题。

对话翻译会显示当前处理阶段和进度，最终阶段采用流式输出。每次发送新内容后，页面自动滚动到最新一条对话。

### 6.3 Word 文件翻译

- 仅接受 `.docx`。
- 上传后创建后台任务，并显示分块和阶段进度。
- 使用 Mammoth 和 HTML 解析器把 Word 内容整理成 Markdown 风格结构。
- 尽量保留标题、段落、列表和表格的逻辑结构。
- 网页结果按 Markdown 源内容显示。
- 下载的 Word 文件内部保存的是 Markdown 格式文本，不再强行转换为 Word 原生标题或表格样式。

### 6.4 术语词库

- 管理员逐条维护中文术语、英文术语和备注。
- 数据保存在 SQLite 的 `glossary_terms` 表中。
- 后端自动生成 `storage/glossary.md`，供模型翻译和润色时使用。
- 翻译时先直接翻译，再使用词库修正结果，最后进行质量检查。
- 旧版“上传整个 PDF/DOCX 词库文件”的接口仍保留以兼容历史数据，但当前前端和新翻译流程以逐条术语词库为准。

## 7. PDF 转 Word

### 7.1 当前行为

- 仅接受 PDF 文件。
- 优先通过 `pdf-parse` 提取每页文本。
- 页面文本过少时，可以将页面渲染为图片，并调用模型进行视觉识别。
- 模型负责重建 Markdown 风格的标题、列表、表格和公式结构。
- 网页预览显示 Markdown 源内容。
- 下载的 Word 文件内部也保存 Markdown 格式文本，不强行创建 Word 原生表格和样式。
- 下载文件名与原 PDF 文件名保持一致，仅将扩展名改为 `.docx`。

### 7.2 已解决问题

- 修复了下载文件使用随机任务 ID 命名的问题。
- 修复了中文文件名下载异常的问题。
- 修复了部分结果第一行出现乱码的问题。
- 取消把 Markdown 表格强行转换为 Word 表格，避免同一文档中部分表格转换、部分仍为 Markdown 的不一致情况。

### 7.3 当前限制

- 这是文本和结构级转换，不承诺复杂 PDF 的像素级版式还原。
- 扫描版 PDF 的识别效果取决于模型视觉识别能力和原始页面清晰度。

## 8. 标准解读助手

### 8.1 当前范围

以下三个标准解读助手均已启用：

- 制造一厂
- 制造二厂
- 制造三厂

每个分厂使用独立提示词，管理员可以分别修改和保存。

当前提示词状态：

- 制造一厂：用户已经在管理员页面编写并保存正式提示词。
- 制造二厂：保持系统默认提示词，等待后续修改。
- 制造三厂：保持系统默认提示词，等待后续修改。

### 8.2 牌号输入

标准解读页面提供一个必填的小输入框，提示用户输入需要解读的牌号。用户上传 Word 文档并开始解读后，后端在管理员提示词最前面加入：

```text
######
用户输入的牌号为：“TC4”
```

其中 `TC4` 会替换为用户实际输入的牌号。完整提示词的组成顺序是：

1. 牌号提示内容
2. 空行
3. 对应分厂在管理员后台保存的提示词

合并后的完整内容作为模型的系统提示词，用于文档各个分块的标准解读。

### 8.3 输入、任务与结果

- 当前接受 `.docx` Word 文档。
- 一厂、二厂、三厂使用独立任务类型，互不混淆。
- 解读过程在后台运行，前端显示任务进度。
- 结果页显示用户输入的牌号。
- 网页结果显示 Markdown 源内容。
- 下载的 Word 文件内部保存 Markdown 格式文本，不强行转换为 Word 原生排版。

## 9. 共享模型配置

知识问答使用现有知识助手接口。翻译、PDF 处理和标准解读使用项目统一的模型客户端。

当前 `.env.example` 中的模型示例：

```env
AI_MODEL_API_URL=http://172.28.200.7:7888/qwen3long/v1/chat/completions
AI_MODEL_NAME=Qwen-Lite
AI_MODEL_API_KEY=
```

模型请求会发送：

```json
{
  "chat_template_kwargs": {
    "enable_thinking": false
  }
}
```

后端还会过滤可能出现的思考字段和 `<think>` 标签。模型审计日志记录是否出现思考内容，但不记录文档正文、完整提示词、密码或 API Key。

## 10. 数据库内容

当前 SQLite 主要保存：

- `events`：访问和助手使用事件
- `feedback`：用户反馈及管理员回复
- `glossaries`：旧版文件词库记录
- `translations`：旧版翻译任务记录
- `glossary_terms`：当前逐条术语词库
- `assistant_prompts`：各标准解读助手提示词
- `document_tasks`：PDF 转 Word、Word 翻译和标准解读任务

服务启动时会自动建立所需目录和数据表。若服务重启，之前仍处于排队或处理状态的任务会被标记为失败，避免任务永久停留在处理中。

## 11. API 概览

### 11.1 基础与管理

```text
GET    /api/health
GET    /api/me
POST   /api/login
POST   /api/logout
POST   /api/visit
POST   /api/usage/:assistant
GET    /api/stats
GET    /api/feedback
POST   /api/feedback
PATCH  /api/feedback/:id/reply
```

### 11.2 当前术语和提示词管理

```text
GET    /api/glossary-terms
POST   /api/glossary-terms
PATCH  /api/glossary-terms/:id
DELETE /api/glossary-terms/:id
GET    /api/admin/prompts
PUT    /api/admin/prompts/:assistantId
GET    /api/admin/model-audit
```

这些接口需要管理员登录。

### 11.3 当前助手接口

```text
POST   /api/qa/chat/stream
POST   /api/translate/chat/stream
POST   /api/translate/document
POST   /api/pdf-to-word
POST   /api/standards/:plantId
GET    /api/document-tasks/:id
GET    /api/document-tasks/:id/download
```

### 11.4 兼容保留接口

以下接口属于较早版本，目前不是新界面的主要调用方式：

```text
GET    /api/glossaries
POST   /api/glossaries
POST   /api/qa/chat
POST   /api/translate
GET    /api/translations/:id/download
```

删除这些兼容接口前，需要先确认服务器历史数据和现有调用方不再依赖它们。

## 12. 环境变量

实际运行配置保存在 `.env`。该文件包含敏感信息，已被 Git 忽略，不应提交到 GitHub。

当前支持的主要字段：

```env
SERVER_PORT=4178
SESSION_SECRET=

ADMIN_USERNAME=
ADMIN_PASSWORD=

QA_API_BASE_URL=
QA_BOT_ID=
QA_AUTH_CLIENT_ID=
QA_AUTH_CLIENT_SECRET=
QA_DEFAULT_ACCOUNT=
QA_TLS_REJECT_UNAUTHORIZED=true

AI_MODEL_API_URL=
AI_MODEL_NAME=
AI_MODEL_API_KEY=

MOCK_AI=false
```

注意事项：

- `QA_AUTH_CLIENT_SECRET` 是知识问答接口客户端密钥，不是用户 OA 密码。
- `QA_DEFAULT_ACCOUNT` 只填写 OA 账号，可作为测试或兜底身份。
- 内网 HTTPS 证书无法通过校验时，可以使用 `QA_TLS_REJECT_UNAUTHORIZED=false`，但只应在可信内网中使用。
- `.env.example` 只提供字段和示例，真实服务器必须使用自己的 `.env`。

## 13. 本地开发与验证

### 13.1 常用命令

在 `E:\Qwen-cc\aizhushou` 中运行：

```powershell
npm install
npm run dev
```

开发模式默认地址：

- 前端：`http://localhost:5173/`
- 后端：`http://localhost:4178/`

代码检查和构建：

```powershell
npm run lint
npm run build
```

重复启动多次开发服务可能留下多个 Node/Vite 进程。若电脑明显变卡，应先关闭旧命令窗口并检查是否存在重复进程，再重新启动一套服务。

### 13.2 已做过的重点验证

- 首页访问和使用统计。
- 普通用户提交反馈，管理员回复反馈。
- 术语逐条新增、修改、删除及 Markdown 同步。
- 知识问答流式输出、思考内容过滤和引用链接。
- 翻译三个阶段的流式进度。
- Word 翻译、非 Word 文件拒绝和结果下载。
- PDF 转 Word 文件名、中文名称和 Markdown 结果。
- 标准解读牌号提示词的拼接顺序。
- 制造一厂、二厂、三厂独立任务和独立提示词。
- 桌面端和移动端布局无明显横向溢出。

## 14. Windows + Nginx 部署

### 14.1 当前发布包

- Nginx 目录：`E:\Qwen-cc\nginx-1.23.2`
- 最新发布压缩包：`E:\Qwen-cc\aizhushou-nginx-windows-20260904.zip`
- 上一版压缩包：`E:\Qwen-cc\aizhushou-nginx-windows.zip`（保留用于回退）
- 发布包内置 Node.js：`v20.19.5`
- 发布包说明：`AI_ASSISTANT_DEPLOYMENT.txt`
- 最新包功能提交：`29a7625`
- 最新包大小：约 `102.54 MB`
- 最新包 SHA-256：`9A6119905B07CBC25DB3A921D53E1024AF5D843E4E3956376B2F5C528E72BD94`

发布结构概要：

```text
nginx-1.23.2/
├─ nginx.exe
├─ conf/nginx.conf
├─ html/aizhushou/          前端构建文件
├─ app/aizhushou/           后端、依赖、配置和运行数据
│  └─ runtime/node.exe      内置 Node.js
├─ start-ai-assistant.bat
├─ stop-ai-assistant.bat
└─ restart-ai-assistant.bat
```

### 14.2 运行方式

1. 将完整 Nginx 目录复制到服务器，例如 `D:\nginx-1.23.2`。
2. 检查 `D:\nginx-1.23.2\app\aizhushou\.env`。
3. 双击 `start-ai-assistant.bat`。
4. 在服务器本机访问 `http://127.0.0.1/`。
5. 在其他内网电脑访问 `http://172.28.200.119/`。

Nginx 监听 80 端口，静态页面由 Nginx 提供；`/api` 请求反向代理到服务器本机的 `127.0.0.1:4178`。通常只需在 Windows 防火墙放行 TCP 80，不需要将 4178 暴露给其他电脑。

### 14.3 流式接口配置

Nginx 已对以下接口关闭代理缓冲：

```text
/api/qa/chat/stream
/api/translate/chat/stream
```

否则浏览器可能无法逐字或逐段收到模型结果。

### 14.4 已遇到的部署问题

#### Nginx 启动路径错误

曾出现路径被拼接成以下错误形式：

```text
D:\nginx-1.23.2" -c conf/nginx.conf/...
```

启动脚本已经调整为先进入 Nginx 目录，再使用相对路径加载配置。

#### 看到 Nginx 英文欢迎页

这通常说明正在运行旧 Nginx 进程、加载了错误配置，或静态根目录仍指向默认 `html`。当前发布包配置应指向 `html/aizhushou`。

#### 页面显示 `Unexpected token '<'`

该错误表示前端请求 API 时收到了一段 HTML，而不是 JSON。此次服务器部署中的原因是前端和 Nginx 已启动，但后端 `4178` 服务没有正常响应，Nginx 返回了 HTML 错误页。用户完成服务器操作后，已经确认当前网站能够正常访问。

### 14.5 后续升级注意事项

服务器升级前，应备份：

```text
app/aizhushou/.env
app/aizhushou/storage/
```

其中 `storage/aizhushou.sqlite` 包含反馈、统计、术语和管理员保存的标准解读提示词。直接用空白发布包覆盖服务器 `storage` 会丢失这些数据。

## 15. 关键设计决定

- 项目是可直接使用的工作台，不做营销落地页。
- 普通用户无需登录，管理员使用简单账号密码和 Session Cookie。
- 知识问答沿用现有 OA 身份和云盘知识助手能力。
- 翻译词库由管理员逐条维护，不再要求管理员上传整份词库文件。
- 翻译必须经过直接翻译、词库润色、质量检查三个阶段。
- PDF、翻译和标准解读的下载结果统一保留 Markdown 源内容，不强行转成复杂 Word 原生样式。
- PDF 转 Word 以内容和逻辑结构可用为目标，不追求复杂版式像素级复刻。
- 一厂、二厂、三厂标准解读提示词互相独立。
- 模型默认关闭思考输出，并在后端再次过滤思考内容。

## 16. 主要变更历史

| 提交 | 变更 |
| --- | --- |
| `59b9ccd` | 建立 AI 助手网页服务基础版本 |
| `45d57f8` | 适配知识问答助手 OA Token 流程 |
| `161c465` | 增加内网知识问答 TLS 证书校验开关 |
| `730a4c2` | 整理知识问答回答格式和引用链接 |
| `2b35dfb` | 知识问答改为流式输出 |
| `242bfea` | 过滤回答前的 `processing` JSON 事件 |
| `62b0425` | 首页助手入口移动到统计指标上方并重新分区 |
| `bd547ff` | 调整首页标题、反馈按钮和说明文字 |
| `7e06040` | 增加标准解读、PDF 转 Word等文档智能能力 |
| `3edb37b` | PDF 转 Word 改为在 Word 中保留 Markdown 源内容 |
| `a8a0bb0` | 翻译助手重构为问答式三阶段工作流和逐条词库 |
| `b6c4747` | 翻译对话自动定位到最新消息 |
| `20c3658` | 标准解读增加牌号输入和提示词拼接 |
| `5ea4e14` | 标准解读下载结果改为保留 Markdown 源内容 |
| `e905e3c` | 启用制造二厂、制造三厂标准解读助手 |
| `29a7625` | 管理员页面三个配置区域支持独立折叠，并默认收起 |

## 17. 已知限制与待关注事项

- 内网模型和知识问答接口只能在对应网络环境中完成最终连通性验证。
- PDF 扫描件和复杂表格的识别质量受原文件清晰度和模型能力影响。
- 当前文档任务由单个 Node.js 进程在内存中调度，服务重启不会自动续跑未完成任务。
- SQLite 适合当前单机内网部署；若后续需要多台服务器并发运行，应迁移到集中式数据库和任务队列。
- 管理员当前为单账号配置；如需多人权限、操作审计或分级管理，需要扩展用户体系。
- 兼容接口仍保留，后续清理前必须确认没有历史调用方依赖。
- 部署依赖曾提示高危依赖审计项，当前未直接执行可能引入破坏性升级的自动修复；后续升级依赖时应单独验证全部文档和流式流程。

## 18. 后续维护规则

以后每次修改项目时，至少完成以下记录：

1. 更新本文档顶部的“最后更新时间”。
2. 修改对应功能章节，使其描述与实际代码一致。
3. 在下面的“后续变更记录”追加一条记录。
4. 如果发布包已重新生成，记录发布包名称、日期和验证结果。
5. 如果涉及数据库或 `.env`，明确说明升级时是否需要迁移或新增配置。
6. 不在本文档中记录真实密码、Token、Client Secret 或其他敏感值。

## 19. 后续变更记录

### 2026-08-25 - 建立项目现状文档

- 需求：建立一份可长期阅读的项目记忆，避免长时间交流后遗漏已有功能和历史决定。
- 实现：整理当前架构、功能、接口、配置、数据、部署方式、历史变更和已知限制。
- 数据或配置影响：无。
- 验证：根据当前代码、Git 历史和最新 Windows 发布包整理。
- 功能基线：`e905e3c`。
- 部署包：本次只增加项目文档，不需要重新生成运行发布包。

### 2026-09-04 - 管理员配置区域支持折叠

- 需求：翻译术语词库、标准解读提示词、思考模式检查三个区域支持手动展开和收起，并默认收起。
- 实现：增加独立折叠状态、可点击标题栏、展开状态提示、数量摘要和旋转箭头；折叠不会清空编辑状态。
- 数据或配置影响：无，不涉及数据库和 `.env`。
- 验证：`npm run lint`、`npm run build` 通过；Edge 自动化验证桌面端三块默认收起且可独立展开，390px 移动端无横向溢出。
- Git 提交：`29a7625`。
- 部署包：已生成 `E:\Qwen-cc\aizhushou-nginx-windows-20260904.zip`；Nginx 配置检查、首页静态资源和 `/api/health` 反向代理联调通过，新包尚待部署到服务器。

### 后续记录模板

```markdown
### YYYY-MM-DD - 变更标题

- 需求：
- 实现：
- 数据或配置影响：
- 验证：
- Git 提交：
- 部署包：是否重新生成，文件名和验证结果。
```
