# -*- coding: utf-8 -*-
"""RAG 检索模块: bge-m3 向量化 + Chroma 向量库召回 + Query 改写 + 缓存.

流程: 用户文本 → 口语化改写/关键词提取 → bge-m3 向量 → Chroma Top-K 召回
      → 余弦相似度过滤 → 标准化上下文
"""
import re
import threading
from collections import OrderedDict
from typing import Any

from .config import get_config
from .embedding_client import EmbeddingClient, EmbeddingError


class RAGError(Exception):
    pass


# 简单 LRU 缓存 (进程内, query → 召回结果)
class _LRU:
    def __init__(self, capacity: int):
        self.cap = capacity
        self.store: OrderedDict[str, list[dict]] = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key: str):
        with self.lock:
            if key in self.store:
                self.store.move_to_end(key)
                return self.store[key]
            return None

    def put(self, key: str, val):
        with self.lock:
            self.store[key] = val
            self.store.move_to_end(key)
            while len(self.store) > self.cap:
                self.store.popitem(last=False)


class RAGRetriever:
    def __init__(self, config=None, embedding_client: EmbeddingClient | None = None):
        self.cfg = config or get_config()
        self.embedder = embedding_client or EmbeddingClient(self.cfg)
        self._cache = _LRU(self.cfg.rag_cache_size)
        self._chroma = None  # 懒加载
        self._collection = None
        self._lock = threading.Lock()

    # ---------- Chroma 懒加载 ----------
    def _get_collection(self):
        if self._collection is not None:
            return self._collection
        with self._lock:
            if self._collection is not None:
                return self._collection
            try:
                import chromadb
            except ImportError as e:
                raise RAGError("chromadb 未安装, 请 pip install chromadb") from e
            client = chromadb.PersistentClient(path=self.cfg.chroma_path)
            self._collection = client.get_or_create_collection(
                name=self.cfg.chroma_collection,
                metadata={"hnsw:space": "cosine"},
            )
            self._chroma = client
            return self._collection

    # ---------- Query 预处理 ----------
    def _rewrite_query(self, text: str) -> tuple[str, list[str]]:
        """口语化改写 + 关键词提取.

        返回 (改写后的检索 query, 关键词列表).
        规则:
          - 去掉语气词 (那个/就是/我想问一下)
          - 把"咋打/怎么打/如何打" 归一成 "怎么打"
          - 提取球号/袋口/杆法关键词
        """
        t = text.strip()
        # 去语气词
        t = re.sub(r"(我想问一下|麻烦问一下|请问|那个|就是|嗯|啊|呢|吧|嘛)", "", t)
        t = re.sub(r"\s+", "", t)
        # 归一化
        t = re.sub(r"(咋|如何|怎样)打", "怎么打", t)
        # 关键词: 球号 / 袋口 / 杆法
        keywords = []
        for m in re.findall(r"\d+\s*号球?", text):
            keywords.append(m.replace(" ", ""))
        pocket_kw = re.findall(r"(左上|右上|左下|右下|上中|下中|中袋|角袋|袋口)", text)
        keywords.extend(pocket_kw)
        stroke_kw = re.findall(r"(高杆|低杆|中杆|拉杆|跟杆|斯登|斯蹬|扎杆|跳球|薄球|塞|加塞)", text)
        keywords.extend(stroke_kw)
        return t, keywords

    # ---------- 召回 ----------
    def retrieve(self, user_text: str) -> list[dict[str, Any]]:
        """返回 Top-K 知识片段, 每条 {"content", "source", "score"}.

        低相似度结果被过滤. 失败时返回空列表 (链路不中断, 主 LLM 仍可基于自身知识作答).
        """
        if not user_text.strip():
            return []
        cache_key = user_text.strip()
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        rewritten, keywords = self._rewrite_query(user_text)
        # 检索 query = 改写句 + 关键词拼接, 提升召回
        search_query = (rewritten + " " + " ".join(keywords)).strip() or user_text

        try:
            vecs = self.embedder.embed([search_query])
            if not vecs:
                return []
            query_vec = vecs[0]
        except EmbeddingError as e:
            # embedding 不可用, 链路降级: 返回空上下文
            raise RAGError(f"RAG 向量化失败: {e}")

        try:
            coll = self._get_collection()
            # Chroma query 接收 query_embeddings
            result = coll.query(
                query_embeddings=[query_vec],
                n_results=self.cfg.rag_top_k,
                include=["documents", "metadatas", "distances"],
            )
        except Exception as e:
            raise RAGError(f"Chroma 检索失败: {e}")

        docs = result.get("documents", [[]])[0]
        metas = result.get("metadatas", [[]])[0]
        dists = result.get("distances", [[]])[0]

        snippets: list[dict[str, Any]] = []
        for doc, meta, dist in zip(docs, metas, dists):
            # Chroma cosine space: distance 是 1 - similarity (越小越相似)
            similarity = max(0.0, 1.0 - float(dist))
            if similarity < self.cfg.rag_min_similarity:
                continue
            snippets.append({
                "content": doc,
                "source": (meta or {}).get("source", "unknown"),
                "category": (meta or {}).get("category", ""),
                "score": round(similarity, 4),
            })
        snippets.sort(key=lambda x: x["score"], reverse=True)
        self._cache.put(cache_key, snippets)
        return snippets

    def format_context(self, snippets: list[dict[str, Any]]) -> str:
        """把召回片段整理成主 LLM 可读的标准化上下文."""
        if not snippets:
            return ""
        lines = ["【知识库参考】"]
        for i, s in enumerate(snippets, 1):
            lines.append(f"[{i}] (来源: {s['source']}, 相似度: {s['score']}) {s['content']}")
        return "\n".join(lines)

    # ---------- 知识库状态 ----------
    def count(self) -> int:
        try:
            return self._get_collection().count()
        except Exception:
            return 0
