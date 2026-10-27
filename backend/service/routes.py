import json
import logging
import os
import re
import traceback
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool
from service.integration import get_voice_pipeline, _voice_planner, _voice_simulator, _voice_layout_builder
log = logging.getLogger(__name__)

def _parse_multipart(body: bytes, boundary: str) -> dict:
    """简单 multipart/form-data 解析.

    返回 {field_name: value_str | (filename, content_bytes)}.
    二进制字段只精确删掉 multipart 分隔符 CRLF, 不用 rstrip 避免切掉音频数据.
    """
    delimiter = b"--" + boundary.encode("utf-8")
    parts = body.split(delimiter)
    result: dict = {}
    for part in parts:
        if part.startswith(b"\r\n"):
            part = part[2:]
        if part.endswith(b"\r\n"):
            part = part[:-2]
        if not part or part == b"--":
            continue
        try:
            header_block, content = part.split(b"\r\n\r\n", 1)
        except ValueError:
            continue
        name = None
        filename = None
        for line in header_block.split(b"\r\n"):
            line_str = line.decode("utf-8", errors="ignore")
            if line_str.lower().startswith("content-disposition:"):
                for kv in line_str.split(";"):
                    kv = kv.strip()
                    if kv.startswith("name="):
                        name = kv[5:].strip('"')
                    elif kv.startswith("filename="):
                        filename = kv[9:].strip('"')
        if name is None:
            continue
        if filename:
            result[name] = (filename, content)
        else:
            result[name] = content.decode("utf-8", errors="ignore").strip()
    return result


async def read_json(request: Request):
    """读 JSON body; 失败/空 body 返回 {} (与原 server 契约一致)。"""
    try:
        raw = await request.body()
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


async def read_multipart(request: Request):
    """读 multipart/form-data body → (fields, None) 或 (None, 错误响应)。

    fields: {field: value_str | (filename, content_bytes)}
    """
    ctype = request.headers.get("content-type", "")
    if "multipart/form-data" not in ctype:
        return None, JSONResponse(
            status_code=400,
            content={"status": "error", "error": "需要 multipart/form-data 请求"})
    boundary = None
    for part in ctype.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part[len("boundary="):].strip('"')
            break
    if not boundary:
        return None, JSONResponse(
            status_code=400,
            content={"status": "error", "error": "缺少 multipart boundary"})
    try:
        body = await request.body()
        fields = _parse_multipart(body, boundary)
    except Exception as e:
        return None, JSONResponse(
            status_code=400,
            content={"status": "error", "error": f"multipart 解析失败: {e}"})
    return fields, None


def err_500(prefix: str, e: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={
        "status": "error",
        "error": f"{prefix}: {e}",
        "traceback": traceback.format_exc(),
    })


