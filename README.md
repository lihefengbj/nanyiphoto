# 南一证件照

原生微信小程序 + FastAPI 单服务。当前版本 `v0.2.0-rc.2`：M0 工程、本地契约、
P0 精确导出和真实 MODNet 私有换背景实验室；这是开发测试版，不是可上线的证件照服务。

## 已实现的范围

- 小程序：首页、禁用规格详情、本地裁剪 / 精确像素导出验证页、隐私授权组件；JPEG / PNG、整数 bytes 范围、有界 JPEG 质量搜索与失败禁存。
- 导出文件：应用私有中间文件的替换 / 失败 / 退出清理、失败重试及下次导出前保留命名空间遗留清扫；不建立历史相册。
- 本地 API：私有上传、防覆盖与归属校验、版本化规格 / ETag、幂等任务、有限队列、审核 / 推理双状态、受鉴权素材访问、取消 / 过期清理。
- 模型接口与 worker 步骤：新增本地 FP32 RVM / MODNet ONNX 适配器，保持显式注入及审核门禁，不安装默认假抠图。
- 后端结构化日志 / 请求标识、小程序有界调试日志；不记录照片与访问凭证。
- Node / Python 单元测试、静态检查与 CI 配置。
- 模型 PoC：授权 / 场景 / 许可及权重 SHA-256 准入、实际离线图执行与测量、可选私有白 / 红 / 蓝 A/B；不下载权重、不自动批准画质。
- 私有真机换背景实验室：受鉴权真实模型任务、透明前景、白 / 蓝 / 红本地换底、原图对比、构图与精确导出；默认关闭，明确未接正式审核，不放开生产任务门禁。

2026-10-17 用户确认现有页面与基础导出实验室开发者工具 / 真机测试通过。
随后确认新增导出约束复测通过；设备 / 实际文件证据与完整 DPI / 方向矩阵仍待补录。
真实官方 MODNet 权重已下载核验，本机参考后端与私有人像 HTTP 链路已验证。
用户确认处理进度条真机通过，并提供新版蓝底结果：脸侧 / 肩线浅边略有减轻，
发丝 / 鬓角仍需优化；截图不替代相册原始文件、完整设备矩阵或最终画质验收。
本次发布批次 Node 214 项 + Python 241 项 = 455 项通过，Ruff、依赖检查与实际 API 冒烟通过；
`v0.2.0-rc.2` 的分支 / 标签远程 CI 均已成功，Linux ORT CPU、测试和构建产物上传通过，
Release 已附后端 wheel、小程序源码 ZIP 与校验和；详见 [发布记录](docs/13-发布记录.md)。
CI 固定 Python 3.14.5 / Node 24，检查真实 Linux ORT CPU provider，支持推送 / PR / 手动触发，
检查通过后构建后端 wheel、小程序源码 ZIP 与 SHA-256 校验和，保留 14 天。
正式 `mediaCheckAsync`、COS / 云数据库与目标实例 PoC 仍待完成；生产配置保持禁用。

## 本地开发

当前验证基线为 `.node-version` 的 Node.js 24.18.1 和 `.python-version` 的 Python 3.14.5。
项目声明 `>=3.14,<3.15`，Ruff target 为 `py314`；其他 3.14 补丁版本可作为独立验证目标，但不是已逐一测试的版本。
以下命令在仓库根目录执行，使用项目虚拟环境，不修改全局 Python / pip。

macOS / Linux：

```bash
python3 --version
python3 -m venv .venv
.venv/bin/python -m pip install --cache-dir .wheelhouse/pip-cache -r backend/requirements.lock
.venv/bin/python -m pip install --cache-dir .wheelhouse/pip-cache --no-deps --no-build-isolation -e backend
.venv/bin/python -m pip check
node scripts/sync-specs.mjs
node scripts/validate-specs.mjs
node scripts/check-miniprogram.mjs
node --test scripts/*.test.mjs
.venv/bin/python -m pytest backend/tests
.venv/bin/python -m ruff check backend
.venv/bin/python -m ruff format --check backend
node scripts/model-poc.mjs --check
node scripts/smoke-api.mjs
```

