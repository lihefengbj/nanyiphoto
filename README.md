# 南忆证件照

原生微信小程序 + FastAPI 单服务。当前交付是 M0 工程与本地契约实现，不是可上线的证件照服务。

## 已实现的范围

- 小程序：首页、禁用规格详情、本地裁剪 / 精确像素导出验证页、隐私授权组件。
- 本地 API：私有上传、防覆盖与归属校验、版本化规格 / ETag、幂等任务、有限队列、审核 / 推理双状态、受鉴权素材访问、取消 / 过期清理。
- 模型接口与 worker 步骤：测试注入合成数据验证状态，不在应用内安装假抠图或自动审核。
- Node / Python 单元测试、静态检查与 CI 配置。

模型权重、真实 `mediaCheckAsync`、COS / 云数据库和真机导出仍待 PoC；生产配置被代码禁止。详细边界见 [开发与验证记录](docs/07-开发与验证记录.md)。

## 本地开发

版本记录为 `.node-version`的 Node.js 24.18.1 和 `.python-version`的 Python 3.12.12。以下命令在仓库根目录执行；`py -3.12`应指向该补丁版本，或用 uv 创建指定版本虚拟环境。

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.lock
.\.venv\Scripts\python.exe -m pip install --no-deps --no-build-isolation -e backend
npm run miniprogram:sync
npm run check
npm test
.\.venv\Scripts\python.exe -m pytest backend/tests
.\.venv\Scripts\python.exe -m ruff check backend
npm run smoke:api
```

`requirements.lock`包含首批开发 / 测试依赖，不作为尚未建立的生产镜像依赖方案。若本机 pip 索引、缓存权限或下载卡住，可使用受信 uv 工具安装同一个锁文件，不关闭证书校验或使用不明镜像：

```powershell
uv --cache-dir .wheelhouse/uv-cache venv --python 3.12.12 .venv
uv --cache-dir .wheelhouse/uv-cache pip install --python .venv/Scripts/python.exe -r backend/requirements.lock
uv --cache-dir .wheelhouse/uv-cache pip install --python .venv/Scripts/python.exe --no-build-isolation --no-deps -e backend
```

### 启动 API

复制 `.env.example`为被 Git 忽略的 `.env`，设置一个随机的 `NP_DEV_TOKEN`。这只是本地开发身份，不是微信登录、API Key 或真实用户标识，不要使用账号密码。开发环境仅监听回环地址：

```powershell
.\.venv\Scripts\python.exe -m uvicorn nanyiphoto_api.main:app --env-file .env --host 127.0.0.1 --port 8000
```

- `/health/live`：进程运行时返回 200。
- `/health/ready`：未接模型与审核时返回 503，符合预期。
- `/api/specs`：携带本地 Bearer 令牌；当前草稿目录返回空可用列表。
- `/api/callbacks/moderation`：返回 503，不能用任意 JSON 请求批准照片。
- `.data/`包含本地任务数据库与临时对象，不入 Git。不要将开发服务直接暴露到公网。

### 打开小程序

微信开发者工具导入仓库根目录，入口为 `project.config.json`，`miniprogramRoot`为 `miniprogram/`。`touristappid`仅用于工程查看，隐私协议 / 相机 / 相册等真机验证需要自己的小程序账号与后台配置。

首页的规格仍为禁用草稿，不开放 AI 制作。实验室只裁剪 / 缩放，提供临时文件像素、格式和字节读回结果；未验证的图片方向会明确拒绝，保存相册后的文件 / DPI 不能用模拟器测试替代。

`miniprogram/services/api.js`是未接入页面的网络适配基础，不把本地文件 PUT 冒充 COS 直传。接入云环境前需完成受信身份、限权上传、正式审核回调与私有素材签发。

## 下一阶段

按 [实施计划](docs/02-实施计划.md)继续完成账号 / 类目与云资源核实、首发规格用途核验、模型许可 / CPU / 成品 PoC、真实审核和真机验证。不能以本地合成 fixture 的测试通过作为模型效果或上线验收。
