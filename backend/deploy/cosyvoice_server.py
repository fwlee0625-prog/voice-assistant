# -*- coding: utf-8 -*-
"""CosyVoice2-0.5B TTS HTTP 服务: 把 CosyVoice2 模型封装成 /tts HTTP 接口.

CosyVoice2 官方只提供 Python API, 这里用 FastAPI 包一层 HTTP,
让 voice/tts_client.py 的 CosyVoiceClient 统一走 HTTP 调用 (与 Qwen3-ASR 同模式).

启动:
  python deploy/cosyvoice_server.py --host 0.0.0.0 --port 8006
  # 显存不足时 CPU 推理 (零显存, 速度慢 ~RTF 2-3): --device cpu

接口:
  POST /tts  (json)
      {"text": "要合成的文本",
       "prompt_text": "参考音频的转录文本",     # 可选, 默认内置音色
       "prompt_wav_path": "/path/to/wav",     # 可选, 容器内路径, 自定义音色克隆
       "speed": 1.0}
      → audio/wav 字节流 (24kHz 16bit mono)
  GET /health → {"status": "ok", "model": "cosyvoice2-0.5b"}
      (模型加载完成才返回 200, 加载中返回 503)

模型路径策略 (与 main-llm 等服务一致: 优先用挂载的本地模型):
  1) ${MODEL_DIR}/CosyVoice2-0.5B — docker-compose 挂载的本地模型, 离线秒加载
  2) ModelScope snapshot_download — 首次自动下载到 ~/.cache/modelscope (挂载可复用)

vLLM 加速 (COSYVOICE_LOAD_VLLM=1 启用, 默认 0 走官方推理栈; 走官方 CosyVoice2 load_vllm 路径):
  - vLLM 只加速内部的语音 token 生成 LLM (Qwen2.5-0.5B), flow/vocoder 部分不变;
    CosyVoice2 是 TTS 架构, 无法像 main-llm 那样整模型 vllm serve
  - 首次启用自动从 llm.pt 导出 vllm/ 目录 (bf16, ~1GB, 模型目录需可写), 之后复用
  - vLLM 引擎显存上限 0.2 (EngineArgs gpu_memory_utilization), 导出后释放原 LLM 权重
  - 注意: vLLM 模式不支持 bistream 推理; 需容器内已安装 vllm (>=0.10, 支持 enable_prompt_embeds)

依赖: CosyVoice repo 代码 (Dockerfile 里 clone 到 /opt/CosyVoice);
      本地直跑需先 git clone --recursive 官方 repo, 并设 COSYVOICE_ROOT 指向其根目录.
"""
import argparse
import io
import os
import sys
import threading
import traceback

# 确保项目根在 path
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# CosyVoice repo 代码路径 (cosyvoice 包 + Matcha-TTS submodule)
# 容器内由 Dockerfile clone 到 /opt/CosyVoice, 本地直跑用 COSYVOICE_ROOT 覆盖
_COSYVOICE_ROOT = os.environ.get("COSYVOICE_ROOT", "/opt/CosyVoice")
_MATCHA_ROOT = os.path.join(_COSYVOICE_ROOT, "third_party", "Matcha-TTS")
for _p in (_COSYVOICE_ROOT, _MATCHA_ROOT):
    if os.path.isdir(_p) and _p not in sys.path:
        sys.path.insert(0, _p)

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
import uvicorn

app = FastAPI(title="CosyVoice2-0.5B TTS Service")

_MODEL_ID = "iic/CosyVoice2-0.5B"
_SAMPLE_RATE = 24000  # CosyVoice2 输出采样率

# 全局状态 (模型懒加载 + 推理锁: CosyVoice 模型不是线程安全的)
_model = None
_prompt_speech = None  # 旧版 repo 契约: 默认音色 prompt (16kHz tensor)
_load_lock = threading.Lock()
_infer_lock = threading.Lock()

# 默认 zero-shot 音色: CosyVoice repo 自带 asset/zero_shot_prompt.wav (中文女声)
_DEFAULT_PROMPT_TEXT = "希望你以后能够做的比我还好呦。"
_DEFAULT_PROMPT_WAV = os.path.join(_COSYVOICE_ROOT, "asset", "zero_shot_prompt.wav")


