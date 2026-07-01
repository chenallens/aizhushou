# AI助手网页服务

内置“制造一厂知识问答AI助手”和“翻译助手”的本地/内网 Web 服务。

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
   - `TRANSLATION_API_URL`：默认已填内网 Qwen3-VL 接口。
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

## 当前文档处理边界

第一版支持 PDF 与 DOCX。DOCX 会尽量保留可解析的段落、表格 HTML 结构用于页面对照；PDF 按文本提取后生成 Word，不保证复杂版式像素级一致。.doc 文件请先另存为 .docx 后上传。
