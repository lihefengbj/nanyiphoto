# 10 模型 PoC 准入与测量记录

日期：2026-10-17。准备工具已实现，不是模型已接入、真实基准已运行或画质已通过的报告。
本文件描述 Node 准备 / 汇总工具；后续新增的 Python ONNX 适配器与实际离线执行见 [11](./11-ONNX推理与离线评测.md)，
两者职责分开，默认草稿和正式人像 / 权重 / 画质门禁不变。

## 1. 当前状态

用户确认基础页面、导出实验室和新增导出约束复测通过。
本机 Python 3.14.5 基础后端兼容验证已完成；真实模型权重、至少 50 张获授权测试图、
代码 / 权重 / 依赖许可记录和目标实例材料尚未提供。

工具位于 `scripts/model-poc.mjs`，只依赖 Node 内置模块。
`config/model-poc.example.json` 的三个候选条目全部禁用且清单为 `draft`，
不填假权重 / 许可来源、不安装假抠图 Provider，不自动通过照片审核。

## 2. 命令与边界

```bash
# 结构检查：允许草稿存在，列出准备缺口；默认不访问材料路径。
node scripts/model-poc.mjs --check
# 材料核验：默认草稿应返回 materialsReady:false，退出码 1。
node scripts/model-poc.mjs --verify
# 真实清单、测量记录均由实际测试提供；工具不执行推理。
node scripts/model-poc.mjs --summarize .data/model-poc.json .data/model-measurements.json
```

有 npm 的环境也可执行 `npm run poc:check` 和 `npm run poc:verify`。
`--check` 的退出码 0 只表示结构有效，即使仍有 blockers；CI 使用这个模式以保留禁用草稿。
`--verify` 仅在结构、准备字段、文件和权重检查均通过时返回 `materialsReady:true`。
参数 / JSON / 结构错误退出码为 2；材料未就绪退出码为 1。

`materialsReady:true` 不是模型可服务或完整 PoC 放行。
报告始终明确 `inferenceExecuted:false`、`imageDecodeValidated:false`、`runtimeValidated:false` 和 `productionEnabled:false`。
工具不读取照片内容或计算照片哈希；只核验图片文件可访问、非空、预算与唯一文件引用。
没有图片解码 / 方向 / 像素真实性验证，也没有模型运行库、权重格式、Provider 输出、画质或云端验证。

## 3. 准入清单

按示例结构创建真实清单，材料留在被 Git 忽略的 `.data` 中：

- `status=ready`；测试图为 50–500 个唯一 ordinal ID，例如 `sample-001`，文件名只接受对应格式的 `sample-NNN.png/jpg/jpeg`。
- 数据集授权和每张图同意确认；授权核验者、日期及证据位置齐全。
- 标签覆盖直发、卷发、碎发、眼镜、不同衣着、逆光、纯色 / 复杂背景。
- 每个启用模型的代码、权重、依赖人工许可核验分别完成；来源为不含凭证 / 查询参数的 HTTPS，版本与权重 SHA-256 齐全。
- 数据文件解析后必须在工作区 `.data` 内，图片不得借助路径 / 符号链接越出数据集根目录；重复路径和硬链接不能凑满样本数。
- 权重按流读取并校验完整 SHA-256，不将大文件全部读入内存；大小预算有上限。
- P0 并发固定 1，内 / 外部线程数 1–64，预热 / 重复次数 1–20。
- `run.pythonVersion` 记录实际 `3.14.x` 补丁版本；当前本机 / CI 验证基线为 `.python-version` 中的 3.14.5。允许同 minor 记录，不代表各补丁 / 模型依赖均已验证。

核验字段只是人的确认与证据引用，工具不判断许可证实际义务，也不替代人工用途 / 许可审核。
照片内容重复、覆盖标签是否真实与来源是否适用于实际权重仍需要人工和后续解码基准验证。
本次不会自动复制照片、下载权重、安装模型库或执行清单中的来源 / 外部命令。

## 4. 提交测量记录

汇总输入 schemaVersion 为 1，`run` 的 Python 版本、并发、线程、预热及重复次数与清单完全一致；
每个启用模型必须有且仅有一份测量记录，版本及权重哈希与清单匹配。

每个模型记录：

- `modelId / version / weightsSha256`。
- `coldStartMs`；`warmupMs` 数组，长度等于预热次数。
- `peakRssBytes` 和 `memoryMethod`（`process_rusage` 或 `sampled_process_rss`）。
- `measurements` 覆盖每张图的每次重复，不允许重复、遗漏或仅提交成功样本。
- 每条记录有 `sampleId / repetition / status`。成功记录还要有 `resultValidated:true`、`inferenceMs / processingMs`，本地处理时间不小于推理时间。
- 失败只接受固定错误码：`MODEL_FAILED / INVALID_MODEL_RESULT / INVALID_FOREGROUND_ALPHA / INPUT_CHANGED / MODEL_RESULT_TOO_LARGE / TIMEOUT`。

`processingMs` 是本地测试流程时间，不是包含上传 / 审核 / 下载的用户端到端耗时。
`process_rusage` 为进程峰值口径，`sampled_process_rss` 为采样口径；不可混称相同真实峰值，也不能填估计值当测量。

汇总采用 nearest-rank P50/P95；成功延迟与失败率 / 错误码数量分开，全失败时分位数为 `null` 而非伪造 0。
仅输出白名单聚合字段，不输出图片、样本路径 / ID、照片哈希、来源 URL、完整权重哈希或原始异常。
报告标注 `inferenceExecutedByTool:false` 和 `qualityApproval:false`：它汇总提交的数据，不证明测量数据来源或画质已通过。
当前 CLI 无写文件选项；安全聚合 JSON 输出在控制台，需要保存时由用户选择本地私有位置。

## 5. 实际验证与下一步

2026-10-17 Node.js 24.18.1 下全部 154 项测试通过。
PoC 工具新增 38 项测试，Python 基线一致性增加 2 项；之前导出 / 日志 / 规格测试全部保留。
覆盖草稿门禁、授权 / 标签 / 许可记录、权重哈希、文件预算、路径与硬链接、时间 / 内存口径、
遗漏 / 重复测量、失败率、输出白名单及 CLI 固定错误码。

Python 3.14.5 / macOS x86_64 下原后端锁定依赖无需升级，63 项后端测试及实际 API 冒烟通过。
没有安装 PyTorch / ONNX Runtime，没有下载权重，没有进行真实模型或目标实例推理；详见 docs/07 第 8 节。
CI 已更新固定 3.14.5 和 PoC 草稿结构检查，尚未远程执行。

后续实现已增加 FP32 RVM / MODNet Provider、共用资产验证与实际离线入口，本机参考测试图通过；
新增的可选依赖、隔离执行 / 白红蓝 A/B、实际验证边界详见 docs/11。
下一步仍需获授权人像、正式权重 / 许可来源及哈希，在目标实例运行真实成品 A/B、线程 / P50/P95 / 内存评测。
本地准备和汇总通过不启用草稿规格，不解除审核 / 云资源 / 生产门禁。