def _resolve_model_dir() -> str:
    """模型目录解析: MODEL_DIR 挂载优先, 否则 ModelScope 缓存/下载.

    完整本地模型判定: 存在 cosyvoice2.yaml (CosyVoice2 的 hyper-yaml 配置,
    官方模型包里没有 model.yaml!) 和 llm.pt (token 生成 LLM 权重).
    """
    local = os.path.join(os.environ.get("MODEL_DIR", "/models"), "CosyVoice2-0.5B")
    if (os.path.isfile(os.path.join(local, "cosyvoice2.yaml"))
            and os.path.isfile(os.path.join(local, "llm.pt"))):
        print(f"[TTS] 使用本地模型: {local}", flush=True)
        return local
    # ModelScope 缓存/下载 (容器挂载 ~/.cache/modelscope 可复用缓存)
    from modelscope import snapshot_download
    print(f"[TTS] 本地模型不存在, 从 ModelScope 获取 {_MODEL_ID} ...", flush=True)
    return snapshot_download(_MODEL_ID)


def _load_model():
    """加载 CosyVoice2 模型 + 默认音色 prompt (幂等, 双重检查锁)."""
    global _model, _prompt_speech
    if _model is not None:
        return
    with _load_lock:
        if _model is not None:
            return
        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2
            from cosyvoice.utils.file_utils import load_wav
        except ImportError as e:
            raise RuntimeError(
                f"cosyvoice 代码不可用 ({e}); 容器内应位于 {_COSYVOICE_ROOT}, "
                f"本地直跑请设 COSYVOICE_ROOT 指向 CosyVoice repo 根目录") from e

        model_dir = _resolve_model_dir()
        # CUDA 下 fp16 半精度: 显存 ~1.5GB (fp32 ~3GB, 6GB 卡必须 fp16)
        fp16 = torch_cuda_available()
        # vLLM 加速开关: 官方 load_vllm 路径 (无 CUDA 时 CosyVoice2 内部会自动关掉)
        load_vllm = os.environ.get("COSYVOICE_LOAD_VLLM", "0") in ("1", "true", "True", "yes")
        print(f"[TTS] 加载 CosyVoice2 (fp16={fp16}, vllm={load_vllm}): {model_dir}", flush=True)
        _model = CosyVoice2(model_dir, load_jit=False, load_trt=False, load_vllm=load_vllm, fp16=fp16)

        # 默认音色 prompt: 新版 repo (2024+) 契约要 wav 文件路径 (frontend 内部 load_wav),
        # 旧版契约要 16kHz tensor — 两种都备好, /tts 里按 repo 版本择一传参.
        # (新版传 tensor 会报 "Invalid file: tensor(...)" — torchaudio.load 收到 tensor)
        if os.path.isfile(_DEFAULT_PROMPT_WAV):
            _prompt_speech = load_wav(_DEFAULT_PROMPT_WAV, 16000)
            print(f"[TTS] 默认音色 prompt: {_DEFAULT_PROMPT_WAV}", flush=True)
        else:
            print(f"[TTS] 警告: 未找到默认音色 {_DEFAULT_PROMPT_WAV}, "
                  f"调用 /tts 必须显式传 prompt_wav_path", flush=True)
        print("[OK] CosyVoice2 模型就绪", flush=True)


def torch_cuda_available() -> bool:
    """CUDA 是否可用 (在 torch 已加载的前提下查, 不触发 import)."""
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


class TTSRequest(BaseModel):
    text: str = Field(..., description="要合成的文本 (上限 500 字)")
    prompt_text: str = Field(default=_DEFAULT_PROMPT_TEXT, description="参考音频转录文本")
    prompt_wav_path: str = Field(default="", description="自定义音色 wav (容器内路径), 留空用默认音色")
    speed: float = Field(default=1.0, ge=0.5, le=2.0, description="语速倍率")


