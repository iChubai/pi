# Pi Game Assets

面向游戏制作的可插拔模型能力包，统一图像、3D、材质加工、绑定/动作、音频、视频和可选 SSH 执行模块。只安装 `game-assets`，各后端独立启停。主模型按任务、权限和预算选择能力，不替换 Pi 的聊天模型、默认工具或本地工程。

## 当前接入范围

| 能力 | 后端 | 实际接入方式 |
| --- | --- | --- |
| 图像生成、编辑、参考图、图标、贴图候选 | 已有 Codex image 工具；Google Gemini / BFL FLUX 等 Pi 已登记图像模型 | `image-assets` 技能复用现有工具和 `models.generateImages`，后者目前经 OpenRouter。没有重复实现图像客户端。 |
| 文本/单图/多图生成 3D | Meshy | 原生 `pi.registerMcpServer` 注册官方 MCP，保留其工具与参数。 |
| 减面、重建拓扑、重贴图、转换 | Meshy | 使用官方 remesh/retexture/convert 等工具。 |
| 人形绑定、动作 | Meshy | 官方 rig/animate；动作目录不等于自由文本生成任意骨骼动作。 |
| 配音 | ElevenLabs | 原生 TTS REST 接口，支持声音、模型、语速/风格、上下文衔接等参数。已有 hosted MCP 的 TTS 也可直接复用。 |
| 音效、环境声 | ElevenLabs | 原生 sound-generation REST 接口，保留时长、循环和提示影响参数。 |
| 配乐 | ElevenLabs | 原生 music REST 接口，保留 prompt/分段计划、模型、时长、instrumental、finetune 和 source IDs。 |
| 视频 | MiniMax H3、LTX-2.5 | 内置 [视频技能](docs/video.md)：H3 复用官方 CLI；LTX 本地直接用原生 CLI，远端使用薄适配器。 |
| 本地 GPU 推理 | 用户已有模型环境 | 直接使用现有 Bash、Python、模型 CLI 或已有服务，不增加执行层。 |
| SSH GPU 推理 | 用户已有远端模型/适配器 | 内置 [remote-assets 技能](docs/remote.md)，补充后台执行、同 ID 恢复和文件取回。 |

Qwen-Image、TRELLIS.2、Hunyuan3D、HY-Motion 仍是候选，**此包未实现它们的真实适配器**。OpenAI 公共 Images API、Google/BFL 直连 REST 也没有新增客户端；Codex 订阅入口与 OpenRouter 不能被写成这些账户已经接通。其他视频厂家仍为备选。

## 安装与独立启用

从本仓库根目录：

```sh
pi install --local ./packages/coding-agent/examples/extensions/game-assets
```

重载后可用：

- `/skill:game-assets`：按游戏目标选择、组合能力。
- `/skill:image-assets`：复用已有图像接口。
- `/skill:meshy-assets`：3D、材质、绑定和动作。
- `/skill:elevenlabs-audio`：配音、音效、配乐。
- `/skill:minimax-video`：H3 视频。
- `/skill:ltx-video`：本地或 SSH LTX 视频。
- `/skill:remote-assets`：SSH 执行与取回。

包内结构：

```text
game-assets/
├── package.json             # 唯一安装清单
├── extensions/meshy.ts       # 可选官方 MCP 注册
├── skills/
│   ├── game-assets/
│   ├── image-assets/
│   ├── meshy-assets/
│   ├── elevenlabs-audio/
│   ├── minimax-video/
│   ├── ltx-video/
│   └── remote-assets/
├── examples/                # 各后端请求与 SSH 配置
└── docs/                    # 视频与 SSH 详细说明
```

安装不准备模型环境，也不启用 GPU 或付费生成。只在选择某个后端时准备它需要的环境和凭据。

`pi config --local` 可分别禁用技能和 `extensions/meshy.ts`。例如只启用音频，在仓库根的 `.pi/settings.json` 中保留其他声明，将此包改为：

```json
{
  "packages": [
    {
      "source": "../packages/coding-agent/examples/extensions/game-assets",
      "extensions": [],
      "skills": ["skills/elevenlabs-audio/SKILL.md"]
    }
  ]
}
```

