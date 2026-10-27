# AI 语音助手模块 — 接口对接文档

> 版本: v1.3 · 更新: 2026-09-24（句子级流式 TTS：新增 `audio` 事件，文字打字机与语音播报同步）

## 1. 功能概述

AI 语音助手是台球教学平台的自然语言交互入口，全链路为：

## 3. 接口总览

统一服务入口 `run_vision_server.py`（本地默认端口 **8999**，Docker 8000），已开 CORS（`*`）。
`/api/voice/text`、`/api/voice/chat` 为 **SSE 流式**（`text/event-stream`，见 §4）；其余接口响应 `Content-Type: application/json; charset=utf-8`。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/voice/text` | 文本输入 → 流式全链路（跳过 ASR，打字机） |
| POST | `/api/voice/chat` | 音频文件上传 → ASR + 流式全链路（打字机） |
| POST | `/api/voice/asr` | 轻量 ASR（只转文字，边说边识别） |
| POST | `/api/voice/tts` | 纯 TTS 合成（试听/自定义播报，不走 LLM） |
| POST | `/api/voice/execute` | 直接执行工具（跳过 LLM，供前端按钮） |
| GET | `/api/voice/status` | 语音服务健康检查 |
| GET | `/api/voice/audio/<filename>` | 获取 TTS 缓存音频文件 |

## 4. 流式响应契约（SSE 事件流）

`/api/voice/text`、`/api/voice/chat` 返回 **SSE**（Server-Sent Events）：`Content-Type: text/event-stream`，chunked 逐帧推送，**每帧 = `data: {json}\n\n`**（SSE 规范，事件以空行分界；事件类型在 JSON 的 `type` 字段），用于前端打字机渲染。服务端阻塞环节（LLM/TTS）不影响同进程其他请求。

### 4.1 事件协议

| 事件 | 结构 | 说明 |
|---|---|---|
| `asr` | `{"type":"asr","text":"识别文本"}` | 仅 `/api/voice/chat`：ASR 完成即推，前端可提前展示"已识别： …" |
| `stage` | `{"type":"stage","text":"阶段提示"}` | 阶段进度：`正在检索知识库 ...` → `正在思考 ...` → `正在生成击球方案 ...` → `正在执行工具 ...`（`正在合成语音 ...` 仅流式 TTS 关闭/回退时出现，见 §7.4） |
| `delta` | `{"type":"delta","text":"增量"}` | 主 LLM 回复增量（打字机逐字追加）。有工具调用时主 LLM 不产文本，本事件缺省 |
| `audio` | `{"type":"audio","url":"...","text":"...","duration_ms":int,"index":int}` | **句子级 TTS 音频段**（§7.4）：主 LLM 每凑够一句立即合成下发，与 `delta` 交错出现；`index` 从 0 严格递增，前端按序播放、文字跟播放进度打字。`TTS_STREAM_ENABLED=0` 时不产生本事件 |
| `done` | `{"type":"done","result":{...}}` | 最终结果，`result` 为 VoiceResult（§4.3），**必有且为最后一帧** |
| `error` | `{"type":"error","error":"..."}` | 生成器本体异常兜底（流已打开无法改状态码时）。链路内业务失败不产本事件，走 `done(result.status="error")` |

### 4.2 帧序列示例

```
POST /api/voice/text {"text":"这球怎么打"} → 逐帧:

data: {"type":"stage","text":"正在检索知识库 ..."}

data: {"type":"stage","text":"正在思考 ..."}

data: {"type":"delta","text":"建议打"}

data: {"type":"delta","text":"3号球进右中袋，"}

data: {"type":"audio","url":"/api/voice/audio/1a2b3c4d5e6f7a8b.mp3","text":"建议打3号球进右中袋，","duration_ms":2400,"index":0}

data: {"type":"delta","text":"高杆跟杆。"}

data: {"type":"audio","url":"/api/voice/audio/9f8e7d6c5b4a3f2e.mp3","text":"高杆跟杆。","duration_ms":1100,"index":1}

