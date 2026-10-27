# 本地模型运行服务

独立 Python 服务，仅负责模型加载、预热与推理。当前提供 Laya 多语决策模型（322M，Apache-2.0）。与 Node、旧 backend 的源码及虚拟环境隔离；不在这里维护台球规则、衔接词或 TTS。

## 安装与资产准备

在本目录执行：

```sh
uv sync --locked
uv run --locked model-download
```

uv 使用 Python 3.12，创建本目录 `.venv/`。`uv.lock` 锁定依赖。下载官方 `convaiinnovations/laya-multilingual`，固定版本见 `src/model_service/config.py`，文件保存在忽略的 `models/laya-multilingual/`。下载需要网络；推理启动强制离线，缺失资产时 readiness 返回 503。

可选复制 `.env.example` 为 `.env`，通过 `uv run --env-file .env --locked model-download` 读取下载配置；Spark 的启动命令也需增加 `--env-file .env`，或者直接在 Spark 配置环境变量。代码不会读取旧 backend 或 Node 的 .env。

## 运行与验证

启停统一通过 Spark，注册项目为 `billiards_voice · 模型服务`，工作目录为本目录，启动命令 `uv run --locked --no-sync model-service`，端口 8030。保持一个进程、一个 worker，避免重复加载模型。开发时也由 Spark 重启，不使用热重载。

- `GET /health/live`：HTTP 服务存活。
- `GET /health/ready`：模型完成加载和预热才返回 200；加载中或失败返回 503。
- `GET /v1/models`：模型标识、设备和状态。
- `POST /v1/decisions`：通用决策接口。
- `GET /docs`：接口文档。

```sh
curl http://localhost:8030/health/ready
curl http://localhost:8030/v1/decisions \
  -H 'Content-Type: application/json' \
  -d '{"model":"laya-multilingual","state":{"utterance":"你好，教练"},"questions":{"intent":{"type":"choice","instructions":"Which intent best describes the utterance?","criteria":{"greet":"Greeting someone","question":"Asking for an explanation","other":"Other intent"}}}}'
```

响应包含 `model`、`answers`（Laya 的类别、概率等结果）、`usage`（含 token 用量与截断信息）、`latency_ms`（模型调用耗时，非端到端音频延迟）。调用方应检查 `usage.truncated`，截断时缩短上下文后重试或采用业务降级。概率未经本业务校准，不应直接当可靠阈值。

当前输入限制：最多 4 个问题；choice 为 2–8 个带描述选项；score 为 2–8 个有序描述；noul 不传 criteria。state 支持字符串或 JSON 对象，总长最多 4000 字符。模型自己的 token 窗口仍有上限，保持上下文和选项简短，不能将字符限制理解为完整上下文保证。

单次只接纳一个推理请求，忙时 429，无排队；未就绪 503，未知模型 404，无效输入 422，推理失败 500。调用方负责超时、是否重试及业务降级。客户端断开或取消不能中止已经进入 PyTorch 的计算，计算结束前不会开放下一次推理。

默认 CPU。`LAYA_DEVICE=mps` 可使用 Apple GPU，`cuda` 用于 NVIDIA；更换设备后由 Spark 重启并测量真实延迟。健康检查在模型计算时保持可用。

```sh
uv run --locked ruff check .
uv run --locked pytest
```

## 后续模型

按模型增加独立适配器，负责自己的权重与推理；在服务中注册明确模型 ID。新增不同任务时提供对应接口并按实际需要隔离环境或进程，不把所有模型强行塞进一个通用 predict。当前没有预加载其他模型，也没有业务分类提示词。

来源：[Laya 官方多语模型](https://huggingface.co/convaiinnovations/laya-multilingual)、[官方 Python 库](https://github.com/NandhaKishorM/laya)。

## 本机验收记录（2026-10-27）

- uv 独立虚拟环境已安装，`uv sync --locked --offline` 同步通过；Laya 0.4.15、PyTorch 2.14.1。
- 静态检查通过，12 项模拟测试通过，包含加载失败、繁忙拒绝、推理失败、请求取消和资源释放。
- 官方权重 SHA-256：`9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204`，已校验。
- Spark 实际启动验证：缺少资产时 live 为 200、ready 为 503；完整资产离线加载预热后 ready 为 200。
- CPU 中文冒烟请求：`你好，教练` → `greet`（103.08ms）；`低杆怎么打？` → `question`（53.43ms）。这是两次接口调用，不代表业务准确率或延迟基准。
- Express 对话链路通过 localhost 请求本服务选择衔接词；业务文案和降级逻辑位于 `server/`。
