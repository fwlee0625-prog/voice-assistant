# Billiards Voice

从 `billiards_core` 抽取的独立语音助手项目。包含 ASR、RAG、主/次级 LLM、工具调用、句子级流式 TTS、语音唤醒和调试页面。无需安装台球引擎、视觉识别、裁判模块或 CUDA 即可启动 API。

## 当前录音页后端

`/record` 已切换到独立的 **Express + TypeScript** 后端（`server/`，8020）。安装、配置、接口、模块职责见 [server/README.md](server/README.md)，开发约束见 [server/AGENTS.md](server/AGENTS.md)。实时识别由新服务承接；对话页只在右侧展示当前问答文本，不保留录音、播放或下载。

下文 `backend/` 的启动与模型说明保留给旧语音助手页面；录音页不再依赖旧 FastAPI 进程。录音页的新配置填写到 `server/.env`，不要再改 `backend/.env`。

## 独立模型运行服务

根目录 `model-service/` 是独立 Python 推理服务，使用 uv、独立 `.venv/` 与 `uv.lock`，当前加载 Laya 多语决策模型，默认端口 8030。只负责模型运行，不维护台球规则、衔接词文案或对话编排。Express 对话链路通过 localhost 请求模型选择衔接词。安装、离线资产准备、HTTP 契约和 Spark 运行说明见 [model-service/README.md](model-service/README.md)。

## 旧服务本地开发

Python 3.11+。在 `backend/` 下创建 `.venv` 并安装 `requirements.txt`，复制 `.env.example` 为 `.env`，填入实际模型地址和密钥。不要提交 `.env`。

通过本地项目管理平台 Spark 管理启动/停止/重启：
- 项目目录：`backend/`
- 启动命令：`.venv/bin/python run.py --reload`
- 端口：8015
- 页面：http://localhost:8015/
- API 文档：http://localhost:8015/docs
- 进程健康：http://localhost:8015/api/health

测试前端（Vue 3 + Vite）在同一 Spark 项目中作为第二个终端管理：
- 目录：`frontend-test/`，首次运行 `pnpm install`
- 启动命令：`pnpm dev`
- 地址：http://localhost:5178/ ，`/api` 已代理到新后端 `http://127.0.0.1:8020`，页面直接请求 `/api/...` 即可

`/api/health` 仅表示进程可用；模型服务需单独配置。普通问答需要 LLM，知识检索需要 embedding，录音需要 ASR，播报需要至少一个可用 TTS 后端。

## 目录与边界

- `backend/run.py`：服务启动入口，默认端口 8015。
- `backend/voice/`：原语音核心及 `knowledge_base/` 知识文档。
- `backend/voice/chroma_db/`：复制原有向量库用于延续开发，作为本地数据被 Git 忽略。
- `backend/service/`：独立 FastAPI 服务、原有语音路由、台球 HTTP 适配器。
- `web/`：现有语音页面与脚本，由后端作为静态目录托管。
- `frontend-test/`：独立测试前端页面目录，与后端解耦。
- `backend/deploy/`：可选 NVIDIA GPU 模型服务编排，以及 CosyVoice/MeloTTS 服务代码。
- `backend/doc/api_voice.md`：原接口契约参考；示例端口应改成 8015，工具注入位置现为 `backend/service/integration.py`。

所有 `/api/voice/*` 路径及 SSE 事件结构保留。`BILLIARDS_CORE_URL` 可选：推荐/模拟/摆球通过原服务 `/api/voice/execute` 调用，不配置时返回明确错误；语音问答链路仍可独立开发。原主项目代码保留，本次不自动切换其语音调用。

语音页与球台页现在跨端口，浏览器 sessionStorage 不共享；“前往球台”只负责跳转，不自动同步球局。后续可通过统一网关或显式球局接口完成联动。

## 知识库与模型

配置好 embedding 后可用 `.venv/bin/python -m voice.ingest --rebuild`（在 `backend/` 下执行）重建向量库。该命令不会启动服务。

`backend/deploy/docker-compose.yml` 是可选 GPU 服务器方案，需要 NVIDIA 环境和实际 `MODEL_DIR`，不适用于当前 Mac 直接运行 GPU 模型。启动编排同样通过项目管理平台配置终端操作。Web 镜像仅包含独立语音服务。MeloTTS/CosyVoice 的模型权重和额外依赖不随本项目复制。

## 验证

安装开发测试依赖 `httpx` 后，在 `backend/` 下执行 `.venv/bin/python -m unittest discover -s tests -v`。测试使用模拟模型，不产生模型费用。

## record 实时转写

访问 http://localhost:5178/record 。点击录音后，页面通过腾讯云 TRTC v3 WebSocket 接口实时显示中文转写，右侧对话记录以聊天气泡实时显示当前提问与回答；结束对话后保留本轮文本，开始新对话时替换。文本仅保存在当前页面，刷新后清空。这里的转写为语音转文字，不进行跨语言翻译。

在 `server/.env` 或 Express 后端环境变量中配置（不是腾讯云 CAM SecretId/SecretKey）：

```dotenv
TENCENT_TRTC_SDK_APP_ID=你的TRTC应用ID
TENCENT_TRTC_SECRET_KEY=你的TRTC应用SDK密钥
```

在 TRTC 控制台准备已开通 ASR 的应用，使用国内站凭证。通过 Spark 重启语音服务使配置生效。未配置或识别连接失败时页面显示原因，仍可正常录制、保存原音频。无需启动本地 Qwen ASR 模型。

浏览器同时保留 MediaRecorder 原音频，并用 AudioWorklet 发送 16kHz、单声道 PCM16（40ms/1280 字节）到 `/api/voice/asr/realtime`。后端签发与 voice_id 绑定的 UserSig，代理至腾讯云；签名和 SDK 密钥不返回前端。支持 Chrome 的 localhost/HTTPS 安全上下文。Vite 已启用 WebSocket 代理；生产反向代理也需要转发 WebSocket Upgrade，页面与 API 应使用同一域名。

接口事件：`ready`、`result`（index/text/final）、`done`、`error`。同一个 index 的非最终文字会被替换，避免重复拼接。客户端停止时发送 `{"type":"end"}`，等待最终识别结果；前端页面退出会释放麦克风、音频节点和连接。

协议参考：[腾讯云实时识别 v3](https://cloud.tencent.com/document/product/647/138784)。前端协议与 PCM 分帧测试：在 `frontend-test/` 执行 `node --test tests/*.test.mjs`；新后端测试在 `server/` 执行 `pnpm test`，无需凭证或调用云服务。旧后端测试仍可单独执行上述 unittest 命令。

record 转写默认启用匿名话者分离（`speaker_diarization=1`），识别链路按“说话人 1 / 说话人 2”区分话者并用于交互门控；未分配话者时标记为“待区分”。编号仅在本次录音内有效，不表示已登记的个人身份。转写事件携带 `speaker_segments`（speaker_id/text/stable_flag），一条结果可以包含多位说话人，同一句的后续最终结果会更新分段归属。此功能无需声纹登记，不传入声纹或角色认证参数。仍需正确配置 TRTC 应用凭证才能进行真实识别。
