# 11 ONNX 推理与离线评测

日期：2026-10-17。本批实现可加载本地权重的推理适配器和实际执行图的离线入口。
已验证生成的算术 ONNX 测试图，不是获授权人像 / 正式权重的画质或部署性能验收。

## 1. 已实现范围

代码：

- `backend/nanyiphoto_api/onnx_provider.py`：FP32 MODNet / RVM、本地权重哈希、图与张量契约检查。
- `backend/nanyiphoto_api/model_evaluation.py`：复用 docs/10 的授权 / 许可 / 文件准入，逐模型独立进程执行、测量、可选私有成品输出。
- `backend/nanyiphoto_api/providers.py`：服务与评测共用输出验证；PNG RGBA 的 A 必须全为 255，独立 alpha 为 PNG L。
- `backend/requirements-model.lock`：独立可选锁文件，不改基础后端依赖包版本。
- `.github/workflows/ci.yml`：增加可选依赖安装、CPUExecutionProvider 必须可用的断言；Linux 上测试参考执行与 ORT 两个后端，尚未远程执行。

没有下载权重、生成默认假抠图 Provider、自动批准审核或启用草稿规格。
`TaskService` 只接受显式注入；默认应用仍未配置模型及正式审核，readiness 为 false。
低层 Provider 构造不是许可审核工具，调用者必须先核验代码、权重、依赖；离线入口强制执行清单门禁。
PP-HumanSegV2 的真实导出契约仍未提供，入口明确拒绝，不猜测归一化或输出语义。

## 2. Python 3.14.5 / 本机依赖

本机为 macOS 13.2、x86_64、Python 3.14.5。仅修改项目 `.venv`：

```bash
.venv/bin/python -m pip install --only-binary=:all: \
  --cache-dir .wheelhouse/pip-cache -r backend/requirements-model.lock
.venv/bin/python -m pip check
.venv/bin/python -c "import numpy, onnx; from onnx.reference import ReferenceEvaluator; print(numpy.__version__, onnx.__version__)"
```

锁定 NumPy 2.5.4、ONNX 1.20.0、ml_dtypes 0.6.0、protobuf 7.36.2、typing_extensions 4.16.0；
Linux 的额外 ONNX Runtime 固定 1.28.0。基础 `requirements.lock` 的包版本不变。

实际发现的兼容限制：

- 本机 Python 3.14 / macOS x86_64 查询不到 ONNX Runtime 可安装分发；Linux x86_64 同版本 Python 有轮子。
- ONNX 1.23.2 轮子能安装但在本机加载失败：缺少 C++ `to_chars` 符号，加载器提示构建面向 macOS 13.3，而本机为 13.2。
- 改为 ONNX 1.20.0 后实际加载及参考执行通过。安装成功不能单独证明运行兼容。

`ort-cpu` 不会自动降级：运行库缺失报告 `MODEL_RUNTIME_UNAVAILABLE`。
本机需显式选择 `onnx-reference`。参考后端实际执行 ONNX 图，但不保证支持所有正式模型算子，
也不能把它的延迟 / 内存当成 ORT 或目标部署实例的测量。其他系统 / 架构尚未本机验证。
本批未安装 PyTorch，未构建源码轮子，未修改全局 Python 或证书配置。

## 3. 权重与张量约定

核对依据为 MODNet 官方仓库 `onnx/inference_onnx.py` 和 RobustVideoMatting 官方仓库
`documentation/inference.md` 的 ONNX 约定；不是对实际提交权重的许可或格式背书。

| 适配器 | 输入 | 输出 / 边界 |
| --- | --- | --- |
| MODNet | 单个 FP32 NCHW RGB 输入，归一化到 -1～1；固定空间需为 32 的倍数，或按 512 参考尺寸并向下取 32 的倍数 | 单个 `[1,1,H,W]` alpha；恢复源图尺寸；前景是原图 RGB，标注 `source_rgb`，没有颜色恢复 |
| RVM | `src` FP32 `[1,3,H,W]` RGB 0～1；`r1i`～`r4i` 每张图独立零值 `[1,1,1,1]`；`downsample_ratio` FP32 `[1]` | `fgr/pha/r1o/r2o/r3o/r4o` 契约；使用预测 fgr / pha，标注 `model_rgb`；不跨照片复用状态 |

RVM ratio 为 `min(1, 512/max(width,height))`。FP16、未知输入名 / 布局、其他精度和未确认导出明确拒绝。
MODNet 目前使用 Pillow bilinear 缩放 RGB / alpha，不声称与官方 OpenCV float INTER_AREA 逐像素等价；
正式模型比较必须记录该预处理差异并验证画质。

加载后只允许内嵌、自包含 ONNX 和内置算子；嵌套图 / 函数中的外置张量同样拒绝。
权重读取限 512 MiB（即使材料清单允许更大），哈希与创建会话使用同一份字节，避免再次按路径加载。
输入与输出各受清单 bytes 预算限制，归一化输入最多 4 Mi 像素，模型空间最大边 2048、最多 4 Mi 像素。
张量必须 FP32、有限值、精确空间 / 通道；0～1 只容许 1e-4 数值误差后裁到边界，NaN / Inf / 越界失败。
每次推理返回实际编码且验证过的独立 PNG 资产，不使用恒定全不透明遮罩冒充模型结果。

## 4. 运行实际离线评测