def _zero_shot(text: str, prompt_text: str, prompt_wav_path: str,
               prompt_speech_16k, speed: float):
    """zero-shot 推理, 兼容新旧两版 CosyVoice repo 的 prompt_wav 契约.

    - 新版 (2024+): inference_zero_shot 的 prompt_wav 期望 **wav 文件路径**,
      frontend 内部会 load_wav(path, 16k/24k) 自行加载;
    - 旧版: 期望调用方预加载的 **16kHz tensor**.

    策略: 先按新版契约传路径; 旧版 repo 收到 str 会在张量运算处抛
    TypeError/AttributeError 且发生在首个 chunk 产出前 (frontend 预处理阶段)
    → 回退 tensor 契约重试; 若已产出过 chunk 则不回退 (避免音频重复拼接).
    """
    yielded = False
    try:
        for out in _model.inference_zero_shot(
                text, prompt_text, prompt_wav_path, stream=False, speed=speed):
            yielded = True
            yield out
    except (TypeError, AttributeError) as e:
        if yielded:
            raise
        print(f"[TTS] prompt_wav 路径契约不适用 ({e}), "
              f"回退旧版 tensor 契约", flush=True)
        yield from _model.inference_zero_shot(
            text, prompt_text, prompt_speech_16k, stream=False, speed=speed)


@app.post("/tts")
def tts(req: TTSRequest) -> Response:
    """文本 → wav 音频字节流 (同步阻塞推理, FastAPI 自动放线程池)."""
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if len(text) > 500:
        raise HTTPException(status_code=400, detail="text 过长 (单次上限 500 字, 请分段合成)")

    try:
        _load_model()
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    import torch
    import torchaudio

    try:
        from cosyvoice.utils.file_utils import load_wav
        # 音色 prompt: 自定义 wav 优先, 否则默认音色;
        # 双契约准备 — 路径 (新版 repo) + tensor (旧版 repo)
        if req.prompt_wav_path:
            if not os.path.isfile(req.prompt_wav_path):
                raise HTTPException(status_code=400,
                                    detail=f"prompt_wav_path 不存在: {req.prompt_wav_path}")
            prompt_wav_path = req.prompt_wav_path
            prompt_speech = load_wav(req.prompt_wav_path, 16000)  # 旧版契约备用
        else:
            prompt_wav_path = _DEFAULT_PROMPT_WAV
            prompt_speech = _prompt_speech
            if prompt_speech is None:
                raise HTTPException(status_code=400,
                                    detail="默认音色未加载, 请显式传 prompt_wav_path")

        # zero-shot 推理; 长文本 CosyVoice 内部自动分句, 拼接所有 chunk
        with _infer_lock:
            chunks = []
            for out in _zero_shot(text, req.prompt_text, prompt_wav_path,
                                  prompt_speech, req.speed):
                chunks.append(out["tts_speech"])
        if not chunks:
            raise HTTPException(status_code=500, detail="CosyVoice2 返回空音频")
        speech = torch.concat(chunks, dim=1)

        # tensor → wav 字节流
        buf = io.BytesIO()
        torchaudio.save(buf, speech, _SAMPLE_RATE, format="wav")
        return Response(content=buf.getvalue(), media_type="audio/wav")
    except HTTPException:
        raise
    except Exception as e:
        # 完整栈打到容器日志, HTTP 只回简短 detail (排障不再靠猜)
        print("[TTS] 合成异常:", flush=True)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"CosyVoice2 合成失败: {e}") from e


@app.get("/health")
async def health():
    """探活: 模型加载完 200, 加载中 503 (客户端据此判断服务可用)."""
    if _model is None:
        return JSONResponse({"status": "loading", "model": "cosyvoice2-0.5b"}, status_code=503)
    return {"status": "ok", "model": "cosyvoice2-0.5b"}


def main():
    parser = argparse.ArgumentParser(description="CosyVoice2-0.5B TTS HTTP 服务")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8006)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda",
                        help="cuda (默认, 需 NVIDIA GPU) / cpu (显存不足兜底)")
    args = parser.parse_args()

    # 必须在 import torch 之前屏蔽 CUDA, --device cpu 才能真正走 CPU
    if args.device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

    # 预加载模型 (加载要几十秒, 提前到启动阶段; /tts 里另有懒加载兜底)
    print("[INFO] 预加载 CosyVoice2 模型 ...", flush=True)
    _load_model()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
