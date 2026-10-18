# 南一证件照

原生微信小程序 + 独立开发用 FastAPI 实验室。本工作分支 `review/no-private-model-comparison`
从 `feat/local-chroma-key-mvp` 的 `6bae825` 创建，用于隔离验证提审包；
此前的 `feat/local-chroma-key-mvp` 已发布为 GitHub 预发布 `v0.2.0-rc.3`；
当前隔离候选版本为 `v0.2.0-rc.4`；
以普通用户可用的「南一证件照」本地编辑工具为首发目标：裁剪、纯色背景换底、常见尺寸、
JPEG / PNG 和文件大小导出都在设备上完成。用户此前确认上游分支的本地编辑链路真机测试通过；
本分支新增的提审隔离改动尚未真机复测。设备 / 微信版本及逐项覆盖未留档，不代表完整 Android / iOS 矩阵、
相册元数据或正式审核已验收。该 GitHub 预发布不是微信平台上传、提审或上架。
`v0.2.0-rc.1` 至 `v0.2.0-rc.3` 是此前的开发预发布标签。

## 已实现的范围

- 小程序：首页常用尺寸入口、本地裁剪 / 纯色背景抠除与修边 / 换底编辑页；支持小一寸、一寸、大一寸、小二寸、二寸打印参考尺寸，并导出 JPEG / PNG 与指定文件大小范围。
- 常见尺寸按 300 DPI 换算并注明为参考值；不承诺适用于所有证件、报名或办理渠道。
- 导出文件：应用私有中间文件的替换 / 失败 / 退出清理、失败重试及下次导出前保留命名空间遗留清扫；不建立历史相册。
- 本地 API：私有上传、防覆盖与归属校验、版本化规格 / ETag、幂等任务、有限队列、审核 / 推理双状态、受鉴权素材访问、取消 / 过期清理。
- 模型接口与 worker 步骤：新增本地 FP32 RVM / MODNet ONNX 适配器，保持显式注入及审核门禁，不安装默认假抠图。
- 后端结构化日志 / 请求标识、小程序有界调试日志；不记录照片与访问凭证。
- Node / Python 单元测试、静态检查与 CI 配置。
- 模型 PoC：授权 / 场景 / 许可及权重 SHA-256 准入、实际离线图执行与测量、可选私有白 / 红 / 蓝 A/B；已核验的模型仅用于私有试验，不自动批准画质或启用生产服务。
- 提审隔离：小程序包不包含私有模型对比页面、上传客户端或入口；本地模型实验工具仅留在仓库外层开发目录，不属于 `miniprogram/`。

2026-10-17 用户确认现有页面与基础导出实验室开发者工具 / 真机测试通过。
随后确认新增导出约束复测通过。上述真机确认针对上游分支的本地编辑链路，不覆盖当前提审隔离改动；
本分支仍需在开发者工具和目标真机复测。设备 / 微信版本、逐项覆盖、实际文件证据与完整 DPI / 方向矩阵仍待补录。
真实官方 MODNet 权重已下载核验，本机参考后端与私有人像 HTTP 链路已验证。
用户确认处理进度条真机通过，并提供新版蓝底结果：脸侧 / 肩线浅边略有减轻，
发丝 / 鬓角仍需优化；截图不替代相册原始文件、完整设备矩阵或最终画质验收。
本次发布批次 Node 214 项 + Python 241 项 = 455 项通过，Ruff、依赖检查与实际 API 冒烟通过；
`v0.2.0-rc.2` 的分支 / 标签远程 CI 均已成功，Linux ORT CPU、测试和构建产物上传通过，
Release 已附后端 wheel、小程序源码 ZIP 与校验和；详见 [发布记录](docs/13-发布记录.md)。
CI 固定 Python 3.14.5 / Node 24，检查真实 Linux ORT CPU provider，支持推送 / PR / 手动触发，
检查通过后构建后端 wheel、小程序源码 ZIP 与 SHA-256 校验和，保留 14 天。
正式 `mediaCheckAsync`、COS / 云数据库与目标实例 PoC 仍待完成；生产配置保持禁用。

功能分支新增本地颜色取样、边缘连通背景抠除、容差调节、擦除 / 恢复笔和换底预览；
本轮产品化调整加入常用尺寸、普通用户首页、KB 单位换算及私有模型三路对比。
本轮本地 Node 237 项 + Python 241 项通过，并通过静态检查、Ruff、格式、依赖与 API 冒烟。
`v0.2.0-rc.3` 的分支 / 标签 CI 均成功，Linux ORT CPU、测试、API 冒烟与构建产物上传通过；
验证后的 wheel、小程序源码 ZIP 和校验文件已附加至 GitHub Release，详见 [发布记录](docs/13-发布记录.md)。

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

项目展示名和小程序导航名称为「南一证件照」，品牌区域展示「南一科技」。
首页提供五种常见打印尺寸参考；进入编辑页可拍摄或选择照片，完成裁剪、构图、纯色背景取样与修边、
白 / 蓝 / 红换底，并导出所选像素尺寸、JPEG / PNG 及文件大小限制。核心处理不需要后端，
选中的照片不会上传。大小输入按 1 KB = 1024 bytes 换算，留空表示不限制。
常见打印尺寸及 300 DPI 像素只是参考值；具体用途、背景颜色、文件大小与编辑允许性请以办理方说明为准。
本地色键法更适合均匀背景、人物与背景反差明显的照片；复杂发丝、阴影或相近颜色衣物可能需手动修边，
工具不保证通过任何特定用途审核。

本分支的「关于」页不包含私有模型对比；提审包内所有照片编辑路径均在本机处理，不连接模型服务或上传照片。
仓库外层的 `scripts/start-matting-lab.mjs` 与后端实验室只供开发测试，不属于小程序源码目录。
用户确认此工作树已通过真机测试；微信 Canvas 像素接口、取样触控、真机性能等细项尚无设备 / 运行记录，
相册实际文件和 Android / iOS 兼容矩阵仍待补证；未验证方向的照片会提示用户重新选择。

导出会将平台临时文件移入应用私有目录后校验与清理；异常终止时可能残留临时文件，下次导出前会清扫。
不删除原照片、不建立历史相册；相册保存后的成品需真机检查。已有验证项和本轮复测清单见
[09 真机与精确导出复测](docs/09-真机与精确导出复测.md)。

### 微信小程序正式提审前

- 确认小程序账号主体、服务类目及「南一证件照」名称可用，并在微信公众平台完成名称、头像 / Logo 和介绍配置。
- 按实际相机、相册和照片处理流程，配置并核对隐私保护指引、隐私授权弹窗及拒绝后的可用行为。
- 用目标微信版本及至少一台 iOS / Android 真机验证拍摄 / 选图、不同朝向、触控取样 / 修边、五种尺寸、JPEG / PNG、大小边界和相册保存。
- 人工核对尺寸参考文案、服务说明和隐私声明；若目的地有专用规格，必须依办理方要求处理，不能用通用预设代替核验。
- 检查提审源码包中不存在 `pages/matting` 与 `services/matting-lab.js`；该开发实验室未包含在本分支小程序包中。

以上账号 / 平台配置、实际设备验收、提审和审核结果尚未由仓库验证；当前代码不表示小程序已提交或已上架。

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

以上命令启动的是仓库外层的本地开发实验室，不属于本提审隔离分支的小程序包。
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
