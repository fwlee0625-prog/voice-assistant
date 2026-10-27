# -*- coding: utf-8 -*-
"""MeloTTS 本地 TTS HTTP 服务: 把 MeloTTS (MIT 开源) 封装成 /tts HTTP 接口.

背景: edge-tts (微软公共接口) 会周期性被服务端 403 拦截, CosyVoice2 又依赖
GPU 机常驻; MeloTTS 是纯 CPU 实时推理的开源中文 TTS, 作为本机兜底后端
(音质远好于 pyttsx3, 仅次于 cosyvoice/edge)。

启动 (必须用 models/melo/venv 独立环境, 依赖与主项目 .venv 完全隔离):
  models/melo/venv/Scripts/python.exe deploy/melo_server.py
  # 或 deploy/start_melo.bat (封装了同样的命令)
  参数: --host 127.0.0.1 --port 8007 --device cpu --speaker AF

接口 (与 deploy/cosyvoice_server.py 同风格):
  POST /tts  (json)
      {"text": "要合成的文本", "speed": 1.0, "speaker": "AF"}
      → audio/wav 字节流 (44.1kHz 16bit mono)
  GET /health → {"status": "ok", "model": "melotts-zh_mix_en", "speakers": {...}}
      (模型加载完成才返回 200, 加载中连接拒绝 — 与 503 同等对待)

模型下载 (首次启动自动进行, 全部走 HF_ENDPOINT 镜像):
  1. myshell-ai/MeloTTS-Chinese       — 声学模型 checkpoint.pth + config.json
  2. bert-base-multilingual-uncased   — 中文文本 BERT 前端 (模型+分词器)
  3. bert-base-uncased                — 英文单词分词器 (中英混读路径引用)

代码路径: MeloTTS 源码在 models/melo/MeloTTS (不入 git), 可用 MELO_HOME 覆盖。
"""
import argparse
import io
import os
import sys
import threading

# 国内网络: HF 直连不通, 默认走 hf-mirror (必须在 import transformers/melo 之前设置)
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# MeloTTS 源码根目录 (melo 包所在), 默认项目内 models/melo/MeloTTS
_MELO_HOME = os.environ.get("MELO_HOME", os.path.join(_PROJECT_ROOT, "models", "melo", "MeloTTS"))
if os.path.isdir(_MELO_HOME) and _MELO_HOME not in sys.path:
    sys.path.insert(0, _MELO_HOME)

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
import uvicorn

app = FastAPI(title="MeloTTS Local TTS Service")

_STATE = {
    "ready": False,
    "error": "",
    "device": "cuda",
    "sample_rate": 44100,  # MeloTTS 中文模型固定输出 44.1kHz
    "speakers": {},  # spk2id, 加载后填充
}
_tts = None  # melo.api.TTS 实例 (torch 模型非线程安全)
_infer_lock = threading.Lock()


class TTSRequest(BaseModel):
    text: str
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    speaker: str | None = None  # spk2id 里的音色名, 缺省用启动时 --speaker


def _download_assets() -> None:
    """经 hf-mirror 预下载模型文件到 HF 缓存 (huggingface_hub 全程认 HF_ENDPOINT).

    声学模型拿到本地路径后直接传给 TTS(), 避免二次下载;
    BERT 前端由 transformers 在 import 期按缓存查找, 预热后离线可用。
    """
    from huggingface_hub import hf_hub_download, snapshot_download

    hf_hub_download("myshell-ai/MeloTTS-Chinese", "config.json")
    ckpt = hf_hub_download("myshell-ai/MeloTTS-Chinese", "checkpoint.pth")
    # tokenizer/model 文件按名列举, 避免拉取 onnx 等无关大文件
    snapshot_download("bert-base-multilingual-uncased", allow_patterns=[
        "config.json", "vocab.txt", "tokenizer_config.json", "tokenizer.json",
        "pytorch_model.bin",
    ])
    snapshot_download("bert-base-uncased", allow_patterns=[
        "config.json", "vocab.txt", "tokenizer_config.json", "tokenizer.json",
    ])
    return ckpt


