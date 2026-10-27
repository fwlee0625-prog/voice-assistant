# -*- coding: utf-8 -*-
"""知识库入库脚本: 批量导入 Markdown 文档到 Chroma 向量库.

分块规则:
  - 规则类 (rules.md): 300-500 token / 块
  - 战术案例类 (tactics.md): 500-800 token / 块
  - 发力方式类 (strokes.md): 300-500 token / 块
  - 重叠区间: 100-150 token
中文近似: 1 token ≈ 1.6 字符 (bge-m3 tokenizer 经验值)

用法:
  python -m voice.ingest                # 入库 voice/knowledge_base/*.md
  python -m voice.ingest --rebuild      # 清空集合后重建
  python -m voice.ingest --dir <path>   # 指定其他文档目录
"""
import argparse
import os
import re
import sys

# 确保项目根在 path
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from voice.config import get_config
from voice.embedding_client import EmbeddingClient, EmbeddingError

# 中文 token 近似: 1 token ≈ 1.6 字符
CHARS_PER_TOKEN = 1.6

# 每个文档的分块配置 (min_tokens, max_tokens, overlap_tokens)
CHUNK_CONFIG = {
    "rules": (300, 500, 120),
    "tactics": (500, 800, 130),
    "strokes": (300, 500, 120),
}
DEFAULT_CHUNK = (400, 600, 120)


def _classify(filename: str) -> str:
    """根据文件名推断分类."""
    base = os.path.splitext(os.path.basename(filename))[0].lower()
    for key in CHUNK_CONFIG:
        if key in base:
            return key
    return "default"


def _split_by_headings(content: str) -> list[str]:
    """按 markdown 二级/三级标题预切分, 保留标题."""
    # 按 ## 或 ### 切分, 保留标题行
    parts = re.split(r"(?m)^(#{2,3}\s+.+)$", content)
    chunks: list[str] = []
    current = parts[0] if parts else ""
    for i in range(1, len(parts), 2):
        if current.strip():
            chunks.append(current.strip())
        heading = parts[i]
        body = parts[i + 1] if i + 1 < len(parts) else ""
        current = heading + "\n" + body
    if current.strip():
        chunks.append(current.strip())
    return chunks


def _token_chunk(text: str, min_tok: int, max_tok: int, overlap_tok: int) -> list[str]:
    """把长文本按 token 窗口切块 (重叠滑窗)."""
    min_chars = int(min_tok * CHARS_PER_TOKEN)
    max_chars = int(max_tok * CHARS_PER_TOKEN)
    overlap_chars = int(overlap_tok * CHARS_PER_TOKEN)

    if len(text) <= max_chars:
        return [text]

    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + max_chars, len(text))
        chunk = text[start:end]
        # 优先在句号/换行处断
        if end < len(text):
            for sep in ["\n", "。", "；", "！", "？"]:
                cut = chunk.rfind(sep)
                if cut >= min_chars:
                    end = start + cut + len(sep)
                    chunk = text[start:end]
                    break
        chunks.append(chunk.strip())
        if end >= len(text):
            break
        step = max(1, end - start - overlap_chars)
        start += step
    return [c for c in chunks if c]


def chunk_document(content: str, category: str) -> list[str]:
    """文档 → 分块列表. 先按标题切, 再按 token 窗口二次切."""
    min_tok, max_tok, overlap_tok = CHUNK_CONFIG.get(category, DEFAULT_CHUNK)
    sections = _split_by_headings(content)
    chunks: list[str] = []
    for sec in sections:
        chunks.extend(_token_chunk(sec, min_tok, max_tok, overlap_tok))
    return chunks


def ingest(knowledge_dir: str, rebuild: bool = False) -> dict:
    """入库主流程. 返回统计 dict."""
    cfg = get_config()
    try:
        import chromadb
    except ImportError:
        print("[ERROR] chromadb 未安装, 请: pip install chromadb", flush=True)
        return {"status": "error", "error": "chromadb not installed"}

    client = chromadb.PersistentClient(path=cfg.chroma_path)
    if rebuild:
        try:
            client.delete_collection(cfg.chroma_collection)
            print(f"[INFO] 已删除集合 {cfg.chroma_collection}", flush=True)
        except Exception:
            pass
    collection = client.get_or_create_collection(
        name=cfg.chroma_collection,
        metadata={"hnsw:space": "cosine"},
    )

    embedder = EmbeddingClient(cfg)
    md_files = sorted(
        os.path.join(knowledge_dir, f)
        for f in os.listdir(knowledge_dir)
        if f.endswith(".md")
    )
    if not md_files:
        print(f"[WARN] {knowledge_dir} 下没有 .md 文件", flush=True)
        return {"status": "error", "error": "no markdown files"}

    total_chunks = 0
    all_docs: list[str] = []
    all_metas: list[dict] = []
    all_ids: list[str] = []

    for md in md_files:
        category = _classify(md)
        fname = os.path.basename(md)
        with open(md, "r", encoding="utf-8") as f:
            content = f.read()
        chunks = chunk_document(content, category)
        print(f"[INFO] {fname} ({category}) → {len(chunks)} 块", flush=True)
        for i, ch in enumerate(chunks):
            all_docs.append(ch)
            all_metas.append({
                "source": fname,
                "category": category,
                "chunk_idx": i,
            })
            all_ids.append(f"{fname}#{i}")
        total_chunks += len(chunks)

    if not all_docs:
        return {"status": "error", "error": "no chunks generated"}

    # 批量向量化 (bge-m3)
    print(f"[INFO] 向量化 {len(all_docs)} 块 ...", flush=True)
    try:
        # 分批 embed (每批 32)
        all_vecs: list[list[float]] = []
        batch = 32
        for i in range(0, len(all_docs), batch):
            vecs = embedder.embed(all_docs[i:i + batch])
            all_vecs.extend(vecs)
            print(f"  embedded {min(i + batch, len(all_docs))}/{len(all_docs)}", flush=True)
    except EmbeddingError as e:
        print(f"[ERROR] 向量化失败: {e}", flush=True)
        return {"status": "error", "error": str(e)}

    # 写入 Chroma
    collection.upsert(
        ids=all_ids,
        embeddings=all_vecs,
        documents=all_docs,
        metadatas=all_metas,
    )
    print(f"[OK] 入库完成: {total_chunks} 块, 集合 {cfg.chroma_collection} 现共 {collection.count()} 条", flush=True)
    return {"status": "ok", "files": len(md_files), "chunks": total_chunks, "total": collection.count()}


def main():
    parser = argparse.ArgumentParser(description="台球知识库入库")
    parser.add_argument("--dir", default=None, help="知识库文档目录 (默认 voice/knowledge_base)")
    parser.add_argument("--rebuild", action="store_true", help="清空集合后重建")
    args = parser.parse_args()

    cfg = get_config()
    kdir = args.dir or cfg.knowledge_dir
    if not os.path.isdir(kdir):
        print(f"[ERROR] 目录不存在: {kdir}", flush=True)
        sys.exit(1)

    result = ingest(kdir, rebuild=args.rebuild)
    print(result, flush=True)
    if result.get("status") != "ok":
        sys.exit(1)


if __name__ == "__main__":
    main()