data: {"type":"done","result":{"status":"ok","reply":"建议打3号球进右中袋，高杆跟杆。","audio":{"streamed":true,"segment_count":2,"audio_url":""},"latency_ms":{...}}}
```

- `/api/voice/chat` 在最前面多一帧 `{"type":"asr","text":"..."}`；
- **流式 TTS 开启时**：`audio` 段全部在 `done` 之前下发完毕（流收尾前服务端会等剩余句子合成完）；所有 `audio.text` 按序拼接 == `reply`（单句合成失败时该句缺段，文字照常）；`done` 前不再有 `stage("正在合成语音 ...")`，且 `result.audio.audio_url` 为空（不重复播整段）；
- **流式 TTS 关闭**（`TTS_STREAM_ENABLED=0`）或纯工具调用无正文时：回退旧模式 `stage(合成语音) → done(result.audio.audio_url 有值, 整段播)`；
- 工具调用场景：主 LLM 口头说明的 `delta`/`audio` 照常，之后 `生成击球方案 → 执行工具 → done`（`done.result.tool_call/execution_result` 见 §6）；
- 降级（LLM 不可达等）：`stage → done(result.status="error")`，无 `delta`，已下发的 `audio` 段不撤销；
- 前端消费：按空行（`\n\n`）分帧 → 取 `data:` 行 → `JSON.parse` → 按 `type` 分发；`audio` 段按 `index` 顺序播放、`delta` 文本显示上限跟随播放进度（voice.js 同步控制器实现）；`done` 后渲染完整结果（工具卡片/RAG/耗时）。POST 请求不能用原生 `EventSource`，用 `fetch` + `ReadableStream` 逐帧解析（voice.js 实现）。

### 4.3 done.result 字段（VoiceResult，`voice/pipeline.py: to_dict()`）

```json
{
  "status": "ok",
  "asr_text": "这球怎么打",
  "rag_context": [
    {"content": "知识片段...", "source": "rules.md", "category": "rules", "score": 0.6812}
  ],
  "tool_call": {"name": "get_shot_recommendation", "arguments": {"balls": [...]}},
  "structured_data": {"instruction": "...", "input": "...", "output": {...}},
  "execution_result": {"status": "ok", "shot": {...}, "coach": {...}},
  "reply": "建议打 3 号球进右中袋, 高杆跟杆...",
  "audio": {
    "status": "ok", "streamed": true, "segment_count": 3, "audio_url": ""
  },
  "errors": [],
  "latency_ms": {"asr": 480, "rag": 90, "main_llm": 1200, "secondary_llm": 850, "execute": 15, "tts": 1750, "total": 2650}
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | `ok` 全链路成功 / `partial` 工具执行失败但链路完成 / `error` 链路中断（ASR 或主 LLM 失败） |
| `asr_text` | string | ASR 识别文本（`/api/voice/text` 时等于输入文本） |
| `rag_context` | array | RAG 召回片段 `[{content, source, category, score}]`，降级时为空数组 |
| `tool_call` | object\|null | 主 LLM 决定调用的工具 `{name, arguments}`；纯问答时 `null` |
| `structured_data` | object\|null | 次级 LLM 产物 `{instruction, input, output}`；`output` 为符合 Schema 的可执行参数；失败降级时 `null` |
| `execution_result` | object\|null | 工具执行结果（结构见 §6）；未调工具时 `null` |
| `reply` | string | 主 LLM 最终自然语言回复（必回，错误场景下为友好提示文案） |
| `audio` | object\|null | TTS 播报结果。**流式模式**（§7.4 开启且产过 `audio` 事件）：`{"status":"ok","streamed":true,"segment_count":N,"audio_url":""}`，音频已随流分段下发，勿再播整段；**非流式/回退模式**：SpeakResult（§7.2，`audio_url` 有值）。TTS 禁用/跳过/LLM 失败时 `null` |
| `errors` | array[string] | 非致命降级警告（RAG 失败、次级 LLM 失败、TTS 失败等） |
| `latency_ms` | object | 各环节耗时：`asr/rag/main_llm/secondary_llm/execute/tts/total`（未发生的环节缺省）。流式模式下 `tts` 为首句提交到最后一段合成完成的总耗时 |

**对接建议**：前端优先渲染 `reply` + `audio.audio_url`（有值则播报，流式模式下为空串改播 `audio` 事件段）；`tool_call`+`execution_result` 用于工具卡片展示；`errors` 用于降级提示条；`latency_ms.total` 用于耗时标注。

## 5. 接口详情

### 5.1 POST /api/voice/text — 文本全链路（流式）

跳过 ASR，直接以文本走 RAG → LLM（流式）→ 工具 → TTS。

**请求**（`application/json`）:

```json
{"text": "帮我推荐一杆清台路线"}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 用户指令文本，strip 后非空 |

**响应**: 200 + **SSE 事件流**（§4）：`stage(检索) → stage(思考) → delta×N（与 audio×N 交错，§7.4）→ done(VoiceResult)`；纯问答时 `delta` 拼接 == `done.result.reply`（`audio.text` 拼接亦然）；主 LLM 失败时无 `delta`/`audio`，`done.result.status="error"`。

**错误**:

| 状态码/事件 | 场景 |
|---|---|
| 400 | JSON 解析失败 / 缺少 `text` 字段（普通 JSON 响应，流未打开） |
| 200 流内 `done(result.status:"error")` | 主 LLM 调用失败（`reply` 为友好提示, 无 `audio`） |
| 200 流内 `error` 事件 | 生成器本体异常兜底 |

### 5.2 POST /api/voice/chat — 音频上传全链路（流式）

上传录音文件，服务端 ASR 转文本后走流式全链路。**前端主通道**（按住麦克风说完松开）。

**请求**（`multipart/form-data`）:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `audio` | file (wav) | 二选一 | 16kHz 单声道 16bit PCM WAV（见 §8） |
| `text` | string | 二选一 | 备用文本：音频识别失败时使用；两者都无则 400 |

实现细节（对接方需知）：
- 服务端 multipart 解析对二进制字段只剥离协议 CRLF，**不做 rstrip**，PCM 数据完整（[web/routes.py `read_multipart`](file:///d:/billiards_core/web/routes.py)）。
- `text` 备用文本仅在音频缺失或 ASR 失败时生效。

**响应**: 200 + **SSE 事件流**（§4）：`asr(识别文本) → stage → ... → done(VoiceResult 含 asr_text)`。ASR 失败时无 `asr` 事件，`done.result.status="error"`、`reply` 为"抱歉, 没听清您说的..."、无 `audio`。

**错误**: 400（非 multipart / 缺 boundary / audio 与 text 均缺失，普通 JSON 响应）、流内 `error` 事件。

### 5.3 POST /api/voice/asr — 轻量 ASR

只做语音转文字，不走 RAG/LLM。供**录音过程中增量识别**（边说边出字）与**唤醒词检测**轮询。

**请求**（`multipart/form-data`）: `audio` = wav 文件（必填）。

**响应**:

```json
{"status": "ok", "text": "这球怎么打"}
```

| 场景 | 返回 |
|---|---|
| 正常识别 | 200 + `{"status":"ok","text":"..."}` |
| 静音段/识别为空 | 200 + `{"status":"ok","text":"","warning":"ASR 识别结果为空..."}`（前端应跳过空文本） |
| 缺 audio 文件 | 400 |
| ASR 服务不可用 | 500 + `{"status":"error","error":"..."}` |

**前端节奏参考**（voice.js）: 录音中每 ~2s 取增量 chunk 发一次；唤醒监听每 2.5s 送最近 ~3s 滚动音频，命中唤醒词后停止轮询、转入指令录音。

### 5.4 POST /api/voice/tts — 纯 TTS 合成

不走 LLM，文本直接合成音频。用于试听、自定义播报。

**请求**（`application/json`）:

```json
{
  "text": "您好, 我是中式八球 AI 智能教练",
  "voice": "zh-CN-YunxiNeural",
  "rate": "+10%",
  "volume": "+0%"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `text` | string | 是 | 合成文本 |
| `voice` | string | 否 | 覆盖发音人（§7.1） |
| `rate` | string | 否 | 覆盖语速 |
| `volume` | string | 否 | 覆盖音量 |

**响应**: 200 + SpeakResult（§7.2）。空 `text` → 400；合成异常 → 500。

### 5.5 POST /api/voice/execute — 直接执行工具

跳过 LLM 意图判断，直接按给定参数执行工具。供前端快捷按钮（"标准开局"等）。

**请求**（`application/json`）:

```json
{"tool_name": "set_table_layout", "arguments": {"layout_type": "default"}}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tool_name` | string | 是 | 工具名（§6 枚举） |
| `arguments` | object | 否 | 工具参数，默认 `{}` |

**响应**: 200 + 工具执行结果（结构见 §6，与 VoiceResult 的 `execution_result` 相同）。`status:"error"` 表示业务失败（如参数缺失、规划器异常），HTTP 仍为 200。

**错误**: 400（缺 `tool_name` / JSON 解析失败）、500。

### 5.6 GET /api/voice/status — 健康检查

**响应**:

```json
{
  "status": "ok",
  "asr_endpoint": "http://192.168.1.113:8005/asr",
  "main_llm_base_url": "http://192.168.1.113:8001/v1",
  "main_llm_model": "qwen",
  "secondary_llm_base_url": "http://192.168.1.113:8002/v1",
  "embedding_base_url": "http://192.168.1.113:8003/v1",
  "embedding_model": "bge-m3",
  "rag_collection": "billiard_knowledge",
  "rag_chunks": 42,
  "tts": {
    "available": true, "enabled": true, "backend": "auto",
    "voice": "zh-CN-XiaoxiaoNeural", "available_backends": ["edge", "pyttsx3"],
    "cache_files": 18, "cache_bytes": 512000, "cache_dir": "output/voice_cache"
  }
}
```

对接方可据此渲染服务状态面板：`rag_chunks`=0 提示入库，`tts.available`=false 时禁用试听按钮。

### 5.7 GET /api/voice/audio/<filename> — TTS 缓存音频

播放 `audio_url` 指向的音频文件。

- `filename` 严格匹配 `[a-f0-9]{16}\.(mp3|wav)`（文本 hash 命名），否则 400；
- 路径穿越（`..`）→ 403；文件不存在 → 404；
- 成功: `Content-Type: audio/mpeg|audio/wav`，`Cache-Control: public, max-age=86400`（hash 为内容指纹，可放心长缓存）。

## 6. Function Calling 工具契约

主 LLM 通过 OpenAI Function Calling 从 3 个工具中选择（`voice/tools.py`）。工具执行器由 `web/coach.py` 依赖注入回调（planner/simulator/layout_builder），仅取**第一个** tool_call 执行。

### 6.1 get_shot_recommendation — 击球方案推荐

触发语: "这球怎么打"、"帮我推荐"、"清台路线"。

**参数**（主 LLM arguments / 次级 LLM output 合并，次级优先）:

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `balls` | array | 是 | 台面球列表 `{id, x, y, alive}`；id=0 母球, 1-15 目标球 |
| `ball_type` | string | 否 | `auto`(默认,按 1-7) / `solids` / `stripes` / `eight` |
| `call_pocket` | int | 否 | 8 号指定袋口, -1=关闭（袋口索引见 §6.4） |

**执行结果**（推荐引擎为 `billiards_recommend.handle_rl_suggest`：RL 推理优先, 模型未加载时包内自动回退几何规划）:

```json
{
  "status": "ok",
  "shot": {
    "target_ball": 3, "pocket_idx": 5, "cut_angle": 24.6,
    "shot_dist": 0.81, "pocket_dist": 0.62,
    "makeability": 0.72, "score": 0.61,
    "ghost_ball_pos": [0.12, 0.34], "cue_at_contact": [0.12, 0.34],
    "contact_point": [0.10, 0.33], "aim_dir": [0.31, 0.95], "target_dir": [0.4, 0.9],
    "obstacles": [7], "obstacle_count": 1,
    "desired_cue_pos": [0.05, 0.20], "separation_dir": [0.8, 0.6],
    "hit_point": [0.31, 1.01],
    "force_newtons": 67.4, "strike_dx": 0.0, "strike_dy": 0.04,
    "ball_dynamics": {"v_0": 1.65, "omega_0": 57.9, "n_0_rpm": 552.6, "x_slide": 0.052, "F_avg": 67.4}
  },
  "coach": {
    "headline": "打 3 号球进 右中 袋",
    "tactic_category": "offense", "tactic_label_zh": "稳定进攻",
    "stroke": "高杆跟杆", "stroke_type": "撮", "stroke_type_color": "#22c55e",
    "all_strokes": [{"name_zh": "撮", "name_en": "...", "color": "...", "selected": true, "...": "..."}],
    "power_zh": "中力", "force_newtons": 67.4, "dx": 0.0, "dy": 0.04,
    "separation_angle": 96.3, "makeability": 0.72,
    "target_ball": 3, "pocket_name": "右中", "pocket_idx": 5, "risk": "中低",
    "why": "切球角度约 25°, ...", "warnings": ["线路上有 7 号球, ..."],
    "next_tip": "击球后母球预期停留 (x=+0.05, y=+0.20) m, ...",
    "shot_geom": {"target_ball": 3, "pocket_idx": 5, "...": "..."}
  },
  "alternatives": [{"target_ball": 11, "pocket_idx": 1, "makeability": 0.58, "...": "..."}],
  "clearTablePlan": [{"shot": {...}, "coach": {...}}],
  "summary": "共规划 5 杆清台方案, 首杆 3 号 → 右中 袋, 综合进球概率 68%。",
  "tableInfo": {
    "length": 2.54, "width": 1.27, "ballRadius": 0.0285,
    "remainingBalls": 9, "remainingIds": [1,2,3,...], "eightBallReady": false,
    "ballType": "mixed", "cuePosition": [0.0, 0.9525]
  }
}
```

- `shot` 为首杆主推荐（含几何 + 推断的 `force_newtons/strike_dx/strike_dy`）；`clearTablePlan` 为最多 8 杆的完整清台序列；`alternatives` 为首杆备选（至多 3 个）。
- 找不到母球/目标球/合法方案: `{"status":"error","error":"...","shots":[]}`。

### 6.2 simulate_shot — 击球仿真参数生成

触发语: "模拟一下"、"看下轨迹"、"演示"。

**参数**（全部必填）: `balls`、`target_ball_id`(1-15)、`pocket_idx`(0-5)、`force_newtons`(25-100)、`strike_dx`/`strike_dy`(-0.1~0.1)。

**执行结果**: 本工具只做**参数校验与透传**，真实 PyBullet 仿真由前端拿到参数后调 `POST /api/simulate_trajectory`（详见 api_yolo.md 体系）：

```json
{"status": "ok", "message": "已生成仿真参数, 请在前方页面查看轨迹", "params": {…原参数…}}
```

缺任一必填参数: `{"status":"error","error":"缺少参数: xxx"}`。

### 6.3 set_table_layout — 摆球局

触发语: "标准开局"、"随机球局"、"重置"。

**参数**: `layout_type`: `default`/`rack`（标准三角阵, 母球 D 区 (0, +0.9525), 1 号球 foot spot (0, -0.635)）或 `random`（母球 D 区 + 1-15 随机散落, 最小间距 2.2r）。

**执行结果**:

```json
{"status": "ok", "layout_type": "default", "balls": [{"id": 0, "x": 0.0, "y": 0.9525, "alive": true}, ...]}
```

### 6.4 袋口索引表（工具参数共用）

| 索引 | 名称 | 坐标 (x, y) | 类型 | 半径 |
|---|---|---|---|---|
| 0 | 左上袋 | (-0.635, +1.27) | corner | 0.065 |
| 1 | 右上袋 | (+0.635, +1.27) | corner | 0.065 |
| 2 | 右下袋 | (+0.635, -1.27) | corner | 0.065 |
| 3 | 左下袋 | (-0.635, -1.27) | corner | 0.065 |
| 4 | 左中袋 | (-0.655, 0.0) | side | 0.075 |
| 5 | 右中袋 | (+0.655, 0.0) | side | 0.075 |

坐标系: x=短边 ±0.635, y=长边 ±1.27, 原点台面中心, 单位米, 球半径 0.0285（与 api_yolo.md / api_exam.md 契约一致）。

## 7. TTS 播报体系

### 7.1 后端与发音人

| 后端 | 格式 | 依赖 | 特点 |
|---|---|---|---|
| `cosyvoice` | wav | CosyVoice2 自托管服务（`deploy/cosyvoice_server.py`, 8006 端口, 需 GPU） | 音质最好, 首选 |
| `edge` | mp3 | `pip install edge-tts`（联网） | 中文自然, 单次 0.5-2s; 微软端周期性 403 拦截 |
| `melo` | wav | MeloTTS 本机服务（`deploy/melo_server.py`, 8007 端口, `models/melo/venv` 独立环境） | MIT 开源免费, 纯 CPU 实时, 断网可用, 音质远好于 pyttsx3 |
| `pyttsx3` | wav | Windows SAPI5（离线） | 最后兜底, 声音机械 |

`TTS_BACKEND`（默认 `edge`）可选 `cosyvoice` / `edge` / `melo` / `pyttsx3` / `auto`。`auto` 及主后端失败后的降级顺序均为 **cosyvoice > edge > melo > pyttsx3**（`voice/tts_client.py` 注册表顺序）。常用发音人: `zh-CN-XiaoxiaoNeural`(女,默认) / `zh-CN-YunxiNeural`(男) / `zh-CN-YunjianNeural`(男,浑厚) / `zh-CN-XiaoyiNeural`(女,甜)。

**MeloTTS 服务启动**（edge 被微软 403 拦截时的本机兜底，模型 ~1GB 首次启动自动经 hf-mirror 下载）：

```bash
# Windows: deploy/start_melo.bat 或直接:
models/melo/venv/Scripts/python.exe deploy/melo_server.py --port 8007
# 环境变量: TTS_MELO_ENDPOINT (默认 http://127.0.0.1:8007) / MELO_HOME / HF_ENDPOINT
```

### 7.2 SpeakResult（`/api/voice/tts` 响应 / VoiceResult.audio）

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | `ok` / `error` / `skipped`（空文本或 TTS_ENABLED=0） |
| `audio_url` | string | 前端可访问 URL `/api/voice/audio/<hash>.mp3`，直接 `<Audio src>` 播放 |
| `audio_path` | string | 服务端绝对路径（排障用） |
| `backend` | string | 实际后端: `cosyvoice` / `edge` / `melo` / `pyttsx3` / `cache`（命中缓存） |
| `audio_format` | string | `mp3` / `wav` |
| `duration_ms` | int\|null | 估算时长 |
| `cached` | bool | 是否命中缓存 |
| `latency_ms` | int | 合成耗时 |
| `error` | string | 失败原因；降级成功时含主后端失败说明 |
| `text_hash` | string | 文本+发音参数的 16 位 hash，可用于重放 |

### 7.3 缓存机制与生命周期

- key = `sha256(text + voice + rate + volume)[:16]` — **不同发音参数不共享缓存**；
- 写盘为临时文件 + 原子 rename，避免读到半截；
- 相同文本重复播报 `latency_ms=0, backend="cache"`；
- **TTL 清理**（`TTS_CACHE_TTL_SECONDS`，默认 600s）：每次写入新缓存时同步删除 mtime 早于该时长的 `.mp3/.wav/.tmp` 文件（60s 节流，单文件失败跳过）——句子级流式 TTS（§7.4）会加速缓存产生，TTL 保证磁盘不无限膨胀。**超过 TTL 的 `audio_url` 请求将 404**（前端无重播场景，正常对话一轮远短于 TTL，不受影响）；设 `0` 关闭清理（旧版永不清理行为）。

### 7.4 句子级流式 TTS（打字机与语音同步）

`TTS_STREAM_ENABLED=1`（默认）时，流式接口（§4）在主 LLM 生成过程中**边生成边合成边下发**：

- **切分规则**（`voice/pipeline.py: _StreamSentenceSplitter`）：句末标点 `。！？!?…；;\n` 立即成句（连续标点归并）；连续 `TTS_STREAM_SEG_MAX_CHARS`（默认 40）字无句末标点 → 回退最后一个 `，、,` 软边界切分，无软边界则硬切；`<think>...</think>` 思考块不进 TTS（跨增量分片识别）。
- **合成调度**：单线程 executor 后台合成（段序 = 句序），不阻塞 `delta` 产出；每段经 `audio` 事件下发（字段见 §4.1），失败句静默跳段；流收尾前等全部句子合成完毕再发 `done`。
- **前端同步**（voice.js 同步控制器）：按 `index` 顺序播放音频段，文字显示进度 = 段内播放进度 × 段字符数（60ms tick 平滑推进）——**播到哪打到哪**。回退策略（音频与打字解耦）：首段 6s 超时仅文字转 `delta` 直出，**后续到达的音频段仍按序背景播报**（语音不丢）；仅用户手动停止 / 静音 / 浏览器 autoplay 被拒才彻底停止播放。缓存命中双格式兼容（`cosyvoice` 的 `.wav` 与 `edge` 的 `.mp3` 并存时按首选后端格式优先命中）。
- **回退开关**：`TTS_STREAM_ENABLED=0` 恢复旧模式（`done` 后整段合成整段播，`result.audio` 为 SpeakResult）。环境变量在 `deploy/docker-compose.yml` web 服务显式声明，改动后需重建容器生效。

## 8. 音频输入规范

| 项 | 要求 |
|---|---|
| 容器 | WAV (PCM) |
| 采样率 | **16000 Hz**（前端 `WavRecorder` 自动从设备采样率线性插值重采样） |
| 声道 | 单声道 |
| 位深 | 16 bit |
| 录音约束 | 关闭浏览器 `echoCancellation/noiseSuppression/autoGainControl`，保留原始波形 |
| 最短时长 | 前端建议 ≥0.3s（`blob.size / 32000` 估算秒数） |

## 9. 容错与降级矩阵

流式接口（§4）下，下表所有结果均通过最后一个 `done` 事件的 `result` 到达，中途不产生 `error` 事件（业务失败在链路内部消化）。

| 故障点 | status | 行为 | TTS |
|---|---|---|---|
| 未提供文本/音频 | `error` | `errors=["未提供文本或音频"]` | 无 |
| ASR 失败 | `error` | `reply`="抱歉, 没听清您说的..."（`/api/voice/asr` 则 200+空 text+warning） | 跳过 |
| RAG 失败 | `ok`/`partial` | `errors` 记"RAG 检索失败 (已降级)"，LLM 基于自身知识作答 | 正常 |
| 主 LLM 失败 | `error` | `reply`="AI 教练暂时开小差了: ..." | 跳过 |
| 次级 LLM 失败 | `ok`/`partial` | `structured_data=null`，用主 LLM arguments 执行工具 | 正常 |
| 工具执行失败 | `partial` | `errors` 记失败原因, `execution_result.status="error"` | 正常 |
| TTS 失败 | 不影响 | 整段模式: `audio.status="error"` + `errors` 记警告；流式模式: 失败句静默跳段（该句无 `audio` 事件，文字照常直出） | — |

## 10. 知识库入库

```bash
python -m voice.ingest                # 入库 voice/knowledge_base/*.md
python -m voice.ingest --rebuild      # 清空集合后重建
python -m voice.ingest --dir <path>   # 指定其他文档目录
```

分块规则（1 token ≈ 1.6 字符）: 规则类 `rules.md` 300-500 token/块 · 战术类 `tactics.md` 500-800 token/块 · 发力类 `strokes.md` 300-500 token/块 · 重叠 100-150 token。先按 Markdown 二/三级标题预切，再按 token 滑窗二次切（优先句号/换行断点）。

Docker 环境注意: web 容器需挂载 `../voice/chroma_db:/data/chroma_db` 共享本地入库数据。

## 11. 对接示例

### 11.1 curl

```bash
# 文本全链路 (SSE 流式, 逐帧输出事件; -N 关闭 curl 缓冲以实时看到打字机事件)
curl -N -X POST http://127.0.0.1:8999/api/voice/text \
  -H "Content-Type: application/json" \
  -d '{"text": "标准开局"}'

# 音频全链路 (SSE 流式)
curl -N -X POST http://127.0.0.1:8999/api/voice/chat \
  -F "audio=@input.wav"

# 轻量 ASR
curl -X POST http://127.0.0.1:8999/api/voice/asr \
  -F "audio=@partial.wav"

# 纯 TTS 试听
curl -X POST http://127.0.0.1:8999/api/voice/tts \
  -H "Content-Type: application/json" \
  -d '{"text": "您好, 我是 AI 教练", "voice": "zh-CN-YunxiNeural"}'

# 直接执行工具 (摆随机球局)
curl -X POST http://127.0.0.1:8999/api/voice/execute \
  -H "Content-Type: application/json" \
  -d '{"tool_name": "set_table_layout", "arguments": {"layout_type": "random"}}'

# 健康检查
curl http://127.0.0.1:8999/api/voice/status
```

### 11.2 Python（流式消费）

```python
import json
import requests

BASE = "http://127.0.0.1:8999"


def consume(resp):
    """SSE 事件分发: 空行分帧 → 取 data: 行 → 打字机累加 delta, audio 段按序收, done 返回完整结果。"""
    typed, result, last_err = "", None, None
    segments = []          # 句子级 TTS 音频段 [{url, text, duration_ms, index}]
    data_lines = []
    for raw in resp.iter_lines(decode_unicode=True):
        if raw == "":                       # 空行 = 一帧结束
            if data_lines:
                ev = json.loads("\n".join(data_lines))
                data_lines = []
                if ev["type"] == "asr":
                    print("识别:", ev["text"])
                elif ev["type"] == "stage":
                    print("阶段:", ev["text"])
                elif ev["type"] == "delta":
                    typed += ev["text"]      # 打字机增量
                elif ev["type"] == "audio":
                    segments.append(ev)      # 按到达序 = index 序播放
                elif ev["type"] == "done":
                    result = ev["result"]
                elif ev["type"] == "error":
                    last_err = ev["error"]
        elif raw.startswith("data:"):
            data_lines.append(raw[6:] if raw.startswith("data: ") else raw[5:])
    if last_err:
        raise RuntimeError(last_err)
    return typed, result, segments


# 文本全链路 (SSE: requests 流式逐帧迭代)
r = requests.post(f"{BASE}/api/voice/text",
                  json={"text": "帮我推荐怎么打"}, stream=True)
r.raise_for_status()
assert "event-stream" in r.headers["Content-Type"]
typed, data, segments = consume(r)
print(typed)                             # 打字机聚合文本
if data["tool_call"]:
    print(data["tool_call"]["name"], data["execution_result"]["summary"])
if segments:
    # 流式模式: audio 段按 index 顺序即为播报顺序 (边收边播可实现打字机同步)
    for seg in segments:
        audio = requests.get(BASE + seg["url"]).content
        print("段", seg["index"], seg["text"], f"({seg['duration_ms']}ms)")
elif data["audio"] and data["audio"]["audio_url"]:
    # 回退模式: 整段音频
    audio = requests.get(BASE + data["audio"]["audio_url"]).content

# 音频全链路 (同接口, 多一帧 asr)
with open("input.wav", "rb") as f:
    r = requests.post(f"{BASE}/api/voice/chat",
                      files={"audio": ("input.wav", f, "audio/wav")}, stream=True)
r.raise_for_status()
_, data, _ = consume(r)
print(data["asr_text"], data["reply"])
```

### 11.3 前端播放注意

- `audio_url` 是相对路径，需拼上服务地址（`audio` 事件的 `url` 同理）；
- 浏览器自动播放策略可能拦截，首次播放需在用户交互回调内触发（voice.js 静默忽略 `play()` rejection，并回退 `delta` 直出）；
- 相同 URL 正在播放时避免重复播（文本+音频双通道触发场景）；
- 流式模式段播放：按 `index` 顺序串行播放（上一段 `ended` 再播下一段），段间到达间隙需保持文字等待；播放进度可用 `HTMLAudioElement.currentTime / duration` 实时换算（`duration_ms` 仅作 metadata 未就绪时的估算初值）。

## 12. 错误码汇总

| HTTP | 场景 |
|---|---|
| 200 | 业务成功或链路内降级（流式接口看 `done` 事件 `result.status`；其余接口看 body `status`） |
| 400 | JSON/multipart 解析失败、缺少必填字段、非法音频文件名（流式接口此时尚未开流，返回普通 JSON） |
| 403 | 音频文件路径穿越 |
| 404 | TTS 缓存音频不存在 |
| 500 | 服务端未捕获异常（非流式接口 body 含 `traceback`；流式接口开流后异常以 `error` 事件送达） |

