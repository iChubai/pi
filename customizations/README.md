# 个人 Pi 定制

将扩展源码与安装配置保存在仓库中，凭据只保存在本机用户目录。

包含：

- `langfuse-enhanced/`：基于官方 `@langfuse/pi-observability-plugin@0.1.2` 的 MIT fork，保留完整模型输入/输出、实际返回的 thinking、工具调用、会话与子代理关联、用量、时序和媒体，并在导出副本上脱敏。
- `pi-mcp-adapter@5.2.0`：通过官方 Pi package 安装机制加载，关闭 Pi 内置 MCP，避免两套实现重复运行。
- 官方 `github.com/langfuse/skills`：固定到 commit `b86532b77f16f1e27c7cffa32bb632aa3cd9a352`。
- [Codex image](../packages/coding-agent/examples/extensions/codex-image.ts)：使用 `/login openai-codex` 的订阅凭据生成和编辑原始 PNG，支持本地/会话参考图和透明背景；不需要 OpenRouter 或 API key。
- [game-assets](../packages/coding-agent/examples/extensions/game-assets/README.md)：七个 skill，组合已有图像接口、Meshy 3D/动画、ElevenLabs 音频、MiniMax H3、LTX-2.5 和可选 SSH 执行/取回。只提供已实现的适配器；候选开源模型不是已经接通的服务。
- [Trace Studio](../packages/coding-agent/examples/extensions/trace-viewer/README.md)：本地只读会话、模型调用和统计查看器，仅监听 `127.0.0.1`。旧 `npm:pi-trace-viewer` 扩展会被禁用。
- `SoL-Pi`：固定到 commit `03529c710269d3e3336a033cead49a95189987f1`；新配置只启用 Observation Pack，其余三个机制关闭。
- `@narumitw/pi-usage@0.65.0`：订阅用量和可选 Codex Fast 模式。
- Codex 官方目录：按账户实时同步模型默认/最大上下文、输入模态、推理档位（含官方支持的 `ultra`）与默认档位；保留离线回退和用户覆盖，不把所有模型统一设成 872k。
- 核心修复：将上游 request-buffer 溢出识别为输入大小错误，避免原样重试，让会话走有次数上限的压缩恢复；包含回归测试。

不包含 API 密钥、登录状态、历史会话、真实 trace 数据、生成资产或模型发现缓存。MCP 适配器不等于已经配置图像/视频服务：服务需要自行选择并配置。

## 换机安装

需要 Node **22.23.3 或更高版本**、npm、Git，以及已安装并加入 PATH 的 Pi；扩展已验证 Pi **1.1.0**。不需要编译这个 monorepo，也不需要运行仓库根目录的 `npm install`。

```bash
git clone https://github.com/iChubai/pi.git
cd pi
node customizations/setup.mjs
```

安装脚本会：

1. 备份已有 `~/.pi/agent/settings.json`，备份权限为 `0600`。
2. 使用 `npm ci --ignore-scripts --legacy-peer-deps` 安装 Langfuse 和 Trace Studio 的锁定依赖；不安装另一份 Pi runtime。
3. 安装固定版本/commit 的 MCP、Langfuse skill、SoL-Pi 和用量扩展，并通过 npm 环境变量禁止安装生命周期脚本。
4. 加载仓库中的 Codex image、game-assets 和 Trace Studio。保留其他用户设置与 package，只替换这份 profile 管理的声明；迁移旧的本地包路径，禁用已有官方 Langfuse/旧 trace-viewer 扩展但不移除包。Codex 全局配置与仓库自动发现共用同一 wrapper 路径，避免重复注册。
5. 在用户目录创建权限为 `0600` 的 `langfuse.json`、`mcp.json` 和 `sol-pi.json` 模板；**不覆盖已有配置内容**。新 settings 默认使用 `openai-codex/gpt-6.1-sol` 并折叠 thinking；已有设置优先。

