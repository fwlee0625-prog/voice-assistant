import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient

from model_service.app import create_app

REQUEST = {
    "state": "你好",
    "questions": {
        "intent": {
            "type": "choice",
            "instructions": "Is this a greeting?",
            "criteria": {"greet": "Greeting", "other": "Other speech"},
        }
    },
}


class FakeRuntime:
    def __init__(self, fail_load=False):
        self.fail_load = fail_load
        self.closed = False
        self.started = threading.Event()
        self.release = threading.Event()
        self.block = False
        self.fail_predict = False

    def load(self):
        if self.fail_load:
            raise RuntimeError("private model path")

    def predict(self, state, questions):
        self.started.set()
        if self.block:
            assert self.release.wait(5)
        if self.fail_predict:
            raise RuntimeError("private inference details")
        return {
            "answers": {
                "intent": {
                    "type": "choice",
                    "choice": "greet",
                    "probabilities": {"greet": 0.8, "other": 0.2},
                }
            },
            "usage": {"truncated": False},
        }

    def close(self):
        self.closed = True


def wait_ready(client, expected=200):
    for _ in range(100):
        response = client.get("/health/ready")
        if response.status_code == expected:
            return response
        time.sleep(0.01)
    pytest.fail("Readiness did not reach expected status")


def test_prediction_and_lifecycle():
    runtime = FakeRuntime()
    with TestClient(create_app(runtime=runtime)) as client:
        wait_ready(client)
        assert client.get("/v1/models").json()["models"][0]["id"] == "laya-multilingual"
        response = client.post("/v1/decisions", json=REQUEST)
        assert response.status_code == 200
        assert response.json()["answers"]["intent"]["choice"] == "greet"
        assert response.json()["latency_ms"] >= 0
        assert response.json()["usage"]["truncated"] is False
        assert (
            client.post(
                "/v1/decisions", json={**REQUEST, "model": "unknown"}
            ).status_code
            == 404
        )
    assert runtime.closed


def test_initialization_failure_keeps_health_live():
    with TestClient(create_app(runtime=FakeRuntime(fail_load=True))) as client:
        for _ in range(100):
            if client.get("/health/ready").json()["status"] == "failed":
                break
            time.sleep(0.01)
        assert client.get("/health/live").status_code == 200
        assert client.get("/health/ready").status_code == 503
        response = client.post("/v1/decisions", json=REQUEST)
        assert response.status_code == 503
        assert "private" not in response.text


def test_busy_rejected_and_health_responsive():
    runtime = FakeRuntime()
    runtime.block = True
    with (
        TestClient(create_app(runtime=runtime)) as client,
        ThreadPoolExecutor() as pool,
    ):
        wait_ready(client)
        first = pool.submit(client.post, "/v1/decisions", json=REQUEST)
        assert runtime.started.wait(2)
        try:
            assert client.post("/v1/decisions", json=REQUEST).status_code == 429
            assert client.get("/health/live").status_code == 200
        finally:
            runtime.release.set()
        assert first.result().status_code == 200
        assert client.post("/v1/decisions", json=REQUEST).status_code == 200


def test_inference_failure_releases_admission():
    runtime = FakeRuntime()
    with TestClient(create_app(runtime=runtime)) as client:
        wait_ready(client)
        runtime.fail_predict = True
        response = client.post("/v1/decisions", json=REQUEST)
        assert response.status_code == 500
        assert "private" not in response.text
        runtime.fail_predict = False
        assert client.post("/v1/decisions", json=REQUEST).status_code == 200


def test_cancelled_request_does_not_release_running_inference():
    async def scenario():
        runtime = FakeRuntime()
        runtime.block = True
        app = create_app(runtime=runtime)
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client,
        ):
            for _ in range(100):
                if (await client.get("/health/ready")).status_code == 200:
                    break
                await asyncio.sleep(0.01)
            request = asyncio.create_task(client.post("/v1/decisions", json=REQUEST))
            for _ in range(100):
                if runtime.started.is_set():
                    break
                await asyncio.sleep(0.01)
            assert runtime.started.is_set()
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            try:
                assert (
                    await client.post("/v1/decisions", json=REQUEST)
                ).status_code == 429
            finally:
                runtime.release.set()
            for _ in range(100):
                response = await client.post("/v1/decisions", json=REQUEST)
                if response.status_code == 200:
                    break
                await asyncio.sleep(0.01)
            assert response.status_code == 200

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "update",
    [
        {"questions": {}},
        {"state": "x" * 4001},
        {
            "questions": {
                "q": {
                    "type": "choice",
                    "instructions": "Pick",
                    "criteria": {"one": "Only one"},
                }
            }
        },
        {
            "questions": {
                "q": {
                    "type": "score",
                    "instructions": "Rate",
                    "criteria": {"a": "wrong"},
                }
            }
        },
        {"extra": True},
    ],
)
def test_invalid_request(update):
    with TestClient(create_app(runtime=FakeRuntime())) as client:
        assert (
            client.post("/v1/decisions", json={**REQUEST, **update}).status_code == 422
        )
