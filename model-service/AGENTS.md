# Python 模型服务边界

- uv 管理 pyproject.toml、uv.lock 和本目录 .venv，不复用 backend/ 的环境。
- 本目录只负责模型资产、加载、预热和推理；衔接词、台球规则、LLM/TTS 编排属于调用方。
- HTTP 生命周期在 app.py；模型相关代码在对应适配器。新增模型时增加适配器和明确接口，不预建插件框架。
- 模型操作在单独执行线程内串行运行，不能阻塞 HTTP 事件循环。繁忙时拒绝请求，不积累无界队列。
- 运行时仅使用本地权重；下载显式执行，固定 revision。密钥只用环境变量或忽略的 .env。
- 项目启动、停止、重启通过 Spark，默认仅监听 localhost。
- 修改后执行 uv run ruff check . 和 uv run pytest；测试模拟模型，不下载权重。真实模型验收另行记录。
