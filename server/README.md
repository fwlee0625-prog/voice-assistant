# Billiards Voice — Express 后端

独立 Express 5 + TypeScript 服务，默认 `127.0.0.1:8020`。当前承接语音对话页、配置管理、实时 ASR 和人声增强。旧 `backend/` 保留供历史语音页使用；新服务不请求旧 API、不导入旧源码；LLM 使用独立的 OpenAI 兼容 HTTP 适配器，不加载旧 RAG/TTS。

## 已迁移能力

| 功能 | 执行位置 |
| --- | --- |
| 麦克风录音、波形、浏览器降噪/增益/回声消除 | 现有 Vue 页面，本地执行 |
| 实时中文 ASR、匿名说话人分段 | Node WebSocket 直接连接腾讯云 TRTC v3 |
| DPDFNet 人声增强 | Node 上传接口 + 隔离 Python worker |
| 原音频/增强版播放、进度、下载、删除、A/B 切换 | 现有 Vue 页面，本地执行 |
| 实时文字、查看文本弹框 | 现有 Vue 页面，本地执行 |

语音对话先经说话人交互门控，再结合浏览器 Silero VAD、后端 Smart Turn 和 ASR 最终结果决定何时提交。Smart Turn 高置信完成时采用约 350ms 静音预算（明显未完句仍保留等待），低置信完成时最多等待约 2500ms 静音；推理未就绪/失败会退回文本规则。文本兜底规则为：问句约 450ms、完整句约 550ms、普通句约 750ms、短句约 900ms、明显未完句约 1300ms。计时包含本地已经发生的静音，不会在云端 final 后再固定多等 1 秒；新语音活动或中间结果会取消提交，仅在所有片段 final 后发起模型请求。相同 index 的重复 final 不延长等待、不重复请求；同 index 的文字修订替换原文。手动点击结束、收到 ASR done 后立即提交剩余已完成文本；语音退出走下述结束语关闭流程，丢弃剩余待处理文本。

通过后端门控、说话人稳定的有效 ASR 话语在中间结果阶段即可打断正在生成/播放的旧回答：停止已调度音频、取消旧模型和 TTS，旧流迟到结果不进入新一轮。被打断回答单独标记，后续上下文仅带被打断标记，不把尚未完整播报的全文当作已告知用户。正常完成回答携带本次会话已完成上下文；请求失败仍可页面重试。DeepSeek 等 OpenAI 兼容模型支持流式回答；回答短句经 TTS 桥接层交给小米 MiMo 合成，浏览器边收边播。仅播报 content，不播报 reasoning_content。TTS 失败不阻断文字回答。匿名说话人编号仅在本次会话有效。

## 对话与设置页面

- `http://localhost:5178/record`：手动点击开始后直接说话，由首个稳定说话人建立本次交互人；其他人明确呼叫助手可以切换。开始/结束对话，计时下方单行显示当前 ASR 文本或 LM 回答；右侧对话记录以聊天气泡实时显示当前提问与回答，不保留录音、播放、下载或增强入口。
- 对话页右上角「设置」弹框：设置 OpenAI 兼容基础地址（包含 `/v1` 等服务商前缀，不包含 `/chat/completions`）、模型名、系统提示词和 API Key。保存后下一条模型请求生效。
- 普通配置原子写入忽略的 `server/data/settings.json`，首次读取使用默认配置。API Key 写入忽略的 `server/.env` 的 `OPENAI_API_KEY`，小米密钥使用 `MIMO_API_KEY`，仅返回是否已配置；留空保留当前密钥，也可以通过环境变量配置。
- 对话文本和音频仍保存在浏览器内存；打开或关闭设置弹框会保留当前会话，刷新清空。设置 JSON 不存储对话音频。

## 安装与配置

Node >=22.18（当前开发为 24），在本目录执行 `pnpm install`。复制 `.env.example` 为 `.env`，填写 TRTC 的数字 SDKAppID 和 SDK 密钥（不是 CAM SecretId/SecretKey）。配置只在启动时读取，修改后通过 Spark 重启。