`source` 相对设置文件，资源过滤路径相对包根目录。所有技能统一使用 `skills/技能名/SKILL.md`，例如 `skills/minimax-video/SKILL.md`、`skills/ltx-video/SKILL.md`、`skills/remote-assets/SKILL.md`。`skills: []` 和 `extensions: []` 可禁用整个包的资源，省略某项则加载该类全部资源。

禁用 Meshy 技能不等于关闭 MCP；同时禁用其 extension 才会去掉该注册。已有 `.pi/mcp.json` 的 Meshy 连接由原配置管理，本包不改写它。

```sh
pi remove --local ./packages/coding-agent/examples/extensions/game-assets
```

项目安装遵循 Pi 的信任规则；非交互安装需要时，审阅项目/包后给该次命令加 `--approve`。移除不删资产、不注销第三方账户，也不取消已经提交的服务端任务。

## 本地与远端推理

**本地 GPU 推理直接用现有工具。** 在用户已有环境中，用 Bash 调模型原生 CLI/Python 或已有服务，保留其设备、精度、参考输入、质量和输出参数。无需 SSH profile、runner、上传缓存或新的本地推理工具；例如 LTX 直接运行官方 `python -m ltx_pipelines.distilled`。说明见 [LTX 本地推理](docs/video.md#本地推理)。

只有选定请求需要去独立 SSH 机器时才用 [remote-assets](docs/remote.md)。它处理断连后运行、任务恢复、资源锁和传输，不接管本地工程，也不自动把本地失败切换到远端。

## 图像：复用而非再封装

`image-assets` 不修改已有 `codex-image.ts`，也不注册同名工具。Codex 图像工具需要用户已有的 extension 与 `/login openai-codex`，使用 ChatGPT 订阅权限；不是 OpenAI 公共 API key。

Pi 的图像模型通过 codemode 发现：

```js
text((await models.getAvailableOfType("image")).map(({ provider, id }) => ({ provider, id })));
```

选定实际可用且获准的 model ID 后调用 `models.generateImages`。Google/BFL 的这些目录项使用 OpenRouter 凭据。codemode 未启用时，向已有 `defaultTools` 增补 `+codemode`，不要替换整个工具列表。生成、参考输入、显示与保存示例见 [image-assets](skills/image-assets/SKILL.md)。

## Meshy：官方 MCP

只有用户设置 `MESHY_MCP_COMMAND` 时，extension 才注册服务器。该变量是**一个可执行文件路径**，不是 shell 命令；注册时不执行安装、探测余额或生成。

用户审阅后，单独准备官方服务端，例如：

```sh
npm install --global --ignore-scripts @meshy-ai/meshy-mcp-server@0.6.1
export MESHY_MCP_COMMAND=/absolute/path/to/meshy-mcp-server
```

通过用户的环境/秘密管理方式提供 `MESHY_API_KEY`。不要把实际 key 写在命令示例、共享配置或对话中。extension 的 `env` 只保存 Pi 原生 `${MESHY_API_KEY}` 引用。重载后在会话内用 `/mcp` 查看连接；shell `pi mcp list` 不加载 extension 注册。

若已有 Meshy MCP，禁用本包的 `extensions/meshy.ts`，只加载技能。所有生成参数和返回结构沿用官方工具 schema；先通过 `searchTools` / `describeTool` 查看，避免在此包里维护第二套参数定义。

提交后先保存 task ID/type，再调用官方 `meshy_get_task_status` 的 `wait: true` 模式。程序负责最多 300 秒的等待，本包将 MCP 请求超时设为 360 秒；长任务沿用 ID 再查询，不重新创建。选择需要的 GLB/FBX 等格式下载到工程，再由 Blender/引擎处理。详见 [meshy-assets](skills/meshy-assets/SKILL.md)。

## ElevenLabs：原生音频 API

需要 POSIX、Python 3.9+，无额外 Python 依赖。`ELEVENLABS_API_KEY` 只从当前进程环境读取，发送到明确选择的官方 HTTPS 区域；不会保存到请求、日志或 argv。区域为 `global`（默认）、`us`、`eu`、`in`、`sg`，必须与用户账户相符。

脚本路径相对本包根目录：

```sh
python3 skills/elevenlabs-audio/scripts/audio.py catalog models
python3 skills/elevenlabs-audio/scripts/audio.py catalog voices
python3 skills/elevenlabs-audio/scripts/audio.py --timeout 300 generate \
  --request examples/eleven-sound-effects.json --job /absolute/project/.game-assets/door-sound-01
python3 skills/elevenlabs-audio/scripts/audio.py status --job /absolute/project/.game-assets/door-sound-01
```

三个请求示例：

- [eleven-tts.json](examples/eleven-tts.json)：替换获准使用的 voice ID，选择明确的 model ID。
- [eleven-sound-effects.json](examples/eleven-sound-effects.json)：事件音效；环境声可按模型能力使用 `loop`。
- [eleven-music.json](examples/eleven-music.json)：明确时长的纯音乐；复杂结构可改用对应模型的原生 `composition_plan`。

JSON 顶层为 `operation`、TTS 所需的 `voice_id`、原生 `query` 和 `body`。`body.model_id` 必须显式指定；不改名、压缩或重新解释音频原生参数。脚本检查顶层字段，嵌套声音设置/配乐计划交给对应 API 验证。不同 music 模型的计划格式不同；prompt 模式不能使用计划模式的 seed。

`generate` 同步等待并写文件。每次使用新的 job 目录；已有目录不会再次 POST。目录里保留请求收据、响应 ID/头信息和音频；完整读取、核对可用字节数后才发布文件，没有内容哈希扫描。脚本不自动混音、转格式或把原始 PCM 伪装成 WAV。

### 音频恢复

`status` 仅读本地记录。`running` 表示本地调用仍持有锁；失去调用进程且没有完整文件时报告 `unknown`，不是“没有生成/没有扣费”。发生超时、断连或 Ctrl-C 不会自动重发生成请求，也不声称已取消提供方工作。

TTS 若保留了服务端历史，可复用响应中的 history-item ID：

```sh
python3 skills/elevenlabs-audio/scripts/audio.py recover --job JOB
```

若没有该 ID，先用 `catalog history --query FILE` 或提供方 UI 确认原始记录，再显式指定：

```sh
python3 skills/elevenlabs-audio/scripts/audio.py recover --job JOB --history-id CONFIRMED_ORIGINAL_ID
```

恢复仅使用 GET，不选择“最新一条”，也不重新配音。完成后的本地文件保持原样。zero-retention TTS 没有此历史恢复能力；音效和配乐未接入恢复 API，失败时保留 request/song ID 供提供方查询，不自动再生成。

标准输出为 JSON。退出 0 表示命令成功；1 为命令/配置/网络错误；2 为本地查询到失败或未知状态。

## 使用边界

- 安装接口不等于生成授权。本次实现不安装第三方模型/服务端，不调用付费服务，不占用 GPU。真实账户、模型/GPU 兼容性和制作质量仍需授权实测。
- 官方 Meshy 客户端有内部重试，包括部分 POST；本包没有改写它，不能承诺只创建/收费一次。不要再叠加自动创建重试，也不要把 SSH runner 的同 ID 保护套到商业 API。
- Meshy 取消排队任务、停止执行中任务和删除产物有不同语义；Rig/Animation 的无列表端点限制也影响丢失 ID 后的恢复。及时下载，不依赖服务端永久保留。
- ElevenLabs hosted MCP 现在明确提供 TTS，但文档未列出音效/配乐；此包使用 REST 覆盖三种音频，不启用其 agent 管理权限。旧本地 MCP 已废弃，不安装它。
- 接口支持不保证有模型额度、声音/素材使用权或商业授权。视频不等于骨骼动画，网格不等于碰撞体，音频文件不等于游戏事件系统。最终通过引擎导入、实际播放和交互确认可用性。
- 技能与 extension 不是沙箱。图像、Meshy、音频、视频各自可替换，不添加统一生成协议、资产数据库或新的调度服务。

## Pi 包集成测试

```sh
cd packages/coding-agent
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/game-assets-package.test.ts
```

仓库级 Pi 测试验证单包安装/移除、信任、全部技能发现、独立过滤和 MCP 注册，不连接 Meshy 或调用模型，不证明真实账户、GPU 兼容性或生成质量。

官方接口依据：[Pi MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)、[Meshy MCP](https://github.com/meshy-dev/meshy-mcp-server)、[ElevenLabs TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)、[音效](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert)、[配乐](https://elevenlabs.io/docs/api-reference/music/compose)、[历史音频](https://elevenlabs.io/docs/api-reference/history/get-audio)、[hosted MCP](https://elevenlabs.io/docs/agents-platform/operate/hosted-mcp)。
