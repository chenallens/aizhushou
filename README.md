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

如果从 OA 入口访问，URL 需要携带示例接口中的 `code` 参数：

```text
http://localhost:5173/?code=base64后的OA账号
```

系统会把 `code` 解码成 OA 账号，后端再用该账号换取知识问答助手的 `access_token`。

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

## 新增助手

- PDF 转 Word：逐页提取 PDF 文本；文本过少时自动将该页渲染为图片交给模型识别，完成后生成可下载的 DOCX。
- 标准解读（一厂）：读取 DOCX 文档，依据管理员维护的提示词分段解读并生成 DOCX。
- 标准解读（二厂）和（三厂）：当前保留入口与独立提示词配置，功能将在一厂版本验证后开放。
- 管理员页面可编辑三个标准解读提示词，并检查最近模型响应是否包含 reasoning 字段或 `<think>` 标签。

共享模型的每次请求都会发送：

```json
"chat_template_kwargs": { "enable_thinking": false }
```

## 当前文档处理边界

DOCX 会尽量保留可解析的段落与表格结构。PDF 转 Word 会恢复标题、列表、表格和公式文本，但不承诺与原 PDF 像素级一致；低质量扫描件中无法确认的字符可能标记为“无法辨认”。`.doc` 文件请先另存为 `.docx` 后上传。
