# -*- coding: utf-8 -*-
"""AI 语音助手全链路模块.

链路: 语音输入 → ASR(Qwen3-ASR) → RAG(bge-m3 + Chroma) → 主 LLM(Qwen2.5, Function Calling)
      → 次级 LLM(结构化数据) → TTS 播报 → API 响应

TTS 播报入口 (任何需要语音播放的地方统一调用):
    from voice import speak
    result = speak("您好, 我是 AI 教练")
    # 或: from voice import TTSBroadcaster; TTSBroadcaster().speak("...")
"""

from .pipeline import VoicePipeline, VoiceResult
from .tts_broadcaster import TTSBroadcaster, SpeakResult, normalize_for_speech, speak


__all__ = [
    "VoicePipeline",
    "VoiceResult",
    "TTSBroadcaster",
    "SpeakResult",
    "normalize_for_speech",  # 播报文本口语规范化 (speak 内部自动调用)
    "speak",  # 模板方法 — 一行调用播报

]
