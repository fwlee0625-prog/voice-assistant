# CosyVoice2 TTS 服务镜像
# BuildKit 不读 daemon.json 的 registry-mirrors, 必须在 FROM 里写完整镜像源前缀
FROM docker.m.daocloud.io/library/python:3.11-slim

# 国内访问 GitHub 慢时, build 可覆盖镜像前缀加速:
#   docker compose -f deploy/docker-compose.yml build cosyvoice \
#     --build-arg GITHUB_MIRROR=https://ghfast.top/https://github.com
ARG GITHUB_MIRROR=https://github.com

WORKDIR /opt/CosyVoice

# 替换 apt 源为清华镜像 (加速 apt-get update)
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && sed -i 's|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources

# 系统依赖: git (clone repo), ffmpeg/libsndfile1 (音频 IO), build-essential (部分 pip 包编译)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ffmpeg libsndfile1 build-essential && rm -rf /var/lib/apt/lists/*

# pip 用清华镜像
RUN pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple

# CosyVoice repo (含 Matcha-TTS submodule, flow 模块依赖它)
RUN git clone --recursive --depth 1 ${GITHUB_MIRROR}/FunAudioLLM/CosyVoice.git /opt/CosyVoice

# 裁掉推理用不到的重依赖:
#   - tensorrt-cu12* (~3GB 下载, 仅 load_trt=True 需要)
#   - deepspeed (仅训练/离线管线需要, slim 镜像上极易编译失败)
#   - gradio / fastapi-cli / tensorboard (webui/调试工具, 本服务不用)
#
# openai-whisper==20231117 是 sdist 且 setup.py 用 pkg_resources, 新版 setuptools 已
# 移除该模块导致构建失败 —— 先固定老 setuptools, 用 --no-build-isolation 单独装它
# (用容器内 setuptools 构建), 其余依赖全部有 wheel 走正常安装
RUN grep -vE '^(tensorrt|deepspeed|gradio|fastapi-cli|tensorboard|matplotlib)' \
        requirements.txt > requirements.slim.txt \
    && pip install --no-cache-dir "setuptools<75" wheel \
    && pip install --no-cache-dir --no-build-isolation openai-whisper==20231117 \
    && pip install --no-cache-dir -r requirements.slim.txt \
    && rm -f requirements.slim.txt

# matplotlib 单独补装 (Matcha-TTS 子模块 matcha/utils/utils.py 在模块级 import 它,
# flow 依赖链必经; 不能裁)。放独立层, 不使上面的大 pip 层缓存失效
RUN pip install --no-cache-dir matplotlib

# 注: 官方 requirements 是 CosyVoice 验证过的成熟组合 (torch==2.3.1 + transformers==4.51.3),
#     刻意不装 vllm —— 装它会强制升级 torch/transformers, 偏离验证过的版本组合.
#     如需 vLLM 加速 (COSYVOICE_LOAD_VLLM=1), 在此追加: RUN pip install vllm torchaudio

# cosyvoice / matcha 包通过 PYTHONPATH 引入 (不用 pip install -e, 避免触发依赖重解析)
COPY deploy/cosyvoice_server.py /app/deploy/cosyvoice_server.py

ENV PYTHONPATH=/app:/opt/CosyVoice:/opt/CosyVoice/third_party/Matcha-TTS
WORKDIR /app
EXPOSE 8006

CMD ["python", "deploy/cosyvoice_server.py", "--host", "0.0.0.0", "--port", "8006"]
