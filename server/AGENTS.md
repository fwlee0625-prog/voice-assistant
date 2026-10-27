# Express 后端开发约束

## 范围与边界
- 当前承接 `frontend-test` 对话页与设置页实际调用的实时 ASR、匿名话者分离、说话人交互门控、Smart Turn 话轮检测、人声增强、健康检查、JSON 配置管理与 OpenAI 兼容模型回答。
- LLM 按用户明确需求在新后端独立实现 OpenAI 兼容 HTTP 适配器；不搬迁旧后端的 LLM、RAG、工具注册、TTS、唤醒模块。新 TTS 按明确需求在 src/tts 独立接入。
- 不导入、代理调用或通过 sys.path/软链接依赖旧 backend 的源码；不依赖旧 FastAPI 进程。
- 模型推理属于隔离 worker；HTTP/WebSocket 生命周期属于 Node。禁止在 Node 事件循环做同步重计算。
- 台球业务未来通过 HTTP 适配器调用，不直接导入 billiards_core 源码。

## 文件与函数职责
- `src/index.ts`：配置加载、监听、退出；禁止写业务逻辑。
- `src/config.ts`：集中读配置和路径解析，仅读取 server/.env 与进程环境变量；其他模块不自行读 .env。
- `src/app.ts`：注册 HTTP 路由和错误处理中间件；import 时不能启动服务。
- `src/server.ts`：组装 HTTP/WebSocket 及测试依赖；不处理音频或供应商协议。
- `src/asr/upgrade.ts`：路径与 Origin 校验、连接升级。
- `src/asr/session.ts`：单连接状态、音频校验、超时、背压、结束与释放。
- `src/asr/tencent-client.ts`：腾讯云连接地址和 start 参数；更换供应商只改适配层。
- `src/asr/signature.ts`：纯签名函数；禁止输出密钥/签名。
- `src/asr/protocol.ts`：事件契约、供应商结果归一化和安全错误映射。
- `src/settings/store.ts` / `routes.ts`：普通配置 JSON 校验与存储 / 配置 HTTP 契约。
- `src/chat/client.ts` / `routes.ts`：OpenAI 兼容适配、消息校验 / HTTP 与 SSE 生命周期、背压与取消。
- `src/chat/speech.ts`：对话播报编排；语音合成只依赖 TtsProvider 契约，决策由调用方注入。
- `src/chat/filler-decision.ts`：本地模型服务的 HTTP 调用、对话状态和衔接词选择；不运行模型。
- `src/tts/provider.ts` / `xiaomi.ts` / `sentences.ts`：统一 TTS 契约 / 小米协议适配 / 增量分句；路由和前端不解析供应商字段。
- `src/tts/routes.ts` / `wav.ts`：纯 TTS 完整/流式 HTTP 生命周期 / PCM16 的 WAV 封装；与对话共用供应商适配器。
- `src/http/sse.ts`：上游 SSE 分片解析与读取释放。
- `src/enhancement/routes.ts`：multipart 校验和 WAV HTTP 响应。
- `src/enhancement/worker.ts`：子进程执行、并发限制、取消、超时与输出限制。
- `src/turns/audience.ts`：每条 ASR 会话的交互人管理、明确呼叫、旁人/等待门控；不得当作生物身份识别。
- `src/turns/session.ts`：ASR 与门控组合、8 秒 PCM 环形窗口、VAD epoch 和迟到结果隔离。
- `src/turns/worker.ts`：每个服务器实例共用的常驻模型进程、预热、并发上限、超时、取消与安全降级。
- `workers/turn_detector.py`：仅做 Smart Turn 特征提取和 ONNX CPU 推理，禁止 HTTP 或旧后端导入。
- `workers/denoise.py`：仅解码、DPDFNet 推理、编码；禁止 HTTP、业务编排及旧后端导入。
- `src/http/errors.ts`：统一公开错误；不返回栈、原始供应商消息或配置对象。

## 避免冗余
- 一个模块一个职责，一个函数一个可命名的任务；禁止大型入口文件、全局业务单例、万能 utils 文件。
- 同一业务规则只保留一个实现；入口/路由不得重复供应商字段转换或模型逻辑。
- 不预建空模块、抽象基类、通用插件框架、未使用的接口和兼容分支。
- 新增文件/接口时同步更新 README 的模块表和契约；偏离边界时先修正设计，不能靠继续堆分支解决。
- 事件区分单句 `result.final` 与整流 `done`；一条句子可含多个 speaker_segments，不能只取第一人。
- 每条连接独立状态和定时器，结束、断开、异常必须释放上游与 worker；不得让迟到结果进入新连接。

## 配置、验证、运行
- 密钥只放进忽略的 server/.env 或环境变量；禁止写入源码、日志、测试快照、README。
- 服务启停/重启只通过 Spark；前端默认 `/api` 代理到 localhost:8020。
- 修改后运行 `pnpm check`、`pnpm build`、`pnpm test`；协议或异步生命周期变更必须覆盖正常与异常路径。
- 测试默认模拟云端，不上传用户音频，不产生云调用费用。