人声增强还需要 ffmpeg、Python >=3.11 以及 `workers/requirements.txt` 中的 numpy、sherpa-onnx。可以建立本目录 `.venv`，安装这两个依赖，并配置 `ENHANCE_PYTHON=.venv/bin/python`。将 `dpdfnet2_48khz_hr.onnx` 放入忽略的 `models/`，或通过 `SPEECH_ENHANCE_MODEL` 指定现有模型绝对路径。

本机迁移的忽略配置可复用原有 Python 虚拟环境和模型文件，它们只是运行时/模型资产；无需启动旧 Python Web 服务。迁移到新机器时按上段独立准备即可。worker 在每次增强时按需启动，退出后不保留常驻模型。

## Spark 启动

`billiards_voice` 项目新增「Express 后端」终端，目录 `../server`（相对 Spark 项目 backend 目录），命令 `node --watch --experimental-strip-types src/index.ts`，端口 8020。保留旧 Python 终端但录音页不再使用它；日常仅启动「Express 后端」和「测试前端」，旧 Python 终端保持停止。

测试前端仍是同项目的「测试前端」终端，端口 5178，`/api`（含 WebSocket）统一代理到 8020。访问 http://localhost:5178/record 。启停/重启均通过 Spark，禁止额外在 shell 启动常驻服务。生产运行先 `pnpm build`，然后由进程管理平台执行 `node dist/index.js`。

## 模块职责

| 文件 | 唯一职责 |
| --- | --- |
| src/index.ts | 配置、监听、退出 |
| src/config.ts | .env、配置验证、路径 |
| src/app.ts / server.ts | HTTP 路由组装 / HTTP+WS 组装 |
| src/asr/upgrade.ts | Origin、升级路径 |
| src/asr/session.ts | 单条流状态、上传、下行、超时、背压、清理 |
| src/asr/tencent-client.ts | 腾讯云连接和 start 帧 |
| src/asr/signature.ts | UserSig 签名 |
| src/asr/protocol.ts | 页面事件契约、云端字段转换 |
| src/turns/audience.ts | 稳定说话人交互门控、呼叫/等待/旁人决策 |
| src/turns/session.ts | 每会话 PCM 窗口、VAD epoch、模型结果隔离 |
| src/turns/worker.ts | 常驻 Smart Turn 进程、队列上限、超时和释放 |
| workers/turn_detector.py | Whisper 特征提取与 Smart Turn CPU 推理 |
| src/settings/store.ts | 配置校验、JSON 读写、原子替换与写入队列 |
| src/settings/routes.ts | 设置 HTTP 契约与来源检查 |
| src/chat/control.ts | 会话控制工具白名单、参数校验、控制提示词与明确结束指令 |
| src/chat/client.ts | 消息校验、OpenAI 兼容请求与安全错误映射 |
| src/chat/routes.ts | 对话 HTTP/SSE 生命周期、背压与断连取消 |
| src/chat/tone.ts | 语音回答提示词、流式语气标记提取与正文清理 |
| src/chat/speech.ts | 对话播报桥接：并行文字生成与顺序语音合成 |
| src/chat/filler-decision.ts | localhost 模型决策适配、上下文裁剪与衔接词候选选择 |
| src/tts/provider.ts | 统一 TtsProvider、SpeechRequest、AudioChunk 契约 |
| src/tts/routes.ts | 独立 TTS HTTP 接口、完整/流式返回、取消与背压 |
| src/tts/wav.ts | 归一化 PCM16 音频的 WAV 封装 |
| src/tts/xiaomi.ts | 小米 MiMo 的鉴权、请求、SSE 音频归一化与安全错误 |
| src/tts/sentences.ts | 增量短句切分与尾句刷新 |
| src/tts/fillers.ts | 默认衔接词文案与数量限制 |
| src/http/sse.ts | 上游 SSE 的 UTF-8 分片解析和读取释放 |
| src/enhancement/routes.ts | 上传校验、WAV 响应 |
| src/enhancement/worker.ts | 子进程、并发、时间/内存限制、取消 |
| workers/denoise.py | 解码→DPDFNet→WAV |
| src/http/errors.ts | 统一公开 HTTP 错误 |

开发约束见 [AGENTS.md](AGENTS.md)。不新增万能工具层、未使用抽象、空业务模块；路由不写模型/供应商逻辑。

## 接口契约

### 配置与模型回答

