# AI助手网页服务

内置“制造一厂知识问答AI助手”和“翻译助手”的本地/内网 Web 服务。

## 本地启动

1. 复制配置文件：

   ```powershell
   Copy-Item .env.example .env
   ```

2. 修改 `.env`：

   - `ADMIN_USERNAME` / `ADMIN_PASSWORD`：管理员账号密码。
   - `QA_API_BASE_URL`：知识问答助手接口的主机地址，不要包含末尾接口路径。
   - `QA_API_TOKEN`：如问答接口需要鉴权则填写。
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