默认适用于 macOS/Linux。Windows 可从 npm script 环境运行，使 `npm_execpath` 可用，并用 `PI_BIN` 指定可执行的 Pi CLI。`PI_CODING_AGENT_DIR` 可指定其他用户配置目录；`PI_BIN` 可指定其他 Pi 可执行文件。

本地扩展路径由安装脚本按当前 checkout 生成，不在仓库中写入机器绝对路径。**保留这个 checkout**；移动目录后重跑脚本更新路径。修改源代码后重启 Pi。脚本可以重跑，但请不要同时运行多个安装器或修改用户 settings。

### Pi 核心修复与扩展的区别

`setup.mjs` 只安装扩展，不会替换已安装 Pi 的核心代码。普通发布版 Pi 能加载这些扩展，但只有运行本 fork 的源码或自己构建的版本才包含 request-buffer 溢出修复和 Codex 官方目录刷新。源码开发需要安装根目录依赖，并按仓库的 [开发说明](../README.md#development) 准备模型数据；随后可用 `./pi-test.sh` 启动本 fork。不要把 `setup.mjs` 的成功当成核心修复已经生效。

### Codex 官方模型目录

本 fork 用已登录账户的 OpenAI Codex 目录覆盖静态元数据，避免较旧的 pi.dev 缓存把窗口改回 272k。`pi update --models` 可强制刷新；只请求元数据，不进行模型生成。按账户隔离缓存，每五分钟可重新校验，离线使用本机缓存或仓库回退。

2026-10-12 查询结果：`gpt-6.1-sol` 默认 500k、最大 872k；其余已列出的 GPT-6/GPT-5.6 模型默认 272k、最大 872k；`gpt-5.5` 默认及最大都是 272k。最大窗口只是元数据，不会自动启用。价格和输出 token 限制不来自该官方接口，不据此改写。模型默认推理档位只在没有用户设置时使用。

这部分需要运行本 fork 的核心；`setup.mjs` 不会给已安装 Pi 1.1.0 自动加上新目录和 `ultra` 支持。源码启动方式见上面的核心说明。

### Codex、素材服务与本地查看器

在新机器重新运行 `/login openai-codex`；登录状态不会随仓库迁移。如果默认模型在账号中不可用，用 `/model` 选择可用模型。Codex image 使用订阅图像权限和额度，不会自动回退到付费 API。更多参数见 [模型说明](../packages/coding-agent/docs/models.md#codex-subscription-image-generation)。

素材包不包含 Python 模型环境、CUDA、模型权重或 Meshy/ElevenLabs/MiniMax 的密钥。按 [game-assets README](../packages/coding-agent/examples/extensions/game-assets/README.md) 配置所需服务与依赖；SSH 主机、远端环境和本机私密配置需另外设置。

运行 `/trace-view` 打开 Trace Studio，`/trace-view on` 启用详细采集。本地 `.pi-traces/` 可能包含敏感上下文，已被 git 忽略，不应上传。运行 `/usage` 查看支持的订阅用量；`/fast` 默认关闭，开启后可能消耗更多额度。

SoL-Pi 的模板只启用 Observation Pack，不启动额外的摘要模型调用。已有 `sol-pi.json` 保持原样；配置与机制说明见 [上游文档](https://github.com/NVlabs/SoL-Pi/blob/03529c710269d3e3336a033cead49a95189987f1/docs/configuration.md)。

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

运行 Trace Studio 的回归测试或仓库完整测试前，另需 `npm ci --prefix packages/coding-agent/examples/extensions/trace-viewer --ignore-scripts --legacy-peer-deps`；根目录 workspace 安装不会安装这个独立示例包的依赖。两份 CI workflow 均包含该步骤。素材、Codex 和核心回归测试使用合成请求，不消耗模型或素材服务额度。

回退时，在 `~/.pi/agent/settings.json` 删除这份 checkout 的 `langfuse-enhanced` package 声明，再重新启用已有官方 plugin；若未安装官方包，可使用 `pi install npm:@langfuse/pi-observability-plugin@0.1.2`。不要同时启用两份 tracing 扩展。完整 settings 备份可作参考，但整份恢复会覆盖安装后的其他设置修改。
