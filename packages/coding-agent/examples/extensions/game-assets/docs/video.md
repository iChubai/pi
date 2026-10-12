# 视频资产

`game-assets` 包内的两个独立技能。不修改 Pi 核心、聊天模型或默认工具，不安装模型，不注册新的调度服务。

| 技能 | 后端 | 运行方式 |
| --- | --- | --- |
| `minimax-video` | MiniMax H3 | 复用官方 `mmx` CLI；保存任务 ID，程序等待并下载 MP4。 |
| `ltx-video` | LTX-2.5 | 本地直接调用官方 CLI；SSH 推理可用内置 remote-assets 技能与薄适配器。 |

两者没有互相依赖。主模型按任务和授权预算选择后端，不自动换模型、降低质量或切换 GPU。

## 启用

随 [game-assets](../README.md#安装与独立启用) 一次安装，使用 `/skill:minimax-video` 或 `/skill:ltx-video`。无需额外 Pi 包。

用 `pi config --local` 分别启用/禁用技能。也可以将 `.pi/settings.json` 中此包的声明改为只启用一个技能，例如只启用 H3：

```json
{
  "packages": [
    {
      "source": "../packages/coding-agent/examples/extensions/game-assets",
      "extensions": [],
      "skills": ["skills/minimax-video/SKILL.md"]
    }
  ]
}
```

示例 source 相对仓库根的 `.pi/settings.json`；资源路径相对 game-assets 包根目录。保留其他配置和包声明。禁用/移除不停止正在执行的任务，也不删除文件。技能不是 OS 权限边界。后端准备步骤仅在选用该后端时进行。

## MiniMax H3

本地需要 POSIX、Python 3.9+，以及独立安装的官方 `mmx-cli`。接口依据 `mmx-cli` **1.0.27** 核查；本包不携带该依赖，也不自动安装或升级它。需要安装时，由用户审阅后单独执行：

```sh
npm install --global --ignore-scripts mmx-cli@1.0.27
mmx auth login
mmx auth status --output json --quiet
```

H3 使用 **Pay-as-you-go/Credit API key**，不能把 Token Plan/OAuth 的聊天权限当作视频额度。用户在自己的终端交互登录；不要把 key 放入命令参数、请求、Pi 对话或 profile.env。脚本使用 `mmx` 保存的凭据并关闭 verbose HTTP 日志，不读取或回显 key。

以下命令路径相对 game-assets 包根目录：

```sh
python3 skills/minimax-video/scripts/h3.py submit \
  --request examples/h3-request.json --job /absolute/project/.video-assets/shot-01 \
  --region global
python3 skills/minimax-video/scripts/h3.py wait \
  --job /absolute/project/.video-assets/shot-01 --seconds 600
python3 skills/minimax-video/scripts/h3.py fetch \
  --job /absolute/project/.video-assets/shot-01
```

`--region cn` 使用 `api.minimaxi.com`；默认 `global` 使用 `api.minimax.io`。区域和 CLI 可执行路径冻结在收据中。`submit --mmx /path/to/mmx` 可选择已安装的 CLI。每条命令可在子命令前加 `--timeout 60` 设置单次网络/CLI 超时。

请求 JSON 的字段对应 **mmx CLI 选项**，不是 H3 REST 请求体：`prompt`、`duration`、`ratio`、`image`、`last-frame`、`reference-image`、`reference-video`、`reference-audio`、`callback-url`。三个 reference 字段支持字符串数组。文件路径相对请求文件；支持官方 CLI 接受的 URL/`mm_file://` 引用。未知字段报错，不默默丢弃。

该 CLI 版本的 H3 入口使用 **2K**；尚不提供新版 API 的 768P、H3-Max 和全部 REST 参数。不能将 `resolution` 写入请求却声称已生效。首/尾帧使用 `adaptive` 比例，不能与 reference 输入混用；详细约束由官方 CLI/API 检查。参考素材仍须满足提供方许可与上传要求。

### H3 恢复

每次提交使用一个**新的 job 目录**。提交意图先写入 `receipt.json`，返回的 ID 写入 `task.json`；同目录不会再次创建付费任务。

```sh
python3 skills/minimax-video/scripts/h3.py status --job JOB
python3 skills/minimax-video/scripts/h3.py wait --job JOB --seconds 600
python3 skills/minimax-video/scripts/h3.py fetch --job JOB
```

- 提交断连且没有 ID 时返回未知状态。先在提供方任务历史中确认原任务；确实找到后，显式 `attach --job JOB --task-id ID`。不会根据“最近任务”自动认领，也不会自动重提。
- `wait` 到期或 Ctrl-C 只停止本地等待，不取消付费任务。服务端任务独立运行。
- 完成状态与已有 `video.mp4` 直接复用；`status --refresh` 可显式更新。中断下载再次 `fetch` 从头下载同一产物，不重新生成。写入完成并核对可用的字节数后才发布；没有内容哈希扫描。
- 下载链接过期时尝试刷新同一任务的 URL。官方查询窗口为最近 7 天；及时取回资产，不把服务端存储当作素材库。
- 本包不封装删除/取消 API；需要取消时在提供方确认状态后操作。`mmx video download --file-id` 是 V1 文件下载，不用于 H3 的 V2 URL。

标准输出为 JSON。退出 0 表示命令成功（`submit` 成功不代表视频已完成）；1 为命令/配置/传输错误；2 为任务失败、取消、过期、未知或等待到期。

## LTX-2.5

只使用 H3 时无需准备此后端。由用户准备官方源码、模型环境、兼容权重与授权设备。原生入口包括 `distilled`、`keyframe_interpolation`、`retake`，不是强制串联的流水线。

### 本地推理

直接用现有 Bash 工具调用模型环境的官方 CLI，不使用 SSH profile、runner 或适配器请求协议。以下为已准备环境的 distilled 示例；替换路径与获准的 NVIDIA 设备索引后才能执行：

```sh
cd /absolute/LTX-2
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 CUDA_VISIBLE_DEVICES=SELECTED_GPU \
  /absolute/ltx-env/bin/python -m ltx_pipelines.distilled \
  --transformer-path /absolute/weights/distilled-transformer.safetensors \
  --text-encoder-path /absolute/weights/text-encoder.safetensors \
  --video-vae-path /absolute/weights/video-vae.safetensors \
  --audio-vae-path /absolute/weights/audio-vae.safetensors \
  --spatial-upsampler-path /absolute/weights/spatial-upsampler.safetensors \
  --prompt "A locked camera watches a portal slowly brighten." \
  --seed 42 --height 512 --width 768 --num-frames 121 --frame-rate 24 \
  --output-path /absolute/project/art/portal-candidate.mp4
```

参考图直接传原生 `--image /absolute/first.png 0 1.0`。关键帧、retake、精度、offload 等沿用所选版本的官方参数，不静默改设备或降低质量。这里没有承诺任意 GPU 都兼容，也没有新建本地推理工具。保存命令、输出路径和耗时，用现有进程/日志工具观察执行；本地失败不自动转到 SSH 或商业服务。

### SSH 推理

仅在选择远端设备时使用包内 [remote-assets](remote.md)。将 `skills/ltx-video/scripts/ltx_adapter.py` 放入获准的远端路径，复制包根目录的 `examples/ltx-config.example.json` 并替换占位值。不要把基础 runner 的 Python 当作模型解释器。

profile 中：

- `command` 指定模型 Python、适配器绝对路径和 `--pipeline`。
- 支持 `distilled`、`keyframe_interpolation`、`retake` 三个官方入口；它们是可选择的能力，不是强制串联的流水线。
- `weights` 登记独立的 `transformer`、`text_encoder`、`video_vae`、`audio_vae`。新视频流程另需 `spatial_upsampler`；关键帧插值另需 `distilled_lora`。
- `distilled`/当前 `retake` CLI 使用 **distilled transformer**；关键帧插值使用 **dev transformer + 对应 distilled LoRA**。各自建 profile，不只改一个 pipeline 名字就复用不匹配权重。
- 可选 `prompt_enhancer` 登记额外的 Gemma 生成模型目录，仅在明确使用提示增强时准备。额外 LoRA 用其他具名权重登记，再在请求中引用。
- 普通生成不安装依赖，不下载权重；模型子进程启用 Hugging Face/Transformers 离线模式。缺少依赖或本地文件直接失败。

LTX 源码接口依据官方仓库 `9ec55f9f22798a3198d9c923856824821bc3317e` 核查。版本标签只描述登记，不能证明部署内容。具体设备、原生库与模型的兼容性须用获准的小规模推理验证。

使用 `/skill:remote-assets` 提供的 `assets.py`，以下路径相对 game-assets 包根目录：

```sh
python3 skills/remote-assets/scripts/assets.py --config CONFIG validate --profile ltx-distilled
python3 skills/remote-assets/scripts/assets.py --config CONFIG submit --profile ltx-distilled --request examples/ltx-request.json
python3 skills/remote-assets/scripts/assets.py --config CONFIG wait ID --seconds 600
python3 skills/remote-assets/scripts/assets.py --config CONFIG fetch ID
```

新主机/runner 更新还需按 remote-assets 文档显式执行 `setup`；先让已有任务结束。恢复、资源锁、取消和断点传输由该技能处理，视频适配器不重复实现。

LTX 请求保留原生 CLI 选项。每组是 `["--option", value, ...]`；`{"input":"first.png"}` 引用上传输入，`{"weight":"style"}` 引用已登记 LoRA。选项按所选流程校验；主权重与输出位置由适配器绑定，不能在请求中覆盖。详见 [LTX 远端适配器参数](../skills/ltx-video/references/parameters.md)。本地直接调用原生 CLI 时无需这种 JSON 表达。

## 使用视频

最终文件是 MP4，不是可控角色的骨骼动画，也不保证透明背景、无缝循环或引擎可用。按需要用现有 FFmpeg/引擎工具裁切、抽帧、处理声音、导入和播放，再根据实际镜头反馈修正。H3 和 LTX 的文件可以作为下一次请求的参考，但不要自动把一个模型的原生参数套给另一个。

官方资料：[MiniMax CLI](https://github.com/MiniMax-AI/cli)、[H3 V2 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)、[查询与保留窗口](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)、[LTX 源码](https://github.com/Lightricks/LTX-2)、[LTX 流程](https://github.com/Lightricks/LTX-2/blob/main/packages/ltx-pipelines/docs/pipelines.md)。