先按 docs/10 准备 `.data/model-poc.json`、50–500 张获授权图、场景覆盖及代码 / 权重 / 依赖人工核验。
路径相对清单位置解析，均须位于工作区私有 `.data`，不得以符号链接越出。
清单须记录实际 Python 补丁版本；入口要求与正在运行的解释器完全一致。
至少第一张样本须能解码且推理成功，以完成真实预热；预热失败整次运行拒绝，不编造时长。

```bash
# 本机参考执行：默认不保存照片 / 成品文件
.venv/bin/python -m nanyiphoto_api.model_evaluation \
  --manifest .data/model-poc.json --engine onnx-reference

# 显式保存私有白 / 红 / 蓝 A/B 文件
.venv/bin/python -m nanyiphoto_api.model_evaluation \
  --manifest .data/model-poc.json --engine onnx-reference --artifacts --timeout 300

# 已安装 CPU 运行库的 Linux 环境：必须单独验证正式权重 / 目标实例
.venv/bin/python -m nanyiphoto_api.model_evaluation \
  --manifest .data/model-poc.json --engine ort-cpu --artifacts --timeout 300
```

默认示例仍是禁用草稿：无需模型库即可到达门禁，返回固定 `MATERIAL_REVIEW_INCOMPLETE`、退出码 1；
不会读取照片或创建运行目录。成功退出码 0；错误只有固定码，不输出参数中的私有路径或原始异常。
当前入口依赖 Node 24 调用已有材料核验 / 汇总规则；没有 Node 时拒绝，不绕过门禁。

每个模型一个 spawn 子进程，按清单线程数执行；参考后端只接受 1/1，
在子进程启动前把 NumPy 相关计算线程环境限制为 1，并在结束后恢复父进程环境。
超时默认每模型 300 秒，可指定 1～3600 秒；超时或初始化 / 预热失败只终止本次拥有的进程，
回收本次运行目录，不伪造完整测量。后续样本失败逐条记录，不能仅汇总成功样本。
照片摘要只在已授权运行内部用于检查样本替换，不写报告、不输出。

## 5. 产物、测量与清理

成功后输出 ordinal `runId` 及安全聚合，产物在：

```text
.data/poc-runs/run-随机目录/
  measurements.json
  summary.json
  modnet/ 或 rvm/
    measurements.json
    sample-001/                  # 仅 --artifacts
      source.png
      foreground.png
      alpha.png
      source-white/red/blue.png
      model-white/red/blue.png
```

运行 / 样本目录权限 0700，文件 0600；属于本机私有权限保护，不是照片加密或云权限方案。
默认只保存测量 JSON，不保存照片。`--artifacts` 的照片 / 成品总预算为 256 MiB，
按模型均分；超限 / 写失败拒绝整次运行并删除其唯一目录，不覆写既有目录或用户样本。
成功产物为人工评测而保留，不自动删除；评测结束后由用户主动清理对应 run 目录。
这不是生产照片保留或审核授权策略，不能公开挂载 `.data`。

测量定义：

- `coldStartMs`：该子进程内 Provider 的依赖导入、权重读取 / 哈希 / 图检查、会话创建；不包含子进程启动及材料准入。
- `warmupMs / inferenceMs`：仅实际 `session.run` 区间；包含该运行库自身调度，不包含 RGB / PNG 处理。
- `processingMs`：每条样本文件读取、归一化、预处理、推理、输出编码 / 验证；不包含上传 / 审核 / 下载，也不包含可选 A/B 保存。
- 成功条目记录源图归一化尺寸和模型尺寸；聚合保存尺寸分组及数量，不含样本 ID。
- `runtime` 记录后端与实际 NumPy / ONNX / ORT 版本、前景语义、平台和架构；参考后端不混作 ORT。
- `peakRssBytes`：独立子进程 `ru_maxrss`，macOS 为 bytes、Linux 从 KiB 转换；包含解释器、初始化、预热和可选产物处理。

成功原始报告兼容已有 `node scripts/model-poc.mjs --summarize`；
JS 汇总仍声明 `inferenceExecutedByTool:false`，表示汇总器本身没有推理；
Python 执行入口成功声明 `inferenceExecuted:true`。两者均不批准画质或启用生产。
P50/P95 采用 nearest-rank，仅统计成功延迟，失败率与固定码另列。

## 6. 本批验证与下一步

2026-10-17 本机完整 Python 127 项、Node 158 项，共 285 项通过；
Ruff / 格式、`pip check`、小程序静态检查与实际 API 冒烟通过。新增 Python 64 项、Node 4 项。
测试图是临时生成的简单算术图与彩色 PNG，无人物、无正式权重，不充当 50 张人像 PoC 的效果证据。
测试覆盖真实参考图执行、RGB 归一化、RVM 独立状态、方向归一化基础复用、
输出形状 / 精度 / 非有限值、外置权重、许可门禁、实际隔离评测、失败率、私有 A/B、文件预算和超时进程回收。
实际图注入服务后，审核 pending 不放行、非 owner 不读资产、取消后回收素材的集成测试通过。

下一步：补齐正式权重 / 许可、获授权人像及目标 Linux 实例，执行真实 RVM / MODNet 成品 A/B；
PP-HumanSegV2 按实际导出再适配；比较前景污染 / 发丝与输入缩放差异、记录实例配置和 ORT 性能。
正式审核、身份 / COS / 共享存储和上线验收门禁均保留；不把生成图测试或本机参考执行当成完整 P0 放行。