创建前核对 `python3 --version` 是否为 3.14.5。Windows / PowerShell 使用安装的 3.14 解释器，
同样核对补丁版本：

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.lock
.\.venv\Scripts\python.exe -m pip install --no-deps --no-build-isolation -e backend
npm run miniprogram:sync
npm run check
npm test
.\.venv\Scripts\python.exe -m pytest backend/tests
.\.venv\Scripts\python.exe -m ruff check backend
.\.venv\Scripts\python.exe -m pip check
npm run poc:check
npm run smoke:api
```

`requirements.lock` 的包版本在此次 3.14.5 迁移中保持不变，已在本机独立虚拟环境重新验证。
它包含开发 / 测试依赖，不作为尚未建立的生产镜像依赖方案。不关闭证书校验或改动全局缓存权限。

### 启动 API

复制 `.env.example`为被 Git 忽略的 `.env`，设置一个随机的 `NP_DEV_TOKEN`。这只是本地开发身份，不是微信登录、API Key 或真实用户标识，不要使用账号密码。开发环境仅监听回环地址：

macOS / Linux：

```bash
.venv/bin/python -m uvicorn nanyiphoto_api.main:app --env-file .env --host 127.0.0.1 --port 8000 --no-access-log
```

Windows / PowerShell：

```powershell
.\.venv\Scripts\python.exe -m uvicorn nanyiphoto_api.main:app --env-file .env --host 127.0.0.1 --port 8000 --no-access-log
```

- `/health/live`：进程运行时返回 200。
- `/health/ready`：未接模型与审核时返回 503，符合预期。
- `/api/specs`：携带本地 Bearer 令牌；当前草稿目录返回空可用列表。
- `/api/callbacks/moderation`：返回 503，不能用任意 JSON 请求批准照片。
- `.data/`包含本地任务数据库与临时对象，不入 Git。不要将开发服务直接暴露到公网。

### 测试日志

后端默认输出 JSON 行到控制台和 `.data/logs/api.jsonl`，单文件 1 MiB、保留 3 个备份。
每次请求的 `X-Request-ID` 与日志 `requestId` 对应；后台任务用脱敏 `taskRef` / `uploadRef` 关联。
使用 `--no-access-log` 关闭 Uvicorn 原生访问日志，避免其额外输出原始 URL / 查询参数。

```powershell
Get-Content .data/logs/api.jsonl -Tail 50
```

小程序日志默认关闭。测试时将 `miniprogram/config.js` 中 `diagnostics.enabled` 改为 `true` 并重新编译，
或在开发者工具控制台临时开启：

```javascript
getApp().diagnostics.configure({ enabled: true, level: "INFO", maxEntries: 100 })
getApp().diagnostics.snapshot()
getApp().diagnostics.clear()
getApp().diagnostics.configure({ enabled: false })
```

小程序日志只进入调试控制台和有界内存，不自动上传或持久化。网络异常提供安全的
`requestId` / `statusCode` 方便关联；未知服务端错误文本归一为 `API_FAILED`。
测试结束关闭调试日志。配置、脱敏边界与排查示例见 [日志与问题定位](docs/08-日志与问题定位.md)。

### 打开小程序

微信开发者工具导入仓库根目录，入口为 `project.config.json`，`miniprogramRoot`为 `miniprogram/`。`touristappid`仅用于工程查看，隐私协议 / 相机 / 相册等真机验证需要自己的小程序账号与后台配置。

首页的规格仍为禁用草稿，不开放 AI 制作。实验室只裁剪 / 缩放，支持 JPEG / PNG 与整数 bytes 上下限（留空不限，端点最多 10 MiB）。
有约束 JPEG 最多尝试 8 次 quality 0.55–0.92，PNG 仅一次；每次读回检查尺寸、实际格式与字节边界，失败不保存，不缩固定像素或填充文件。
质量底线只是 PoC 参数，仍需真机成品评估；未验证的图片方向会明确拒绝，保存相册后的文件 / DPI 不能用模拟器测试替代。

导出会将平台临时文件移为应用私有中间文件后校验与清理，异常终止可能残留；下次导出前清扫保留命名空间，正常清理失败可主动重试。
只清理实验室拥有的文件，不删除原照片，不建立本地历史相册；未移动的临时文件由微信管理。
基础真机确认与本批复测清单见 [09 真机与精确导出复测](docs/09-真机与精确导出复测.md)。

`miniprogram/services/api.js`是未接入页面的网络适配基础，不把本地文件 PUT 冒充 COS 直传。接入云环境前需完成受信身份、限权上传、正式审核回调与私有素材签发。

### 模型 PoC 准备

```bash
node scripts/model-poc.mjs --check
node scripts/model-poc.mjs --verify
```

默认清单 `config/model-poc.example.json` 是禁用草稿，`--check` 校验结构并列出准备缺口，
`--verify` 应返回 `materialsReady: false` 和退出码 1。结构通过不代表模型已可用。
工具只核验授权 / 场景 / 人工许可记录、文件可访问性和权重哈希，不读取照片内容或执行推理。
使用真实测量记录进行 `--summarize` 前须完成清单，汇总不等于真实基准已由工具运行。
操作和报告契约见 [10 模型 PoC 准入与测量记录](docs/10-模型PoC准入与测量记录.md)。

### 本地 ONNX 推理与离线评测

```bash
.venv/bin/python -m pip install --only-binary=:all: \
  --cache-dir .wheelhouse/pip-cache -r backend/requirements-model.lock
