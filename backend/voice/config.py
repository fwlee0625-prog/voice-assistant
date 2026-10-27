# -*- coding: utf-8 -*-
"""语音助手全链路配置.

所有模型服务地址走环境变量, 默认值对应 deploy/docker-compose.yml 暴露的端口.
模型本身由 vLLM (LLM / Embedding / Qwen3-ASR) 及 CosyVoice TTS 服务独立启动,
本模块只做客户端调用.
"""
import os
from dataclasses import dataclass, field


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


@dataclass
class VoiceConfig:
    # ============ ASR (Qwen/Qwen3-ASR-1.7B, 官方 vLLM 镜像) ============
    # vLLM OpenAI 兼容转写端点 (/v1/audio/transcriptions): multipart 音频上传,
    # 支持 prompt 上下文热词偏置 + language 强制语种 (chat completions 端点两者都不支持)
    asr_endpoint: str = field(
        default_factory=lambda: _env("ASR_ENDPOINT", "http://127.0.0.1:8005/v1/audio/transcriptions"))
    # 请求体 model 字段, 对应 compose 里 qwen-asr 服务的 --served-model-name
    asr_model: str = field(default_factory=lambda: _env("ASR_MODEL", "qwen3-asr"))
    # 强制语种 (ISO-639-1, 如 "zh"); 留空 = 自动检测。强制后输出纯文本, 固定中文场景更快更稳
    asr_language: str = field(default_factory=lambda: _env("ASR_LANGUAGE", ""))
    # 上下文/领域热词偏置 (进请求 prompt 字段 → 服务端 system turn, 提升领域词识别率)
    asr_context: str = field(default_factory=lambda: _env("ASR_CONTEXT", "你好 教练 台球"))
    asr_timeout: float = 30.0

    # ============ 主 LLM (Qwen2.5-7B-Instruct-AWQ, Function Calling) ============
    # main_llm_base_url: str = field(default_factory=lambda: _env("MAIN_LLM_BASE_URL", "http://192.168.1.168:8001/v1"))
    main_llm_base_url: str = field(
        default_factory=lambda: _env("MAIN_LLM_BASE_URL", "https://tokenhub.tencentmaas.com/v1"))
    # main_llm_model: str = field(default_factory=lambda: _env("MAIN_LLM_MODEL", "qwen"))
    main_llm_model: str = field(default_factory=lambda: _env("MAIN_LLM_MODEL", "deepseek/deepseek-flash"))
    # main_llm_api_key: str = field(default_factory=lambda: _env("MAIN_LLM_API_KEY", "EMPTY"))
    main_llm_api_key: str = field(
        default_factory=lambda: _env("MAIN_LLM_API_KEY", "EMPTY"))

    main_llm_timeout: float = 30.0
    main_llm_temperature: float = 0.3

    # ============ Qwen3 思考模式 (适用于主/次级 LLM) ============
    # False = 关闭思考模式: 不生成推理内容, 直接出答案 — 语音场景更快,
    # 也不会被 TTS 播报出来。无思考能力的模型会忽略参数, 无副作用。
    llm_enable_thinking: bool = field(
        default_factory=lambda: _env("LLM_ENABLE_THINKING", "0") in ("1", "true", "True", "yes"))
    # 关闭思考用的参数风格: "both" (默认) = chat_template_kwargs.enable_thinking
    # (自托管 vLLM Qwen3 模板开关) + thinking.type=disabled (云端网关/DeepSeek 系);
    # 单发某种: "qwen" / "deepseek"。切回自托管 vLLM 若报未知参数 400, 改 "qwen"。
    llm_thinking_style: str = field(
        default_factory=lambda: _env("LLM_THINKING_STYLE", "both"))

    # ============ 次级 LLM (Qwen2.5-7B-Instruct-AWQ 4bit, 结构化数据生成) ============
    secondary_llm_base_url: str = field(
        # default_factory=lambda: _env("SECONDARY_LLM_BASE_URL", "http://192.168.1.168:8001/v1"))
        default_factory=lambda: _env("SECONDARY_LLM_BASE_URL", "https://tokenhub.tencentmaas.com/v1"))
    # secondary_llm_model: str = field(default_factory=lambda: _env("SECONDARY_LLM_MODEL", "qwen"))
    secondary_llm_model: str = field(default_factory=lambda: _env("SECONDARY_LLM_MODEL", "deepseek/deepseek-flash"))
    secondary_llm_api_key: str = field(
        default_factory=lambda: _env("SECONDARY_LLM_API_KEY", "EMPTY"))
    secondary_llm_timeout: float = 30.0
    secondary_llm_temperature: float = 0.1  # 结构化输出要稳

    # ============ Embedding (BAAI/bge-m3, vLLM OpenAI 兼容 /v1/embeddings) ============
    embedding_base_url: str = field(default_factory=lambda: _env("EMBEDDING_BASE_URL", "http://127.0.0.1:8003/v1"))
    embedding_model: str = field(default_factory=lambda: _env("EMBEDDING_MODEL", "bge-m3"))
    embedding_api_key: str = field(default_factory=lambda: _env("EMBEDDING_API_KEY", "EMPTY"))
    embedding_dim: int = 1024  # bge-m3 默认 1024 维
    # 本地兜底: vLLM embedding 服务未启动时, 用 sentence-transformers 直接加载本地模型
    # 设为空字符串则禁用本地兜底, 强制走 HTTP
    embedding_local_model_path: str = field(
        default_factory=lambda: _env("EMBEDDING_LOCAL_MODEL_PATH", ""))
    embedding_local_device: str = field(default_factory=lambda: _env("EMBEDDING_LOCAL_DEVICE", "cpu"))

    # ============ RAG (Chroma 向量库) ============
    chroma_path: str = field(
        default_factory=lambda: _env("CHROMA_PATH", os.path.join(os.path.dirname(__file__), "chroma_db")))
    chroma_collection: str = "billiard_knowledge"
    rag_top_k: int = 3
    rag_min_similarity: float = 0.35  # 低于该余弦相似度的结果过滤掉
    rag_cache_size: int = 8912

    # ============ 知识库文档目录 ============
    knowledge_dir: str = field(default_factory=lambda: os.path.join(os.path.dirname(__file__), "knowledge_base"))

    # ============ 链路容错 ============
    max_retries: int = 2
    retry_backoff: float = 0.8

    # ============ TTS 语音播报 (回复 LLM 后同步播音) ============
    # 后端选择: "cosyvoice" (CosyVoice2-0.5B 自托管, 音质最好, 首选) /
    #           "edge" (Microsoft Edge 在线, 中文 XiaoxiaoNeural, 音质好) /
    #           "melo" (MeloTTS 本机 CPU 开源, edge 被拦时的免费兜底) /
    #           "pyttsx3" (Windows SAPI5 离线兜底, 声音机械) /
    #           "auto" (按可用性自动选: cosyvoice > edge > melo > pyttsx3)
    tts_backend: str = field(default_factory=lambda: _env("TTS_BACKEND", "edge"))
    # CosyVoice2 服务端点 (deploy/cosyvoice_server.py 暴露的 HTTP 接口)
    # docker-compose 内为 http://cosyvoice:8006, 本地直跑默认局域网机
    tts_cosyvoice_endpoint: str = field(default_factory=lambda: _env(
        "TTS_COSYVOICE_ENDPOINT", "http://127.0.0.1:8006"))
    # MeloTTS 服务端点 (deploy/melo_server.py, 跑在本机 models/melo/venv 独立环境)
    tts_melo_endpoint: str = field(default_factory=lambda: _env(
        "TTS_MELO_ENDPOINT", "http://127.0.0.1:8007"))
    # edge-tts 发音人: zh-CN-XiaoxiaoNeural (女, 温柔) / zh-CN-YunxiNeural (男, 阳光) /
    #                  zh-CN-YunjianNeural (男, 浑厚) / zh-CN-XiaoyiNeural (女, 甜)
    tts_voice: str = field(default_factory=lambda: _env("TTS_VOICE", "zh-CN-XiaoxiaoNeural"))
    # 语速 (-100% ~ +100%, 0 默认)
    tts_rate: str = field(default_factory=lambda: _env("TTS_RATE", "+0%"))
    # 音量 (-100% ~ +100%, 0 默认)
    tts_volume: str = field(default_factory=lambda: _env("TTS_VOLUME", "+0%"))
    # 音频缓存目录 (按文本 hash 缓存, 避免重复合成)
    tts_cache_dir: str = field(default_factory=lambda: _env(
        "TTS_CACHE_DIR",
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output", "voice_cache")
    ))
    # TTS 调用超时 (秒) — edge-tts 联网, 慢的时候给足时间
    tts_timeout: float = 15.0
    # 是否启用 TTS 播报 (False 时 skip 整段, 调试 / 单元测试用)
    tts_enabled: bool = field(default_factory=lambda: _env("TTS_ENABLED", "1") not in ("0", "false", "False", "no"))
    # 缓存文件 TTL (秒): 每次写入新缓存时同步删除早于该时长的音频文件 (含 .tmp 残留),
    # 防止句子级流式 TTS 加速缓存膨胀; 0 = 不清理
    tts_cache_ttl_seconds: float = field(default_factory=lambda: float(_env("TTS_CACHE_TTL_SECONDS", "600") or 600))

    # ============ 句子级流式 TTS (打字机与语音同步) ============
    # 开启后: 主 LLM 流式输出按句切分, 每凑够一句立即合成并通过 SSE audio 事件下发,
    # 前端跟着音频播放进度打字 (播到哪打到哪); 关闭则回退 done 后整段合成整段播.
    tts_stream_enabled: bool = field(
        default_factory=lambda: _env("TTS_STREAM_ENABLED", "1") not in ("0", "false", "False", "no"))
    # 句子切分: 句末标点 (。！？!?…；;\n) 立即成句; 连续超过该字数仍无句末标点时,
    # 回退到最后一个软边界 (，、,;) 切开, 无软边界则硬切 — 避免用户等长句合成
    tts_stream_seg_max_chars: int = field(default_factory=lambda: int(_env("TTS_STREAM_SEG_MAX_CHARS", "40") or 40))


# 单例
_config: VoiceConfig | None = None


def get_config() -> VoiceConfig:
    global _config
    if _config is None:
        _config = VoiceConfig()
    return _config
