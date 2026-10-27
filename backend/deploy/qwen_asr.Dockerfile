# Qwen3-ASR 服务镜像: 官方 vllm-openai + 音频解码补丁层
#
# vllm/vllm-openai (0.26+) 已原生支持 Qwen3-ASR (model_executor/models/qwen3_asr.py),
# 与 main-llm 用同一份镜像, 本文件只在其上补装音频解码后端:
#   官方镜像缺 soundfile/av(PyAV)/scipy/soxr (vllm/multimodal/media/audio.py 的解码
#   链路全是 optional import), 不补装的话 audio_url 输入会直接解码失败.
# 补丁层 ~100MB, 基础镜像复用本地已拉取的 vllm/vllm-openai:latest (无需重新拉取).
#
# 注: 官方另有 qwenllm/qwen3-asr 镜像 (tag 用 latest, 不是 cu128), 体积 10GB+ 需整拉,
#     国内镜像源易 403; 本方案 build 秒级完成且与 main-llm 完全同构, 优先用这个.
FROM vllm/vllm-openai:latest

# 音频解码依赖: soundfile (主解码后端) + av (PyAV 重采样) + scipy/soxr (重采样备选)
RUN pip install --no-cache-dir --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
    soundfile av scipy soxr