.venv/bin/python -m nanyiphoto_api.model_evaluation \
  --manifest .data/model-poc.json --engine onnx-reference --artifacts
```

须先准备真实 ready 清单、授权图和经核验权重；默认草稿按预期拒绝，不会运行模型。
本机 macOS 13.2 / x86_64 使用显式参考后端，锁定可实际加载的 ONNX 1.20.0；
Linux 使用 `--engine ort-cpu` 单独验证，不把参考执行时间当作部署性能。
产物保存在私有 `.data/poc-runs`，默认不保存照片，`--artifacts` 才保存 A/B。
使用、预算、错误及测试边界见 [11 ONNX 推理与离线评测](docs/11-ONNX推理与离线评测.md)。

## 下一阶段

目标真机换底流程的代码、单图模型配置及 LAN 启动说明见 [12 真机换背景实验室](docs/12-真机换背景实验室.md)。
用户已同意官方 MODNet 下载与私有测试；网络恢复后通过现有系统代理成功下载 `.data/models/modnet.onnx`
（25,888,640 bytes），完整哈希 / ONNX 结构核验及本机参考后端会话构造通过。
已依据用户授权配置独立的私有实验室，不引入逐张人工审核，不伪造正式许可审查记录。
修复参考 Resize 空参数兼容问题；实际 MODNet 非人像图 HTTP 推理、透明前景、
白蓝红合成和 JPEG / PNG 参考导出已通过；本次修复控制台断开时子进程启动失败，
方 / 竖 / 横三种尺寸在断管隔离服务中通过，合计 18 份 295×413 参考导出；
手机已提供真实蓝底预览截图；新增四阶段 / 循环等待条与等待秒数，
进度提示用户真机通过；随后实现私有 `modnet-edge-v1` 边缘颜色恢复 / 轻量蒙版细化，
原图白蓝红 A/B 与实际 HTTP 结果一致，最新 454 项自动化测试通过，新算法手机画质 / 相册仍需复测。

```bash
node scripts/start-matting-lab.mjs --lan
```

本机当前 LAN 地址 `http://192.168.3.32:8000`，已验证模型 `ready:true`；
手机使用同一私有 Wi-Fi，令牌从 `.data/device-lab.env` 的 `NP_DEV_TOKEN` 取值。
独立配置不修改 `.env` 或打印令牌，省略 `--lan` 时只监听本机。
用户填回令牌后，8000 端口已重启并加载修复，复用原配置、不输出或轮换令牌；
新服务三种尺寸真实推理及 18 份换底参考导出 / 取消通过，竖图和横图经 LAN 验证，
详见 docs/12 第 10 节。服务已脱离临时控制台，诊断继续写私有日志。
尚需用户按 docs/12 完成本批真实人像 / 微信 Canvas / 相册导出复测；
非人像图与 Pillow 参考导出不作为真机画质或生产验收。
新处理进度提示仅改前端，重新编译小程序即可，不需要重启后端；画质观察与边界见 docs/12 第 11 节。
边缘优化后端已重启、凭据不变；重新选择同一原图抠图即可得到新版结果，
算法不要求再次重编译前端。私有蓝底对比、限幅 / 内部保护与测试边界见 docs/12 第 12 节；
用户最新结果分析见第 13 节，后续优先局部去除背景混色，避免统一侵蚀伤及发丝 / 眼镜。

## 版本发布与 CI

本版使用 Git 标签 / GitHub 预发布版交付源码，不自动上传或发布微信小程序，不部署生产后端。
模型权重、照片、`.data/`、开发凭据和本机私有配置不进入 Git / Release / CI 产物。
CI 的小程序 ZIP 是开发者工具源码包，不是已签名或经过微信审核的发布包；
后端 wheel 不包含权重或完整运行环境，仍需依照依赖锁及私有配置启动。
发布范围、已知问题和实际发布 / 构建证据见 [13 发布记录](docs/13-发布记录.md)。

按 [实施计划](docs/02-实施计划.md)补录已通过导出复测的设备 / 成品证据，继续账号 / 类目与云资源核实、首发规格用途核验、模型许可 / CPU / 成品 PoC 和真实审核。
不能以基础真机跑通或本地合成 fixture 的测试通过作为完整 PoC / 上线验收。
