# 个人 Pi 定制

将扩展源码与安装配置保存在仓库中，凭据只保存在本机用户目录。

包含：

- `langfuse-enhanced/`：基于官方 `@langfuse/pi-observability-plugin@0.1.2` 的 MIT fork，保留完整模型输入/输出、实际返回的 thinking、工具调用、会话与子代理关联、用量、时序和媒体，并在导出副本上脱敏。
- `pi-mcp-adapter@5.2.0`：通过官方 Pi package 安装机制加载，关闭 Pi 内置 MCP，避免两套实现重复运行。
- 官方 `github.com/langfuse/skills`：固定到 commit `b86532b77f16f1e27c7cffa32bb632aa3cd9a352`。

不包含 API 密钥、登录状态、历史会话、真实 trace 数据或其他本机扩展。MCP 适配器不等于已经配置图像/视频服务：服务需要自行选择并配置。

## 换机安装

需要 Node **22.23.3 或更高版本**、npm、Git，以及已安装并加入 PATH 的 Pi；扩展已验证 Pi **1.1.0**。不需要编译这个 monorepo，也不需要运行仓库根目录的 `npm install`。

```bash
git clone https://github.com/iChubai/pi.git
cd pi
node customizations/setup.mjs
```

安装脚本会：

1. 备份已有 `~/.pi/agent/settings.json`，备份权限为 `0600`。
2. 使用 `npm ci --ignore-scripts --legacy-peer-deps` 安装 Langfuse 扩展的锁定依赖；不安装另一份 Pi runtime。
3. 安装固定版本的 MCP 适配器和固定 commit 的官方 Langfuse skill，并通过 npm 环境变量禁止安装生命周期脚本。
4. 保留其他用户设置与 package，只替换这份 profile 管理的声明。旧的增强扩展路径被迁移；已有官方 Langfuse plugin 的扩展被禁用但包不移除，避免重复 tracing。
5. 在用户目录创建权限为 `0600` 的空 `langfuse.json` 和 `mcp.json` 模板；**不覆盖已有配置内容**。

默认适用于 macOS/Linux。Windows 可从 npm script 环境运行，使 `npm_execpath` 可用，并用 `PI_BIN` 指定可执行的 Pi CLI。`PI_CODING_AGENT_DIR` 可指定其他用户配置目录；`PI_BIN` 可指定其他 Pi 可执行文件。

本地扩展路径由安装脚本按当前 checkout 生成，不在仓库中写入机器绝对路径。**保留这个 checkout**；移动目录后重跑脚本更新路径。修改源代码后重启 Pi。脚本可以重跑，但请不要同时运行多个安装器或修改用户 settings。

### Langfuse

在 `~/.pi/agent/langfuse.json` 填入自己的 Public Key / Secret Key，默认 endpoint 为 `https://us.cloud.langfuse.com`。只编辑本机文件，不要修改或提交模板中的空 key。

完成后重启 Pi，并创建**新会话**。全量上下文 tracing 可能包括继续使用的旧会话历史。打开 Langfuse 项目中的 `LLM Call → Input/Output`；provider 实际返回的 thinking 存在 `reasoning_content` 中，隐藏推理无法恢复。

如果密钥曾被粘贴到聊天或公开位置，应先轮换再填入新密钥。安装脚本不会迁移其他机器的凭据。Windows 的文件访问限制需要另外使用用户 ACL，不能只依赖 POSIX `0600`。

### MCP 服务

在 `~/.pi/agent/mcp.json` 配置服务；模板的 `mcpServers` 默认是空对象，不会启动外部服务。服务凭据留在用户配置或环境变量中。图像/视频服务可能产生费用，配置前先核对权限和计费。

配置格式与服务选项参见 [pi-mcp-adapter 文档](https://github.com/nicobailon/pi-mcp-adapter)。

## 隐私与控制

脱敏是启发式规则，不保证识别所有秘密、姓名或保密内容。图片、音频、文档中的个人信息**不会自动匿名化**；上传到 Langfuse 的二进制内容应由你自行确认，并设置合适的访问权限与保留期限。

- `LANGFUSE_TRACING_ENABLED=false`：关闭 tracing。
- `LANGFUSE_MEDIA_UPLOAD_ENABLED=false`：不上传内联媒体。
- `PI_LANGFUSE_MASK_PII=false`：只关闭 PII 脱敏，凭据脱敏仍启用。
- `PI_LANGFUSE_MAX_CHARS`：限制根节点和摘要的预览，**不截断 generation/tool 的完整输入输出**；传输层仍可能有限制。

更多实现与限制见 [Langfuse 扩展说明](langfuse-enhanced/README.md)。本地 fork 不会自动合并上游更新；MCP/skill 升级需要修改 `profile.json` 并重新安装。

## 验证与回退

以下测试使用合成数据，不调用模型或 Langfuse。独立的 GitHub Actions workflow 同时检查格式与 TypeScript 类型；开发时可在安装仓库根目录和扩展依赖后运行 `npm run check:customizations`。类型检查会在缺少模型元数据时下载仓库已固定并校验 SHA-256 的公开 catalog，只写入被 git 忽略的数据目录，不编译 Pi 或调用模型：

```bash
node --test customizations/setup.test.mjs
node --test customizations/langfuse-enhanced/test/trace-data.test.ts
```

回退时，在 `~/.pi/agent/settings.json` 删除这份 checkout 的 `langfuse-enhanced` package 声明，再重新启用已有官方 plugin；若未安装官方包，可使用 `pi install npm:@langfuse/pi-observability-plugin@0.1.2`。不要同时启用两份 tracing 扩展。完整 settings 备份可作参考，但整份恢复会覆盖安装后的其他设置修改。
