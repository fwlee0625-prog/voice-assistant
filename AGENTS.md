# 开发规则
- 项目启动、停止、重启通过本地项目管理平台（Spark）操作；未注册时先注册。
- 本地验证优先 localhost；有权限要求的页面使用 Google Chrome。
- 此项目独立于 billiards_core，不得添加指向其目录的 sys.path 或源码软链接。
- 台球业务通过 backend/service/integration.py 的 HTTP 适配器对接。
- 密钥仅通过环境变量或忽略的 .env 配置。

## 新后端迁移
- 当前 record 页面后端为 `server/`（Express + TypeScript，8020）；开发必须遵守 `server/AGENTS.md` 的职责划分。
- `backend/` 是旧 FastAPI 服务（8015），保留历史能力；不要把旧 LLM/RAG/TTS 等模块整体复制进新后端。
- 新后端已有功能和接口契约见 `server/README.md`；新增功能须有明确页面/业务需求，避免冗余抽象。

## 独立模型服务
- 根目录 `model-service/` 仅负责本地模型资产、加载、预热与推理，使用 uv 和独立 `.venv`，遵守其 `AGENTS.md`。
- 新增模型优先在该服务中接入；Node 通过 localhost HTTP 调用，不在 Node 中加载模型。
- 业务规则、衔接词文案与对话编排留在业务后端；不复用旧 backend 的源码或虚拟环境。
