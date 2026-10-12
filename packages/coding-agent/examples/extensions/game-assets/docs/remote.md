# SSH 资产执行

`game-assets` 包内的 `remote-assets` 技能：通过已配置的 SSH 开发机生成资产，再取回本地。模型、文件工具和本地工程保持原样，只有选定的生成请求走远端。本地 GPU 推理直接用现有 Bash、Python、模型原生 CLI 或已有服务，不需要本技能。

支持多主机/profile、后台运行、同 ID 恢复、按资源串行、取消、预览取回和断点下载。运行脚本仅使用 Python 标准库。

## 启用

随 [game-assets](../README.md#安装与独立启用) 一次安装，重载后使用 `/skill:remote-assets`，不再单独安装执行包。通过 `pi config --local` 可独立禁用本技能。

本地与远端需要 POSIX（Linux/macOS）、Python 3.9+；远程连接使用已有 OpenSSH 配置。安装只加载技能。禁用/移除保留生成文件和远端作业；正在执行的任务使用 `cancel ID` 单独处理。

## 登记模型

复制包根目录的 `examples/remote-config.example.json` 到项目外配置或忽略的 `config.local.json`，替换占位值。配置中的 `hosts` 描述机器，`profiles` 描述已有模型的运行方式；编辑配置就是登记。

| 字段 | 用途 |
| --- | --- |
| `hosts.*.target` | 已配置的 SSH 别名。 |
| `hosts.*.root` / `python` | 远端作业目录和基础 runner 的 Python。 |
| `command` | 适配器 argv。Python 适配器的 `command[0]` 指向模型环境的解释器，可与 runner 环境不同。 |
| `cwd` | 可选的绝对工作目录；默认使用本次运行目录。 |
| `code` | 源码文件/目录的绝对 `path`，以及可选的 `revision` 版本标签。 |
| `weights` | 具名 ckpt，如 `shape`、`texture`；每项含绝对 `path` 和独立 `revision`。支持文件、目录和模型缓存符号链接。无权重时可省略。 |
| `python_modules` | 可选的顶层模块名，如 `torch`、`PIL`。显式环境检查时使用；非 Python 启动命令省略。 |
| `model` / `revision` | 模型名称与部署配置版本。 |
| `tasks` / `env` | 支持的任务和非秘密环境变量；生成参数放在请求的 `parameters`。 |
| `resource` | 该机器上的资源锁名称，例如 `gpu-0`。 |
| `cancel` / `max_seconds` | 取消方式与运行期限。 |

代码和权重路径均指所选主机。适配器读取 `profile.weights[名称].path`；安装模型、下载 ckpt 和环境准备沿用用户已有流程。适配器接口见 [adapter-contract.md](../skills/remote-assets/references/adapter-contract.md)。

同一设备的 profiles 使用同一主机目录和 `resource`。例如 NVIDIA 设备可通过 `env.CUDA_VISIBLE_DEVICES` 指定。每次请求使用明确选定的 profile。

## 使用流程

脚本路径相对 game-assets 包根目录；`CONFIG` 为用户配置文件：

```sh
python3 skills/remote-assets/scripts/assets.py --config CONFIG profiles
python3 skills/remote-assets/scripts/assets.py --config CONFIG setup --host desktop-a
python3 skills/remote-assets/scripts/assets.py --config CONFIG validate --profile image3d-4090
python3 skills/remote-assets/scripts/assets.py --config CONFIG submit --profile image3d-4090 --request request.json
```

- `profiles` 本地列出配置。
- `setup` 在获准的远端目录部署版本化 runner，并显示基础环境信息。更新前让该目录下已有任务完成，再执行 `setup`。
- `validate` 在首次接入或配置变化后显式运行：检查路径、可执行文件和所列 Python 模块是否可找到。一次 SSH 往返，报告写入 `state_dir/checks/PROFILE.json`，保留最近一次结果。
- `submit` 直接使用配置。代码/权重版本是登记标签；环境检查不读取其内容、不要求 Git 工作区干净。普通生成不自动重验。

获得生成 ID 后：

```sh
python3 skills/remote-assets/scripts/assets.py --config CONFIG wait ID --seconds 60
python3 skills/remote-assets/scripts/assets.py --config CONFIG fetch ID --previews
python3 skills/remote-assets/scripts/assets.py --config CONFIG fetch ID
```

`wait` 由程序等待，期间可继续开发本地工程。`fetch` 复用已知完成结果和本地文件；取回的文件位于 `state_dir/runs/ID/files/`。若需重新下载已有本地文件，先将该文件移走。

输入参考包根目录的 `examples/remote-request.example.json`，路径相对请求文件。输入复制为快照时只计算一次内容摘要，用于复用远端输入、跳过重复上传。传输依靠 SSH，收发端按字节数确认传输完成，再发布文件；不对产物执行哈希扫描。

`state_dir` 相对配置文件。标准输出为 JSON；错误和等待中的状态变化写入标准错误。退出码：0 成功，1 命令/配置/传输错误，2 检查未通过或任务失败、取消、未知、未找到、等待到期。

## 恢复与取消

```sh
python3 skills/remote-assets/scripts/assets.py --config CONFIG list
python3 skills/remote-assets/scripts/assets.py --config CONFIG status ID
python3 skills/remote-assets/scripts/assets.py --config CONFIG resume ID
python3 skills/remote-assets/scripts/assets.py --config CONFIG logs ID
python3 skills/remote-assets/scripts/assets.py --config CONFIG cancel ID
```

提交前记录 ID、目标机器、配置、输入和 runner 版本。断连后沿用该 ID 查询或恢复；`resume` 不盲目重跑已开始的生成。执行记录存在但进程归属不明时返回 `unknown`，由操作者查看日志和远端状态。

下载中断后再次 `fetch` 会继续传输，完整写入后才发布。已有本地文件保持原样。

`cancel` 为支持 `process-group` 的适配器请求取消，随后查询状态确认。停止 SSH 或本地 `wait` 只停止连接/等待。`cancel: none` 的期限是软期限，底层工作继续被跟踪。

`doctor --host NAME` 可单独查看基础系统信息。SSH 连接复用可通过用户已有的 OpenSSH 配置启用。

## 当前边界

- 本技能提供通用执行通道，所选 profile 必须指向实际模型适配器。LTX 的模型适配器位于 `skills/ltx-video/scripts/ltx_adapter.py`。真实模型、GPU 和小规模推理需要指定环境、设备及预算；路径/模块检查不证明推理兼容性或资产质量。
- 代码和权重版本由用户登记，运行收据保留配置。需要实验复现时，由部署流程固定代码、环境和权重。
- 资源锁只协调本包在同一主机目录中的任务，不占有其他程序的 GPU。远端重启或进程被系统清理可能留下未知状态。
- 脚本与适配器使用 OS 用户权限，不是沙箱。SSH 主机密钥与认证由用户配置；凭据不放入 `env`、请求或日志。
- 模型安装、自动换机、模型常驻、商业服务接入和引擎导入不由本执行技能处理。资产可用性由实际导入、视觉和行为检查判断。
