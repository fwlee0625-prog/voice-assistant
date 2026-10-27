# -*- coding: utf-8 -*-
"""ASR 客户端: 调用 Qwen3-ASR-1.7B (vLLM OpenAI 转写端点) 把音频转文本.

Qwen3-ASR 由官方 vllm/vllm-openai 镜像部署 (deploy/docker-compose.yml 的
qwen-asr 服务)。走 /v1/audio/transcriptions (OpenAI 兼容 STT 端点,
multipart 音频上传), 相比 chat completions 多两个领域参数:
  - prompt:   上下文/热词偏置 (cfg.asr_context, 台球术语提升识别率)
  - language: 强制语种 ISO-639-1 (cfg.asr_language, 如 "zh"; 留空自动检测)
服务端自动解析 Qwen3-ASR 的 "language X<asr_text>" 结构化输出,
返回 {"text": 纯文本}. 识别失败抛 ASRError, 由 pipeline 捕获后返回明确错误提示.
"""
import io
import time

import requests

from .config import get_config


class ASRError(Exception):
    pass


class ASRClient:
    def __init__(self, config=None):
        self.cfg = config or get_config()

    def transcribe(self, audio_bytes: bytes, fmt: str = "wav") -> str:
        """音频字节流 → 清洗后文本.

        参数:
            audio_bytes: 音频文件二进制内容 (16k 单声道最佳, wav/mp3 等均可)
            fmt: 音频格式, 默认 wav

        返回: 纯文本指令. 失败抛 ASRError.
        """
        last_err = None
        for attempt in range(self.cfg.max_retries + 1):
            try:
                data = {"model": self.cfg.asr_model, "prompt": self.cfg.asr_context}
                if self.cfg.asr_language:
                    data["language"] = self.cfg.asr_language
                files = {"file": (f"input.{fmt}", io.BytesIO(audio_bytes), f"audio/{fmt}")}
                resp = requests.post(
                    self.cfg.asr_endpoint,
                    files=files,
                    data=data,
                    timeout=self.cfg.asr_timeout,
                )
                if resp.status_code != 200:
                    raise ASRError(f"ASR 服务返回 {resp.status_code}: {resp.text[:200]}")
                text = (resp.json().get("text") or "").strip()
                if not text:
                    # 口语化识别可能返回空 (静音段), 给明确提示
                    raise ASRError("ASR 识别结果为空, 请确认音频包含有效语音")
                # 清洗: 去掉 ASR 输出常见的标点堆积/首尾空白
                text = _clean(text)
                return text
            except (requests.RequestException, KeyError, IndexError, ValueError) as e:
                last_err = e
                if attempt < self.cfg.max_retries:
                    time.sleep(self.cfg.retry_backoff * (attempt + 1))
                continue
            except ASRError:
                raise
        raise ASRError(f"ASR 调用失败 (重试 {self.cfg.max_retries} 次): {last_err}")


def _clean(text: str) -> str:
    # 去掉多余空白与重复标点
    import re
    text = re.sub(r"[，。！？、,.!?]{2,}", "。", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()