def register_routes(app: FastAPI):
    @app.websocket("/api/voice/asr/realtime")
    async def voice_realtime_asr(websocket: WebSocket):
        from voice.tencent_realtime import realtime_asr
        await realtime_asr(websocket)

    # ---------------- 语音助手 (/api/voice/*) ----------------

    def _sse_events(events_iter):
        """VoicePipeline 事件流 → SSE 帧 (done 的 VoiceResult → to_dict)。

        帧格式: `data: {json}\\n\\n` (SSE 规范, 事件类型在 JSON 的 type 字段)。
        """
        for ev in events_iter:
            if ev.get("type") == "done" and hasattr(ev.get("result"), "to_dict"):
                ev = {"type": "done", "result": ev["result"].to_dict()}
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    def _voice_stream_response(pipeline_iter):
        """流式语音响应 (SSE): 同步事件生成器 (阻塞的 LLM/TTS 由 starlette 放线程池迭代)。

        生成器本体崩溃时兜底一条 error 事件 (此时流已打开, 无法再改 HTTP 状态码)。
        """
        def gen():
            try:
                for frame in _sse_events(pipeline_iter):
                    yield frame
            except Exception as e:
                log.exception("语音流式链路异常")
                yield (f"data: {json.dumps({'type': 'error', 'error': f'语音链路异常: {e}'}, ensure_ascii=False)}\n\n")
        # X-Accel-Buffering: 禁用反向代理缓冲, 保证打字机帧逐条到达
        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store",
                                          "X-Accel-Buffering": "no"})

    @app.post("/api/voice/text")
    async def voice_text(request: Request):
        """文本输入 → 流式全链路 (SSE: stage/delta/done 事件, 前端打字机)。"""
        req = await read_json(request)
        text = str(req.get("text", "")).strip()
        if not text:
            return JSONResponse(status_code=400,
                                content={"status": "error", "error": "缺少 text 字段"})
        pipeline = get_voice_pipeline()
        return _voice_stream_response(pipeline.run_stream(text=text))

    @app.post("/api/voice/chat")
    async def voice_chat(request: Request):
        """音频上传 → ASR + 流式全链路 (SSE: asr/stage/delta/done)。"""
        fields, err = await read_multipart(request)
        if err is not None:
            return err
        audio_field = fields.get("audio")
        text_fallback = fields.get("text", "")
        if isinstance(text_fallback, bytes):
            text_fallback = text_fallback.decode("utf-8", errors="ignore")
        pipeline = get_voice_pipeline()
        if audio_field and isinstance(audio_field, tuple):
            _, audio_bytes = audio_field
            return _voice_stream_response(
                pipeline.run_stream(text=text_fallback or None,
                                    audio_bytes=audio_bytes, fmt="wav"))
        if not text_fallback:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "error": "缺少 audio 文件或 text 备用文本"})
        return _voice_stream_response(pipeline.run_stream(text=text_fallback))

    @app.post("/api/voice/asr")
    async def voice_asr(request: Request):
        """轻量 ASR: 只做语音转文字 (边说边识别)。multipart: audio=wav。"""
        fields, err = await read_multipart(request)
        if err is not None:
            return err
        audio_field = fields.get("audio")
        if not audio_field or not isinstance(audio_field, tuple):
            return JSONResponse(status_code=400,
                                content={"status": "error", "error": "缺少 audio 文件"})
        try:
            from voice.asr_client import ASRClient, ASRError
            _, audio_bytes = audio_field
            text = await run_in_threadpool(ASRClient().transcribe,
                                           audio_bytes, fmt="wav")
            return JSONResponse(status_code=200,
                                content={"status": "ok", "text": text})
        except ASRError as e:
            # 静音段/识别为空是正常情况, 返回空文本让前端跳过
            return JSONResponse(status_code=200,
                                content={"status": "ok", "text": "", "warning": str(e)})
        except Exception as e:
            return JSONResponse(status_code=500,
                                content={"status": "error", "error": str(e)})

    @app.post("/api/voice/enhance")
    async def voice_enhance(request: Request):
        """人声增强: multipart audio=任意常见音频 → 降噪后的 wav。

        录音页上传 webm/opus, 后端用 ffmpeg 解码后交给 DPDFNet 模型,
        返回 audio/wav 字节流; 失败返回 JSON 错误。
        """
        fields, err = await read_multipart(request)
        if err is not None:
            return err
        audio_field = fields.get("audio")
        if not audio_field or not isinstance(audio_field, tuple):
            return JSONResponse(status_code=400,
                                content={"status": "error", "error": "缺少 audio 文件"})
        try:
            from voice.speech_enhancer import SpeechEnhanceError, enhance_audio
            _, audio_bytes = audio_field
            wav_bytes, sample_rate = await run_in_threadpool(enhance_audio, audio_bytes)
            return Response(
                content=wav_bytes,
                media_type="audio/wav",
                headers={
                    "Content-Disposition": 'inline; filename="enhanced.wav"',
                    "X-Sample-Rate": str(sample_rate),
                    "Cache-Control": "no-store",
                },
            )
        except SpeechEnhanceError as e:
            return JSONResponse(status_code=422,
                                content={"status": "error", "error": str(e)})
        except Exception as e:
            return err_500("人声增强异常", e)

    @app.post("/api/voice/execute")
    async def voice_execute(request: Request):
        """直接执行工具 (跳过 LLM, 供前端按钮调用)。"""
        req = await read_json(request)
        tool_name = str(req.get("tool_name", "")).strip()
        arguments = req.get("arguments", {}) or {}
        if not tool_name:
            return JSONResponse(status_code=400,
                                content={"status": "error", "error": "缺少 tool_name"})
        try:
            from voice.tools import ToolExecutor
            executor = ToolExecutor(
                planner=_voice_planner,
                simulator=_voice_simulator,
                layout_builder=_voice_layout_builder,
            )
            result = await run_in_threadpool(executor.execute, tool_name, arguments)
            return JSONResponse(status_code=200, content=result)
        except Exception as e:
            return err_500("工具执行异常", e)

    @app.post("/api/voice/tts")
    async def voice_tts(request: Request):
        """纯 TTS 合成 (不走 LLM, 试听 / 自定义播报用)。"""
        req = await read_json(request)
        text = str(req.get("text", "")).strip()
        if not text:
            return JSONResponse(status_code=400,
                                content={"status": "error", "error": "缺少 text 字段"})
        try:
            from voice.tts_broadcaster import TTSBroadcaster
            broadcaster = TTSBroadcaster()
            # 仅透传显式提供的可选项 (传 None 会误触发覆盖逻辑)
            tts_opts = {}
            for _k in ("voice", "rate", "volume"):
                _v = req.get(_k)
                if _v:
                    tts_opts[_k] = _v
            result = await run_in_threadpool(broadcaster.speak, text, **tts_opts)
            return JSONResponse(status_code=200, content=result.to_dict())
        except Exception as e:
            return err_500("TTS 异常", e)

    @app.api_route("/api/voice/status", methods=["GET", "POST"])
    async def voice_status():
        """语音服务健康检查。"""
        from voice.config import get_config
        cfg = get_config()
        rag_count = 0
        try:
            from voice.rag_retriever import RAGRetriever
            rag_count = await run_in_threadpool(
                lambda: RAGRetriever(cfg).count())
        except Exception:
            pass
        # TTS 播报器状态 (懒加载 — 失败不影响主状态)
        tts_status: dict = {"available": False, "reason": "TTS 状态获取失败"}
        try:
            from voice.tts_broadcaster import TTSBroadcaster
            tts_info = await run_in_threadpool(
                lambda: TTSBroadcaster(cfg).status())
            tts_status = {
                "available": len(tts_info.get("available_backends", [])) > 0,
                "enabled": tts_info.get("enabled", False),
                "backend": tts_info.get("backend"),
                "voice": tts_info.get("voice"),
                "available_backends": tts_info.get("available_backends", []),
                "cache_files": tts_info.get("cache_files", 0),
                "cache_bytes": tts_info.get("cache_bytes", 0),
                "cache_dir": tts_info.get("cache_dir"),
            }
        except Exception as e:
            tts_status = {"available": False, "reason": str(e)}
        return {
            "status": "ok",
            "asr_endpoint": cfg.asr_endpoint,
            "main_llm_base_url": cfg.main_llm_base_url,
            "main_llm_model": cfg.main_llm_model,
            "secondary_llm_base_url": cfg.secondary_llm_base_url,
            "embedding_base_url": cfg.embedding_base_url,
            "embedding_model": cfg.embedding_model,
            "rag_collection": cfg.chroma_collection,
            "rag_chunks": rag_count,
            "tts": tts_status,
        }

    @app.get("/api/voice/audio/{filename}")
    async def voice_audio(filename: str):
        """TTS 缓存音频文件 (仅允许 cache_dir 内 hash.{mp3|wav})。"""
        from voice.config import get_config
        cfg = get_config()
        cache_dir = cfg.tts_cache_dir
        # 严格白名单: 只允许 16 位 hash + mp3/wav
        if not re.fullmatch(r"[a-f0-9]{16}\.(mp3|wav)", filename):
            return JSONResponse(status_code=400,
                                content={"status": "error", "error": "Invalid audio filename"})
        fpath = os.path.join(cache_dir, filename)
        # 路径安全二次校验: 解析后必须在 cache_dir 内
        try:
            real_cache = os.path.realpath(cache_dir)
            real_fpath = os.path.realpath(fpath)
            if not real_fpath.startswith(real_cache + os.sep) and real_fpath != real_cache:
                return JSONResponse(status_code=403,
                                    content={"status": "error", "error": "Forbidden"})
        except Exception:
            return JSONResponse(status_code=400,
                                content={"status": "error", "error": "Invalid path"})
        if not os.path.isfile(fpath):
            return JSONResponse(status_code=404,
                                content={"status": "error", "error": "Audio not found"})
        ext = os.path.splitext(filename)[1].lower()
        mime = "audio/mpeg" if ext == ".mp3" else "audio/wav"
        # hash 是内容指纹, 可长缓存 (与原 server 一致)
        return FileResponse(fpath, media_type=mime,
                            headers={"Cache-Control": "public, max-age=86400"})