def load_model(device: str = "cuda", speaker: str | None = None) -> None:
    """加载 MeloTTS 中文模型 (ZH_MIX_EN, 支持中英混读). 只在启动时调用一次."""
    global _tts
    from melo.api import TTS

    ckpt_path = _download_assets()
    config_path = os.path.join(os.path.dirname(ckpt_path), "config.json")
    _tts = TTS(language="ZH", device=device, config_path=config_path, ckpt_path=ckpt_path)
    _STATE["device"] = str(_tts.device)
    _STATE["sample_rate"] = int(_tts.hps.data.sampling_rate)
    # 音色表在 config 里 (中文模型一般 2 个音色), 供 /health 上报与请求侧选择
    _STATE["speakers"] = dict(getattr(_tts.hps.data, "spk2id", {}) or {})
    _STATE["default_speaker"] = speaker or _pick_default_speaker()
    # 首句预热: 触发 BERT/声学图编译, 避免第一个真实请求卡数秒
    _synthesize("预热", 1.0, None)
    _STATE["ready"] = True


def _pick_default_speaker() -> str | None:
    """默认音色: 优先女声 (与 edge 默认 Xiaoxiao 对齐), 否则取第一个."""
    spk2id = _STATE["speakers"]
    for name in spk2id:
        if "f" in name.lower():  # MeloTTS 中文音色习惯命名 AG(男)/AF(女)
            return name
    return next(iter(spk2id), None)


def _synthesize(text: str, speed: float, speaker: str | None) -> bytes:
    """文本 → wav 字节流 (模型推理 + soundfile 编码, 线程锁串行)."""
    import soundfile as sf

    spk2id = _STATE["speakers"]
    name = speaker or _STATE.get("default_speaker")
    if name not in spk2id:
        raise ValueError(f"未知音色 {name!r}, 可选: {list(spk2id)}")
    with _infer_lock:
        audio = _tts.tts_to_file(text=text, speaker_id=spk2id[name], speed=speed, quiet=True)
    buf = io.BytesIO()
    sf.write(buf, audio, _STATE["sample_rate"], format="WAV")
    return buf.getvalue()


@app.post("/tts")
def tts(req: TTSRequest) -> Response:
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    try:
        wav = _synthesize(text, req.speed, req.speaker)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # 推理异常明示 500, 客户端按 TTSError 降级
        raise HTTPException(status_code=500, detail=f"MeloTTS 推理失败: {e}")
    return Response(content=wav, media_type="audio/wav")


@app.get("/health")
def health():
    # 加载中/失败返回 503: 客户端 (tts_client) 按 status_code==200 判可用
    if not _STATE["ready"]:
        return JSONResponse(
            status_code=503,
            content={"status": "loading", "error": _STATE["error"]},
        )
    return {
        "status": "ok",
        "model": "melotts-zh_mix_en",
        "device": _STATE["device"],
        "sample_rate": _STATE["sample_rate"],
        "speakers": _STATE["speakers"],
        "default_speaker": _STATE.get("default_speaker"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="MeloTTS local TTS service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8007)
    parser.add_argument("--device", default="cuda", help="cpu (默认, 不占 GPU) / cuda")
    parser.add_argument("--speaker", default=None, help="默认音色名 (见 /health speakers)")
    args = parser.parse_args()

    print(f"[melo_server] MELO_HOME={_MELO_HOME}")
    print(f"[melo_server] HF_ENDPOINT={os.environ.get('HF_ENDPOINT')}")
    try:
        load_model(args.device, args.speaker)
    except Exception as e:
        import traceback

        traceback.print_exc()
        _STATE["error"] = str(e)
        # 模型加载失败仍启动服务: /health 返回 loading+error, 客户端探测不通过自动跳过
    print(f"[melo_server] ready={_STATE['ready']} speakers={_STATE['speakers']} "
          f"device={_STATE['device']}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
