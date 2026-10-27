# -*- coding: utf-8 -*-
"""Embedding 客户端: 调用 BAAI/bge-m3 生成向量.

优先走 vLLM OpenAI 兼容 /v1/embeddings HTTP 接口 (生产环境);
HTTP 服务未启动时自动兜底用 sentence-transformers 直连本地模型 (开发/入库).
"""
import os
import time

import requests

from .config import get_config


class EmbeddingError(Exception):
    pass


class EmbeddingClient:
    def __init__(self, config=None):
        self.cfg = config or get_config()
        self._local_model = None  # sentence-transformers 模型, 懒加载
        self._local_tried = False  # 避免重复尝试加载本地模型

    def embed(self, texts: list[str]) -> list[list[float]]:
        return []
        """文本列表 → 向量列表 (bge-m3 1024 维)."""
        if not texts:
            return []
        # 先试 HTTP (vLLM 在线服务)
        try:
            return self._embed_http(texts)
        except requests.RequestException:
            pass  # 连不上, 走本地兜底
        except EmbeddingError:
            pass  # HTTP 返回异常, 也走本地兜底
        # 兜底: 本地 sentence-transformers
        return self._embed_local(texts)

    def _embed_http(self, texts: list[str]) -> list[list[float]]:
        """通过 vLLM OpenAI 兼容接口获取向量."""
        last_err = None
        for attempt in range(self.cfg.max_retries + 1):
            try:
                resp = requests.post(
                    f"{self.cfg.embedding_base_url}/embeddings",
                    json={
                        "model": self.cfg.embedding_model,
                        "input": texts,
                        "encoding_format": "float",
                    },
                    headers={"Authorization": f"Bearer {self.cfg.embedding_api_key}"},
                    timeout=30.0,
                )
                if resp.status_code != 200:
                    raise EmbeddingError(f"embedding 返回 {resp.status_code}: {resp.text[:200]}")
                data = resp.json()
                return [d["embedding"] for d in data["data"]]
            except requests.RequestException as e:
                last_err = e
                if attempt < self.cfg.max_retries:
                    time.sleep(self.cfg.retry_backoff * (attempt + 1))
                continue
        raise EmbeddingError(f"embedding HTTP 调用失败: {last_err}")

    def _embed_local(self, texts: list[str]) -> list[list[float]]:
        """本地兜底: sentence-transformers 直连 bge-m3 模型."""
        model = self._get_local_model()
        if model is None:
            raise EmbeddingError(
                "embedding 服务不可用: vLLM HTTP 连接失败且本地模型加载失败. "
                "请启动 vLLM embedding 服务, 或安装 sentence-transformers 并配置 EMBEDDING_LOCAL_MODEL_PATH"
            )
        import numpy as np  # 延迟 import, 避免冷启动慢
        embs = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        # numpy ndarray → list[list[float]]
        if isinstance(embs, np.ndarray):
            return embs.tolist()
        return [list(e) for e in embs]

    def _get_local_model(self):
        """懒加载本地 sentence-transformers 模型, 加载失败返回 None."""
        if self._local_model is not None:
            return self._local_model
        if self._local_tried:
            return None  # 之前试过了, 不再重试
        self._local_tried = True

        model_path = self.cfg.embedding_local_model_path
        if not model_path or not os.path.isdir(model_path):
            return None

        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            return None

        print(f"[Embedding] HTTP 不可用, 启用本地兜底: {model_path}", flush=True)
        t0 = time.time()
        self._local_model = SentenceTransformer(
            model_path,
            device=self.cfg.embedding_local_device,
        )
        print(f"[Embedding] 本地模型加载完成 ({time.time() - t0:.1f}s)", flush=True)
        return self._local_model
