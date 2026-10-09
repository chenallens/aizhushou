# AI助手网页服务

面向制造内网的 AI 助手服务台，包含知识问答、文档翻译、PDF 转 Word 和标准解读功能。

## 本地启动

1. 复制配置文件：

   ```powershell
   Copy-Item .env.example .env
   ```

2. 修改 `.env`：

   - `ADMIN_USERNAME` / `ADMIN_PASSWORD`：管理员账号密码。
   - `QA_API_BASE_URL`：知识问答助手平台主机地址，例如 `https://pan.wst.com:443`。
   - `QA_BOT_ID`：制造一厂知识问答助手 bot id，默认已填需求文档中的 id。
   - `QA_AUTH_CLIENT_ID` / `QA_AUTH_CLIENT_SECRET`：调用 `/api/authentication/v1/access_token` 所需的 Basic Auth 信息。
   - `QA_DEFAULT_ACCOUNT`：可选，仅用于不是从 OA 入口访问时的本地测试账号。
   - `QA_TLS_REJECT_UNAUTHORIZED=false`：仅当内网知识问答平台证书不被 Node.js 信任时用于测试。
   - `RAGFLOW_CHAT_URL`：制造四厂 RAGFlow 共享聊天的完整地址，包含认证参数，只写入 `.env`，不要提交到 GitHub。
   - `AI_MODEL_API_URL`：翻译、PDF 转 Word和标准解读共用的内网模型接口。
   - `AI_MODEL_NAME`：模型名称，当前为 `Qwen-Lite`。
   - `AI_MODEL_API_KEY`：模型接口 Bearer 密钥。
   - 外网调试界面时可临时设置 `MOCK_AI=true`。

3. 启动开发服务：

   ```powershell
   npm run dev
   ```

4. 浏览器打开：

   ```text
   http://localhost:5173
   ```

## 人员、登录与权限

1. 在 `.env` 中配置生产人事接口：`MDM_API_BASE_URL`、`MDM_CLIENT_ID`、`MDM_CLIENT_SECRET`。真实凭据只保存在 `.env`，不提交版本管理。
2. 使用原 `admin` 账号和服务器配置的管理员密码登录，进入“权限中心 → 用户管理”，点击“同步人员与部门”。首次同步需在内网进行。
3. 同步后员工使用工号登录。工号与 OA 账号一致，新账号初始密码统一为 `123456`，首次登录必须修改密码。
4. 在“角色管理”中为员工分配超级管理员、翻译术语库管理员或一厂、二厂、三厂提示词管理员。一个人可拥有多个角色。
5. 用户列表、角色成员和统计只展示“制造一厂”等一级部门，不展示车间等下级组织或在职状态。

每周一北京时间 04:00 自动同步；首次成功同步后才启用自动同步。同步保留已有密码和角色。缺工号或人员编号的记录单独隔离，一致重复合并，姓名为空时保留旧姓名或用工号显示；用户管理提供异常明细。含隔离记录时不自动停用原账户或部门。网络失败、分页不完整或全部人员不可用时保留原数据。诊断写入 `storage/logs/mdm-sync.log`。

普通员工登录后可以使用助手和提交反馈。首页、统计和反馈列表可公开浏览，反馈默认收起、最新优先、每页 3 条，仅超级管理员可以回复。

月度、年度统计默认显示当前周期，并支持历史查询；每月 1 日、每年 1 月 1 日北京时间 04:00 归档上一周期，服务启动后补做遗漏归档。使用次数按点击助手入口计数，部门归属记录为使用发生时的一级部门。旧记录保留为“历史未归属”。

员工使用一厂知识问答时，后端直接使用其已登录账号获取知识助手 Token。系统管理员可继续使用 `.env` 的 `QA_DEFAULT_ACCOUNT` 或原 OA 入口的 `code` 参数测试：

```text
http://localhost:5173/?code=base64后的OA账号
```

此参数只用于系统管理员的一厂问答身份，不作为本平台登录凭据。正式单点登录认证待提供 SSO 配置后接入。

## 内网服务器部署

```powershell
npm install
npm run build
npm start
```

生产模式默认访问：

```text
http://服务器IP:4178
```

## 文件与数据

- SQLite 数据库：`storage/aizhushou.sqlite`
- 上传文件：`storage/uploads`
- 词库文件：`storage/glossaries`
- PDF 转换与中间文件：`storage/converted`
- 翻译结果 Word：`storage/results`
- 模型思考模式审计：`storage/logs/model-audit.log`
- 人员、部门、用户角色、登录会话、同步记录与统计归档均保存于 `storage/aizhushou.sqlite`。
- 首次账户升级前自动备份旧数据库：`storage/backups/`。
- 新文档任务按用户隔离，超级管理员可查看旧版本未记录所属用户的结果。

## 新增助手

- 制造一厂知识问答：继续使用 OA 身份和云盘知识问答接口，支持流式回答及原文引用。
- 制造四厂知识问答：通过已确认的 `chats_openai` 接口在平台内流式回答，保留“在 RAGFlow 中打开”备用入口。
- PDF 转 Word：逐页提取 PDF 文本；文本过少时自动将该页渲染为图片交给模型识别，最终将统一的 Markdown 源文本写入可下载的 DOCX。
- 标准解读（一厂）：读取 DOCX 文档，依据管理员维护的提示词分段解读并生成 DOCX。
- 标准解读（二厂）和（三厂）：与一厂使用相同处理流程，并分别使用独立提示词配置。
- 管理员页面可编辑三个标准解读提示词，并检查最近模型响应是否包含 reasoning 字段或 `<think>` 标签。

共享模型的每次请求都会发送：

```json
"chat_template_kwargs": { "enable_thinking": false }
```

## 当前文档处理边界

DOCX 会尽量保留可解析的段落与表格结构。PDF 转 Word 的下载结果保留 Markdown 标题、列表、管道表格和公式源文本，不再强制转换为 Word 原生表格；低质量扫描件中无法确认的字符可能标记为“无法辨认”。`.doc` 文件请先另存为 `.docx` 后上传。

## 验证

```powershell
npm test
npm run lint
npm run build
```

自动测试使用隔离数据库与本地模拟人事接口，覆盖分页同步、失败保留、首次改密、角色权限、调动归属、统计归档和公开反馈分页，不会改写正式运行数据。