- `GET /api/settings`：返回 `{baseUrl, model, systemPrompt, apiKeyConfigured, tts, ttsApiKeyConfigured}`。不返回密钥。
- `PUT /api/settings`：JSON `{baseUrl, model, systemPrompt, apiKey?, tts?, ttsApiKey?}`；完整替换普通配置，非空 apiKey 更新密钥。成功返回与 GET 相同的对象。配置校验失败 400，不允许的浏览器 Origin 为 403；配置读写错误为安全 JSON 错误。JSON 请求体上限 256KB。
- `POST /api/chat/completions`：JSON `{messages:[{role:"user"|"assistant",content:string}]}`；1–100 条，单条最多 16000 字符，最后一条必须是 user。服务端添加配置中的系统提示词，向 `{baseUrl}/chat/completions` 发送非流式 OpenAI Chat Completions 请求。成功 `{text,model}`；无密钥 503，参数错误 400，上游错误/超时/空回答 502。请求最长 60 秒，客户端断连取消上游请求；供应商原始错误不返回前端。前端保留最近 49 轮完整上下文及当前问题。
- 对话页发送 `stream:true` 使用流式分支：上游 `stream:true`，下游 `Content-Type: text/event-stream`。每帧 `data: <JSON>\n\n`，事件为 `{type:"speech",enabled}`、`{type:"text",delta}`、`{type:"audio",data,sampleRate:24000,channels:1,format:"pcm16",text,sentenceId,start,end}`、`{type:"filler_audio",data,sampleRate:24000,channels:1,format:"pcm16",text}`、`{type:"sentence_end",sentenceId}`、`{type:"speech_error",error}`、`{type:"error",error}`、`{type:"done"}`。speech 为首个事件，表示本次是否开启自动播报。audio.data 为 base64；sentenceId 从 0 递增，同一句所有音频块共用编号，start/end 是移除语气标记后完整回答正文的 UTF-16 区间（左闭右开，包含清理前的 Markdown/空白）。sentence_end 表示该句合成完成，之后不再发送该句音频，不代表播放完毕。供应商差异只能出现在适配器内。done 表示文字与合成均结束，不代表扬声器已经播放完毕；前端等播放结束再处理下一轮。独立 `/api/tts` 保持原有 audio/error/done 契约，不发送这些对话句子事件。
- 对话页流式请求附带 `sessionControl:true`，向配置中的兼容模型开放 `pause_reply`、`end_conversation`、`disable_listening` 三个无参数工具；模型结合上下文判断模糊表达。服务端累积流式工具片段，仅完整、合法且唯一的工具调用生成 `{type:"control",action}` 事件，未知工具、非空参数、截断、多调用均报错且不执行。不传该开关维持原文本协议；所配置模型须支持 Chat Completions 工具调用（[供应商协议](https://api-docs.deepseek.com/guides/tool_calls/)）。
- 稳定交互人的明确“退出/结束对话/再见”和“关闭麦克风/不要再监听”由本地规则识别，最终 ASR 确认后不等待普通话轮计时或云端模型。结束时先中止旧模型/播放、清空待处理问题并封闭后续输入，通过 `/api/tts` 播报固定结束语（即使普通自动朗读关闭也播报），等待浏览器实际播放完成后关闭 ASR；普通结束回到已开启的本地唤醒待机，关闭监听则同时关闭唤醒并释放麦克风。结束语最多等待 15 秒，合成/播放失败仍关闭，侧栏保留结束语及语音错误。新会话/离开页面取消旧结束语，迟到回调不能关闭新会话。否定、询问用法、引用以及业务结束不匹配本地结束规则。
- 用户说“等等”等暂停指令后停止回答并等待；安静约 2 秒仍未恢复时询问一次“我在，还需要什么帮助吗？”，正在说话时推迟询问。等待期间可直接说新问题或“继续”，会取消计时并进入对话；结束或销毁会话也会取消计时。询问遵循自动朗读设置。
- 思考期衔接词：与云端模型并行向本地模型请求判断，输入当前问题、最近两条消息及用户配置的衔接词；模型选择文案或保持安静。正文 300ms 内未到达才尝试合成，`filler_audio` 不计入正文出字进度。正文先到则取消尚未完成的决策和衔接词合成，直接处理正文。决策失败、超时、服务忙、输入被模型截断或结果无效时保持安静；合成失败也只丢弃衔接词。
- 模型总等待最多 60 秒；每句 TTS 最多 30 秒；流式 HTTP 总生命周期最多 240 秒；下行背压超过 10 秒取消。断连会取消模型和合成。模型流不完整时保留部分文字并报错；重试从头替换回答。删除对话、离开页面、开始新会话会停止旧音频并取消旧请求；手动结束录音仍会提交尾句并播放回答；语音退出不提交尾句。
- `tts` 为 `{enabled:boolean,provider:"xiaomi",voice:string,filler:boolean,fillers:string[]}`，默认开启、小米、冰糖、开启衔接词；`filler` 控制思考期是否先播报衔接词，`fillers` 是用户在设置里维护的衔接词列表（最多 20 条、每条不超过 20 字，默认 5 条内置文案）。列表为空时思考期不开口；非空时本地决策选择列表中的文案或保持安静。中文音色：冰糖、茉莉、苏打、白桦；英文：Mia、Chloe、Milo、Dean。现阶段仅实现小米 `mimo-v2.5-tts` 预置音色，不提供尚未接入的供应商选项。小米密钥在设置弹框填写或通过 `MIMO_API_KEY` 提供，不能复用 DeepSeek 密钥。
- 前端通过 Web Audio 播放 PCM16，跨分片保留不足一个采样的字节，播放缓冲约 15 秒后施加背压。开始对话的点击会解锁播放；播放被浏览器限制时显示提示，文字照常返回。
- 回答文字随语音逐句、句内逐字展示，以 AudioContext 播放时间和实际音频时长估算进度，网络缓冲空档不推进；句子尚未合成完时按估计语速出字并保留尾部，收到 sentence_end 后按完整时长收尾。文字只向前增长，每句播完补齐，全部播放结束后补齐原文尾部。未开启语音、合成/播放失败时恢复文字流显示；打断停止声音和出字，迟到进度无效。完整模型文本单独保留用于后续上下文。此功能没有供应商逐字时间戳，属于句内近似同步。

```json
{"messages":[{"role":"user","content":"你好，请介绍一下你自己"}]}
```

### 音频与健康检查

- `GET /api/health`：`{status:"ok", service:"billiards_voice", backend:"express"}`。不代表云端或模型可用。
- `POST /api/voice/enhance`：multipart 文件字段 `audio`，返回单声道 48kHz PCM16 WAV；头含 `X-Sample-Rate: 48000`。缺文件 400，文件超过 32MB 为 413，模型/解码失败 422，同时只执行一次增强，忙碌 503。单条最多 10 分钟、处理最多 240 秒，断连终止 worker。失败统一 `{status:"error",error:"可读提示"}`。
- `WS /api/voice/asr/realtime`：仅接受 `ALLOWED_ORIGINS` 中的精确 Origin；每条连接独立生成 voice_id 与签名。

WS 下行：`ready` → 若干 `result` → `done`；任意阶段可能返回 `error` 并关闭。`result` 为 `{type:"result",index,text,final,speaker_segments:[{speaker_id,text,stable_flag}]}`。单句 final 来自 `slice_type=2`，整流 done 来自云端 `final=1`。多说话人片段完整保留。匿名分离使用 `speaker_diarization=1`，不传入声纹参数。

浏览器收到 ready 后，以实时速率上传 16kHz/单声道 PCM16，每 40ms/1280 字节，结束发送 `{"type":"end"}`，等待 done。鉴权/连接 10 秒、音频空闲 20 秒、结束等待 15 秒、单流最长 2 小时。积压时明确报错关闭，禁止无限缓存。

协议参考：[TRTC v3 实时识别](https://cloud.tencent.com/document/product/647/138784)。UserSig 不返回前端，日志不输出音频、识别文本、密钥或签名。

## 验证

`pnpm check`、`pnpm build`、`pnpm test`。集成测试用本地模拟腾讯云，验证签名、实时中间/最终结果、多说话人、结束帧、错误及断连释放。模型冒烟验证使用合成音频，无需上传用户录音。前端保留原来的独立构建检查。

## TTS 桥接与扩展

### 其他应用调用纯 TTS

`POST /api/tts` 接收 JSON `{text:string, voice?:string, stream?:boolean}`，只合成传入文本，不调用 LLM。`text` 必须非空，最多 16000 字符；`stream` 默认 `false`，必须是布尔值。`voice` 默认使用设置中的音色，可选冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean。共用 `MIMO_API_KEY`；设置中的 `tts.enabled` 仅控制对话自动播报，不影响显式调用纯 TTS。

- `stream:false`：等待合成成功后返回 `Content-Type: audio/wav` 的完整 WAV 二进制（PCM16 little-endian，24000Hz，单声道），可保存或作为 Blob 播放。失败不会返回不完整 WAV。
- `stream:true`：返回 `Content-Type: text/event-stream`，每帧 `data: <JSON>\n\n`。音频事件为 `{type:"audio",data:"<base64>",sampleRate:24000,channels:1,format:"pcm16"}`，按顺序解码、拼接 PCM 字节并播放；成功以 `{type:"done"}` 结束。PCM 块没有 WAV 文件头。失败以 `{type:"error",error:string}` 结束，不再发送 done；客户端必须检查终止事件，不能把断流当成功。
- 首个音频事件发出前的错误，两种模式均返回 JSON `{status:"error",error:string}`：参数错误 400、未配置密钥 503、供应商失败/超时 502、HTTP 总超时 504。流式调用应先检查 HTTP 状态和 Content-Type，再解析 SSE。使用 POST fetch 读取响应流，不能直接使用只支持 GET 的 EventSource。
- 每次供应商请求最多 30 秒，HTTP 总生命周期最多 60 秒，输出最多 32MB PCM；下行背压超过 10 秒会取消。客户端断连取消上游合成。两种模式内部均复用同一个流式供应商适配器。

完整音频调用示例：

```sh
curl --fail-with-body http://localhost:8020/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"欢迎使用台球助手","voice":"冰糖","stream":false}' \
  --output speech.wav
```

流式调用示例（查看 SSE，调用方负责解码 PCM 和播放）：

```sh
curl -N --fail-with-body http://localhost:8020/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"欢迎使用台球助手","voice":"冰糖","stream":true}'
```

默认仅监听 `127.0.0.1:8020`，同机应用可直接调用；其他浏览器应用可通过其后端或同源代理调用，目前没有新增跨域 CORS 支持。跨机器调用需部署方配置 HOST、网络入口及访问控制。此接口不提供调用方鉴权，不应直接作为公网服务暴露。

`streamSpokenReply(textStream, provider, voice, signal, emit)` 是业务编排，依赖 `TtsProvider.synthesize({text,voice,signal})`，不依赖小米字段。`createXiaomiTts` 实现该契约，将供应商 SSE/base64 转为统一 PCM16 音频块。HTTP 路由负责装配依赖，前端只认识归一化的 text/audio/error/done 事件。

这是“通过组合把业务抽象与供应商实现分开”的桥接思路，同时供应商模块使用适配器模式转换外部协议。桥接关注两侧可以独立变化；适配器关注不同接口如何兼容。当前不为了套用类图而预建多层抽象类。

未来接 MiniMax 时，新增一个实现 TtsProvider 的适配器，负责其密钥、音色、协议和音频格式转换；扩展设置校验和装配入口。模型客户端、短句编排和前端播放器不需要识别 MiniMax。若要使用持续追加文本的双向连接，可在有实际需求时扩展为会话契约；当前按句 synthesize 不承诺复用同一条双向连接。

## Silero、说话人门控与 Smart Turn

浏览器沿用原来 AudioWorklet 的 16kHz PCM 采集，不另开麦克风、不丢弃静音帧。`silero.worker.ts` 在专用 Worker 中运行 Silero v5 ONNX，保留 512 采样帧、64 采样上下文和循环状态；连续 5 个正帧（160ms）认为开口，10 个低概率帧（320ms）认为静音。`sileroActivity.ts` 管理概率迟滞、有限待处理帧和释放。模型资源随 pnpm 依赖固定，并通过 prepare-vad/predev/prebuild 复制到忽略的 public/vad；生产构建包含这些本地资源，不请求 CDN。加载或运行失败时页面明确提示降级到已有能量活动检测。

开口先压低播报音量；当前交互人的稳定有效 ASR 或明确呼叫才确认停播，取消旧 LLM/TTS。`audience.ts` 要求 speaker_id > 0 且所有同人片段 stable_flag=1，未知/不稳定说话人暂等。页面手动开始或本地唤醒成功后，首个稳定说话人直接建立交互并可正常交谈；未声明入口的调用方首次仍需以“你好助手/助手/台球助手”等开头明确呼叫；其他人明确呼叫可切换。其他人的台球聊天不会仅因台球关键词就获准打断。当前交互人的台球问题、明确请求、上下文追问的简短回答可以进入对话；“停止、等一下、我接个电话”等会停播并进入等待，继续/重新呼叫后恢复。无交互且未播报超过 120 秒后解除交互人绑定。这是保守的称呼、领域词和对话上下文规则，不是通用的“是否对助手说话”语义分类模型，匿名说话人也不是固定身份。

多说话人全部保留在原始记录，门控按每个说话人分组返回独立决策；一次多人同时呼叫时只接受最终选定交互人。前端清理接管前尚未提交的其他人片段，避免拼成一个问题。已提交 ASR 分组的迟到修订不会再次发起回答。回声过滤继续只使用实际开始播报的短句和尾音窗口；未来排队音频不作为回声依据。候选活动没有有效 ASR 时最多 1.5 秒恢复音量。

Smart Turn worker 在首次启用话轮协议的 ASR 连接时启动并预热，之后各会话共用同一个 CPU 进程；每会话仅保留最近 8 秒 PCM。VAD 静音后提交一次快照，输出结束概率；恢复说话会取消旧 epoch，迟到结果作废。全局最多 4 个待推理请求，单次超时 1.2 秒；启动上限 30 秒，故障后冷却 30 秒再尝试启动。未就绪、忙碌或故障返回 rules 模式；前端明确显示规则兜底。模型无逐次云 API 费用，运行时不下载模型。新语音、取消、断连、服务关闭均释放对应状态；服务器关闭会结束常驻 worker。

### 本机运行与迁移

本机已创建独立 server/.venv（Python 3.13）并安装经过验证的版本。新机器可在 server/ 下执行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r workers/requirements-turn.txt
.venv/bin/python scripts/download-turn-model.py
```

下载脚本固定 Pipecat Smart Turn v3.2 CPU revision f766f81，并校验 SHA256；模型文件保存在忽略的 server/models。环境变量 SMART_TURN_ENABLED 默认 true，SMART_TURN_PYTHON 默认 server/.venv/bin/python，SMART_TURN_MODEL 默认 server/models/smart-turn-v3.2-cpu.onnx。所有启停仍通过 Spark；这是独立推理 worker，不依赖旧 FastAPI。

前端安装依赖后执行 pnpm prepare-vad 可准备本地 Silero/WASM 资源；pnpm dev、pnpm build 已自动执行。Silero 模型来自 @ricky0123/vad-web 0.0.31，ONNX Runtime Web 固定 1.22.0。

### ASR 话轮协议

对话页连接 `/api/voice/asr/realtime?turns=1&entry=manual`（手动开始）或 `entry=wake`（本地唤醒成功）。两种入口都已激活交互，无需 ASR 再次识别呼叫词；首个稳定说话人成为交互人，后续保留旁人、等待/继续及回声门控。未传 entry 或传未知值保持明确呼叫规则。不带 turns=1 的调用者保持原来的纯 ASR 协议。

对话页只展示通过说话人交互门控的文字；`speaker_unstable` 等待确认的结果、旁人和回声不展示。通过门控后的中间文字持续更新，仍须最终结果和说完判断才提交。提交后主文字区保留问题，直至回答开始显示；“识别中”“思考中”等状态统一显示在右上角状态栏，不显示计时。

新增上行：
- `{type:"activity",speaking:boolean,epoch:number}`：每次开口递增 epoch，结束静音沿用相同 epoch；必须按开始/结束顺序发送。
- `{type:"playback",active:boolean,references:string[],question:string}`：当前播报状态、已开始播放的参考短句、最近展示的助手问句。前端限制在 4096 字节消息上限内，约每 250ms 更新；用于门控和回声防护，不作为用户输入。

新增下行：
- `{type:"interaction",index,final,owner?,parts:[{id,speakerId,text,action,reason}]}`：action 为 accept/stop/ignore/wait/end_conversation/disable_listening。只将 accept 片段送入模型对话；stop 直接取消回答；两种结束动作仅在 final 时播报结束语并关闭，不请求 LLM。id 是会话内候选编号，原始 index 保持 ASR 分组；原始 result 和全部 speaker_segments 仍原样下发并保留。
- `{type:"endpoint",epoch,probability?,mode:"model"|"rules"}`：只对匹配当前 epoch 的静音状态生效。probability 为说完概率，不是台球业务意图置信度。

### 验证与限制

默认测试模拟云端和模型，不采集用户音频。`node --experimental-strip-types scripts/check-turn-model.ts` 使用合成语音有限运行真实 Smart Turn、输出本机推理耗时，结束即关闭进程。

Chrome 本地测试页（test/ 不进入生产构建）：
- `/test/browser-silero.html`：真实 Silero/WASM + 固定合成语音/静音。
- `/test/browser-asr-silero.html`：真实 AudioWorklet 和 Silero，经页面内模拟 WebSocket 验证 PCM、活动控制、门控/模型结果、flush 与关闭；无真实麦克风、无云调用。
- `/test/browser-turn-taking.html`：真实 Web Audio 停播/降音量，模拟文字和音频事件。

通用模型并非台球场景专门训练；领域门控仍是可审查规则，球房背景人声、音乐、远场收音及 ASR 说话人稳定性需要现场调优。完全相同的复述与回声、当前交互人对旁人说的同领域话语，不能保证仅凭这些信号准确区分。

模型来源及许可：[Silero VAD（MIT）](https://github.com/snakers4/silero-vad)、[Pipecat Smart Turn（BSD-2-Clause）](https://github.com/pipecat-ai/smart-turn)、[ONNX Runtime（MIT）](https://github.com/microsoft/onnxruntime)。

## 浏览器本地 KWS 唤醒

对话页点击“开启语音唤醒”并授权麦克风后，浏览器 Worker 使用 sherpa-onnx 的 Wenetspeech 3.3M 中文 int8 开源模型识别唤醒词。默认是“你好助手”和“台球助手”；设置中的“唤醒词”可编辑中文词及其拼音音素，最多 10 项，保存在当前浏览器，下次开启时生效。模型不做通用中文转拼音，需为自定义词填写音素，格式可参考默认项。待机只运行本地 KWS，不创建 ASR WebSocket，也不保存待机录音；浏览器保留最近 2 秒 PCM，触发后将这段短预录音与连接期间的新语音按顺序交给 ASR。连接缓冲最多 6 秒，超出上限明确报错；补发每 20ms 最多两帧，存在背压和队列上限，避免无限积压。预录音只交接一次，补发期间对话层暂停说完判断。

唤醒成功后先播放同源静态音频 `frontend-test/public/audio/wake-ack.wav`（小米冰糖音色，温柔轻快的“我在”，约 0.72 秒）。开启唤醒的点击操作预先解锁共享 Web Audio 并加载、解码音频；严格等待实际播放 ended 才开始建立 ASR 和恢复音频缓存。应答播放期间暂停追加麦克风帧，保留此前的唤醒预录音，避免把提示音送去识别；关闭唤醒、离开页面会停播并释放节点，异步完成不会再启动 ASR。资源加载或播放失败会明确提示，播放失败时回到待机。

唤醒进入原有 Silero → ASR 说话人门控 → Smart Turn → DeepSeek → 小米 TTS 链路。KWS 负责进入对话，不证明说话人身份；唤醒成功后由 ASR 中首个稳定说话人建立交互，无需再次说唤醒词。60 秒没有有效交互且没有待处理问题、说话或播报时结束当前对话并回到本地待机；手动结束也返回待机。播报/识别收尾期间暂停待机 KWS，并留 1.2 秒尾音窗口。开启唤醒后仍可手动开始，关闭唤醒释放待机麦克风；正在进行的对话可继续手动结束。

新机器安装前端依赖后，在 frontend-test 执行 `pnpm setup-kws`。下载器固定官方 sherpa_onnx_web 2.0.1 和 2024-01-01 中文 KWS 模型，校验两份压缩包 SHA256，仅提取白名单文件，保存许可及逐文件清单到忽略的 public/kws。`pnpm build` 校验资源，生产构建由同源站点提供模型、JS 与 WASM，不请求 CDN。首次开启需加载约 21 MB 本地资源；失败时提示错误，仍可手动对话。模型及 runtime 的 Apache-2.0 说明随资源保留。

本地验证页（无真实麦克风、无云调用）：`/test/browser-kws.html` 验证普通合成语音不触发及真实中文唤醒；`/test/browser-wake.html` 验证真实 AudioWorklet、播报抑制、预录音单次交接、重复唤醒与手动开始；`/test/browser-asr-silero.html` 同时验证预录音进入模拟 ASR 后的顺序、Silero 与释放。`/test/browser-wake-response.html` 挂载真实对话页，以合成音轨触发 KWS、真实播放本地提示音并断言播放结束前不创建模拟 ASR 连接。合成样本通过不代表球房误唤醒率，需要在音乐、远场及多人聊天环境实测调阈值。网页须在 localhost/HTTPS、有麦克风权限且保持运行；浏览器休眠或关闭页面后无法持续唤醒。

来源：[sherpa-onnx KWS](https://k2-fsa.github.io/sherpa/onnx/kws/)、[官方中文模型](https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models)、[官方 Web runtime](https://pub.dev/packages/sherpa_onnx_web/versions/2.0.1)。

## 回答语气

模型请求会在已保存的系统提示词后附加语音回答规则，已有 DeepSeek 配置也会生效。约定 `〖语气：温柔、语速稍慢〗正文`，开头标记设定整体语气，句首再次标记可切换后续语气。后端增量提取标记（支持跨 SSE 分片），文字事件、音频事件中的 text、后续上下文与非流式返回只含正文。无标记时沿用供应商默认表达；未闭合或超长保留标记丢弃，普通括号保留。

桥接层在语气变化时刷新待播短句，为每句保存独立 `SpeechRequest.style`；小米适配器将其转换为 `messages` 中可选的 `role:user` 自然语言风格指令，正文仍为 `role:assistant`。语气标记不占展示/播放进度偏移。“嗯、呀、呢”等实际语气词属于正文，会展示并朗读。纯 `/api/tts` 保持原契约。

依据：[小米 MiMo 风格控制](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)。具体表现仍需实际试听。

## 本地衔接词判断

单个“嗯”及“嗯……”衔接词合成时附带轻柔思考、连续拖长约 0.8–1 秒的语气指令，尾音平缓收住；实际时长由 TTS 生成结果决定。
“啊”用轻声领会的语气，“嗯嗯”用温和倾听应和的语气，“我想想”带稍慢的思考感，“让我捋一捋”平和地梳理思路，“稍等一下”温和地请对方等待。选择模型使用相同的场景说明区分这些词；无省略号和常见句末点号的写法也适用。其他自定义衔接词使用按词义自然表达的通用语气指令。

通过 Spark 启动根目录 `model-service/`，模型预热完成后，Express 使用 `POST /v1/decisions` 判断是否播放设置中的文案。模型不生成正文，也不修改对话中的语气标记。

- `MODEL_DECISION_ENABLED`：默认开启，设为 `false` 时不播放思考期衔接词。
- `MODEL_SERVICE_URL`：默认 `http://127.0.0.1:8030`，只允许本机 HTTP origin。
- `MODEL_DECISION_TIMEOUT_MS`：默认 600ms，允许 50–5000ms。超时、取消、503、429、异常响应及上下文截断都降级为安静，不等待重试。

候选最多 20 条，服务端按每组最多 7 条加“保持安静”分组，一次请求最多 3 个问题。每组选出的文案相对本组“保持安静”的概率比用于候选间排序；这只是启发式排序，不是跨组校准的置信度。上下文只保留当前问题前 800 字和最近两条消息各 250 字；默认文案附带用途描述，自定义文案按文本语义判断。概率没有按本业务校准，实际匹配质量需听测和样本评估。

页面生命周期验证：`http://localhost:5178/test/browser-session-control.html`，点击验证按钮；合成音轨、模拟 ASR/TTS 和真实 Web Audio 验证结束语播放后才关闭识别、释放麦克风及忽略迟到识别，无真实采音或云请求。
