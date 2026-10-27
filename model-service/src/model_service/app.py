"""HTTP lifecycle, readiness and bounded inference admission."""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from time import perf_counter

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .config import MODEL_ID, Settings
from .laya_runtime import LayaRuntime
from .schemas import DecisionRequest

logger = logging.getLogger(__name__)


def create_app(settings=None, runtime=None):
    settings = settings or Settings.from_env()
    runtime = runtime or LayaRuntime(settings)
    status = {"state": "loading"}
    busy = False

    @asynccontextmanager
    async def lifespan(app):
        # One executor owns model operations. HTTP health checks remain responsive.
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="model")
        app.state.executor = executor

        async def warm():
            try:
                await asyncio.get_running_loop().run_in_executor(executor, runtime.load)
                status["state"] = "ready"
            except Exception:
                logger.exception("Model initialization failed")
                status["state"] = "failed"

        loading = asyncio.create_task(warm())
        try:
            yield
        finally:
            await loading
            await asyncio.get_running_loop().run_in_executor(executor, runtime.close)
            executor.shutdown(wait=True)

    app = FastAPI(title="Local Model Service", lifespan=lifespan)

    @app.get("/health/live")
    async def live():
        return {"status": "ok"}

    @app.get("/health/ready")
    async def ready():
        return JSONResponse(
            {"status": status["state"]},
            status_code=200 if status["state"] == "ready" else 503,
        )

    @app.get("/v1/models")
    async def models():
        return {
            "models": [
                {
                    "id": MODEL_ID,
                    "status": status["state"],
                    "device": settings.device,
                    "tasks": ["decision"],
                }
            ]
        }

    @app.post("/v1/decisions")
    async def decisions(body: DecisionRequest):
        nonlocal busy
        if body.model != MODEL_ID:
            raise HTTPException(404, "Unknown model")
        if status["state"] != "ready":
            raise HTTPException(503, "Model is not ready")
        if busy:
            raise HTTPException(429, "Model is busy", headers={"Retry-After": "1"})
        busy = True
        started = perf_counter()
        loop = asyncio.get_running_loop()
        questions = {
            key: value.model_dump(exclude_none=True)
            for key, value in body.questions.items()
        }
        future = loop.run_in_executor(
            app.state.executor, runtime.predict, body.state, questions
        )

        # Cancellation cannot stop native inference: retain admission until it actually ends.
        def release(done):
            nonlocal busy
            busy = False
            if not done.cancelled():
                done.exception()

        future.add_done_callback(release)
        try:
            result = await asyncio.shield(future)
        except Exception:
            logger.exception("Model prediction failed")
            raise HTTPException(500, "Model inference failed") from None
        return {
            "model": MODEL_ID,
            "answers": result["answers"],
            "usage": result.get("usage", {}),
            "latency_ms": round((perf_counter() - started) * 1000, 2),
        }

    return app
