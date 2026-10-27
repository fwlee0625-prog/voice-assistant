// ============================================================
// AI 语音助手 · Voice Assistant Logic
// 链路: 录音/文字 → /api/voice/{chat,text} → ASR+RAG+LLM+工具 → 渲染对话
// ============================================================

(function () {
    "use strict";

    // ---------- DOM ----------
    const $ = (id) => document.getElementById(id);
    const chatMessages = $("chat-messages");
    const textInput = $("text-input");
    const sendBtn = $("send-btn");
    const micBtn = $("mic-btn");
    const recordingBar = $("recording-bar");
    const recTimer = $("rec-timer");
    const recCancel = $("rec-cancel");
    const statusList = $("status-list");
    const statusDot = $("voice-status-dot");
    const statusText = $("voice-status-text");
    const tableInfo = $("table-info");
    const toastContainer = $("toast-container");
    // 唤醒相关
    const wakePanel = $("wake-panel");
    const wakeToggle = $("wake-toggle");
    const wakeWordInput = $("wake-word");
    const wakeGreetingInput = $("wake-greeting");
    const wakeHint = $("wake-hint");
    const wakeSupported = $("wake-supported");
    // TTS 播报
    const ttsToggle = $("tts-toggle");
    const ttsInfo = $("tts-info");
    const ttsStopBtn = document.querySelector(".tts-stop-btn");

    // ---------- 状态 ----------
    const state = {
        busy: false,
        recording: false,
        balls: null,       // 当前球局 [{id, x, y, alive}]
        recorder: null,    // AudioRecorder 实例
        partialBubble: null,   // 实时识别文字气泡 (边说边出字)
        partialTimer: null,    // 增量识别定时器
        partialText: "",       // 当前累积识别文本
        partialInFlight: false, // 是否有增量识别请求在飞
        // 语音唤醒
        wakeEnabled: false,
        wakeWord: "小八教练",
        wakeGreeting: "我在，请讲。",  // 唤醒后先播报的欢迎词 (空 = 不播报)
        wakeRecognizer: null,    // SpeechRecognition 实例
        wakeListening: false,    // 是否正在持续监听
        wakeTriggered: false,    // 已唤醒, 等待用户说话
        wakeRestartTimer: null,  // 自动重启定时器
        wakeCmdRecorder: null,   // 唤醒后接管录音的 WavRecorder
        wakeCmdTimer: null,      // 唤醒后录音计时
        // TTS 播报
        ttsMuted: false,         // 用户是否静音
        currentAudio: null,      // 当前播放的 HTMLAudioElement
        currentAudioUrl: "",     // 当前播放 URL (避免重复播)
        activeSync: null,        // 进行中的打字机+语音同步控制器 (停止播报时联动)
    };

    // ---------- 工具函数 ----------
    function toast(msg, type) {
        const el = document.createElement("div");
        el.className = "toast" + (type ? " " + type : "");
        el.textContent = msg;
        toastContainer.appendChild(el);
        setTimeout(() => el.remove(), 3200);
    }

    function scrollChatToBottom() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[c]);
    }

    // ---------- 消息渲染 ----------
    function addMessage(role, contentHtml, opts) {
        opts = opts || {};
        const msg = document.createElement("div");
        msg.className = "msg msg-" + role;
        if (opts.error) msg.classList.add("msg-error");
        if (opts.loading) msg.classList.add("msg-loading");
        const avatar = document.createElement("div");
        avatar.className = "msg-avatar";
        avatar.textContent = role === "user" ? "我" : "AI";
        const bubble = document.createElement("div");
        bubble.className = "msg-bubble";
        bubble.innerHTML = contentHtml;
        msg.appendChild(avatar);
        msg.appendChild(bubble);
        chatMessages.appendChild(msg);
        scrollChatToBottom();
        return bubble;
    }

    function renderToolCard(toolCall, execResult, latency) {
        const name = (toolCall && toolCall.name) || "";
        const args = (toolCall && toolCall.arguments) || {};
        const exec = execResult || {};
        const lines = [];

        if (name === "get_shot_recommendation") {
            const shot = exec.shot || {};
            const coach = exec.coach || {};
            lines.push(["目标球", shot.targetBall ?? "-"]);
            lines.push(["袋口", shot.pocketIdx ?? "-"]);
            lines.push(["切球角", (shot.cutAngle ?? 0).toFixed(1) + "°"]);
            lines.push(["力度", (shot.forceNewtons ?? 0).toFixed(1) + " N"]);
            lines.push(["击球点", `dx=${(shot.strikeDx ?? 0).toFixed(2)} dy=${(shot.strikeDy ?? 0).toFixed(2)}`]);
            lines.push(["进球率", ((shot.makeability ?? 0) * 100).toFixed(0) + "%"]);
            if (coach.headline) lines.push(["建议", coach.headline]);
            if (exec.summary) lines.push(["摘要", exec.summary]);
        } else if (name === "simulate_shot") {
            const p = exec.params || args;
            lines.push(["目标球", p.targetBallId ?? "-"]);
            lines.push(["袋口", p.pocketIdx ?? "-"]);
            lines.push(["力度", (p.forceNewtons ?? 0).toFixed(1) + " N"]);
            lines.push(["击球点", `dx=${(p.strikeDx ?? 0).toFixed(2)} dy=${(p.strikeDy ?? 0).toFixed(2)}`]);
            if (exec.message) lines.push(["提示", exec.message]);
        } else if (name === "set_table_layout") {
            const balls = exec.balls || [];
            lines.push(["布局", exec.layoutType || args.layoutType || "-"]);
            lines.push(["球数", balls.length]);
            if (balls.length > 0) {
                state.balls = balls;
                updateTableInfo();
            }
        } else {
            lines.push(["工具", name]);
            if (exec.error) lines.push(["错误", exec.error]);
            if (exec.message) lines.push(["提示", exec.message]);
        }

        const dl = lines.map(([k, v]) =>
            `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join("");
        const lat = latency ? `<div class="latency">耗时: ${latency} ms</div>` : "";
        return `<div class="tool-card">
            <div class="tool-card-head">⚙ TOOL · ${escapeHtml(name)}</div>
            <div class="tool-card-body"><dl>${dl}</dl></div>
            ${lat}
        </div>`;
    }

    function renderRagContext(ragContext) {
        if (!Array.isArray(ragContext) || ragContext.length === 0) return "";
        const items = ragContext.slice(0, 3).map((r) =>
            `<div style="margin-top:4px;font-size:11px;color:var(--text-2);">
                [${r.score}] ${escapeHtml((r.content || "").slice(0, 80))}...
            </div>`).join("");
        return `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);">
            <div style="font-size:11px;color:var(--text-2);font-family:var(--font-mono);">
                RAG 召回 ${ragContext.length} 条
            </div>${items}
        </div>`;
    }

    // ---------- 文本发送 ----------
    async function sendText(text) {
        if (state.busy) return;
        text = (text || "").trim();
        if (!text) return;

        addMessage("user", escapeHtml(text));
        textInput.value = "";

        const loadingBubble = addMessage("ai", "正在思考 ...", { loading: true });
        state.busy = true;
        sendBtn.disabled = true;

        try {
            const outcome = await streamVoiceReply("/api/voice/text", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: text }),
            }, loadingBubble);
            // 等打字机+语音播报同步完成, 再收尾渲染 (正文保留在打字气泡)
            await outcome.sync.wait();
            finishAiMessage(outcome.result, text, outcome.sync, loadingBubble);
        } catch (e) {
            loadingBubble.parentElement.remove();
            addMessage("ai", `请求失败: ${e.message}`, { error: true });
        } finally {
            state.busy = false;
            sendBtn.disabled = false;
        }
    }

    // ---------- 打字机 + 语音同步控制器 ----------
    // 后端句子级流式 TTS: LLM 每凑够一句立即合成并下发 audio 段;
    // 前端按序播放音频, 文字显示进度跟音频播放进度 (播到哪打到哪)。
    //
    // 模式状态机:
    //   init    — 尚无 delta (等待 LLM 出字)
    //   pending — 已有文字但首段音频未到 (气泡保持"正在思考", 6s 超时转 direct)
    //   sync    — 音频驱动打字 (核心模式: 播第 i 段时, 该段文字按播放进度逐字出)
    //   direct  — delta 直出 (静音 / TTS 不可用 / 首段超时 / 播放被拒 / 手动停止)
    function createTypingSyncController(bubble) {
        const ctrl = {
            bubble: bubble,       // 打字气泡 (.msg-bubble)
            typingSpan: null,     // 打字容器 span (惰性创建)
            mode: "init",
            fullText: "",         // 全部 delta 累积 (direct 显示源)
            segText: "",          // 已收到音频段文本累积 (sync 显示源)
            segments: [],         // {url, text, durationMs}
            playIdx: -1,          // 正在播放段序号
            lastEndedIdx: -1,     // 已播完(或跳过)的最后一段
            audioEl: null,
            playStartAt: 0,
            displayed: 0,         // 已显示字符数 (对当前显示源)
            tickTimer: null,
            pendTimer: null,      // 首段超时定时器
            streamEnded: false,   // done 事件已收
            stopAudio: false,     // 用户停止/静音/autoplay被拒 → 后续段不再播
            _resolveWait: null,
            _waitTimer: null,
        };

        // --- DOM ---

        function ensureTypingSpan() {
            if (ctrl.typingSpan || !ctrl.bubble.isConnected) return;
            const msgEl = ctrl.bubble.parentElement;
            if (msgEl) msgEl.classList.remove("msg-loading");
            ctrl.bubble.innerHTML =
                '<span class="typing-text"></span><span class="typing-cursor"></span>';
            ctrl.typingSpan = ctrl.bubble.querySelector(".typing-text");
        }

        // --- 同步模式: 播放进度 → 目标字符数 ---
        function syncTargetChars() {
            let n = 0;
            for (let i = 0; i < ctrl.segments.length && i <= ctrl.playIdx; i++) {
                if (i < ctrl.playIdx) {
                    n += ctrl.segments[i].text.length;
                } else {
                    // 当前段: 按实际播放进度映射 (duration 未就绪时用后端时长估算)
                    const a = ctrl.audioEl;
                    let p = 0;
                    if (a && a.duration && isFinite(a.duration) && a.duration > 0) {
                        p = a.currentTime / a.duration;
                    } else if (ctrl.segments[i].durationMs > 0) {
                        p = (Date.now() - ctrl.playStartAt) / ctrl.segments[i].durationMs;
                    }
                    n += ctrl.segments[i].text.length * Math.min(Math.max(p, 0), 1);
                }
            }
            return Math.floor(n);
        }

        // --- 统一打字 tick (60ms): 向目标字符数平滑推进 ---
        function tick() {
            if (!ctrl.bubble.isConnected) { dispose(true); return; }
            let target = 0, source = "";
            if (ctrl.mode === "sync") {
                source = ctrl.segText;
                target = syncTargetChars();
            } else {
                source = ctrl.fullText;
                target = ctrl.mode === "direct" ? ctrl.fullText.length : 0;
            }
            if (ctrl.displayed < target) {
                // sync 跟音频 (每 tick ≤2 字), direct 快速追赶 (≤3 字 ≈ 50字/s,
                // 快于 LLM 出字速度, 视觉等同 delta 直出)
                const speed = ctrl.mode === "sync" ? 2 : 3;
                ctrl.displayed = Math.min(target, ctrl.displayed + speed);
                ensureTypingSpan();
                ctrl.typingSpan.textContent = source.slice(0, ctrl.displayed);
                scrollChatToBottom();
            }
            checkDone();
        }

        // --- 段播放 (顺序链: 段 i ended → 段 i+1) ---
        // sync 模式驱动打字; direct 模式 (超时回退) 作为背景播报按序播放
        function playSegment(i) {
            if (ctrl.mode === "init" || ctrl.stopAudio || i >= ctrl.segments.length) return;
            const seg = ctrl.segments[i];
            const audio = new Audio(seg.url);
            audio.preload = "auto";
            ctrl.audioEl = audio;
            ctrl.playIdx = i;
            ctrl.playStartAt = Date.now();
            // 接入全局播报体系: 停止按钮 / 去重 / 唤醒监听跳过检测
            state.currentAudio = audio;
            state.currentAudioUrl = seg.url;
            if (ttsStopBtn) ttsStopBtn.hidden = false;
            const onSegOver = () => {
                ctrl.lastEndedIdx = Math.max(ctrl.lastEndedIdx, i);
                if (state.currentAudio === audio) {
                    state.currentAudio = null;
                    state.currentAudioUrl = "";
                }
                const next = i + 1;
                if (next < ctrl.segments.length) {
                    playSegment(next);
                } else {
                    // 最后一段: 若流已 done 则收尾, 否则等剩余段到达续播
                    if (ttsStopBtn) ttsStopBtn.hidden = true;
                    checkDone();
                }
            };
            audio.addEventListener("ended", onSegOver);
            // 该段音频加载失败: 跳段 (文字照常显示, 只是这句没声音)
            audio.addEventListener("error", onSegOver);
            const p = audio.play();
            if (p && p.catch) p.catch(() => abandonSync("autoplay"));
        }

        // --- 放弃同步打字 → 直出 ---
        // 超时类回退 (first-seg-timeout / stream-end / wait-timeout): 仅文字转直出,
        //   后续到达的音频段仍按序背景播报 (保证语音不丢);
        // 用户停止/静音/autoplay 被拒: 同时停止接收后续段
        function abandonSync(reason) {
            if (ctrl.mode === "direct" || ctrl.mode === "init") { checkDone(); return; }
            if (reason === "user-stop" || reason === "autoplay") {
                ctrl.stopAudio = true;
                if (ctrl.audioEl) {
                    try { ctrl.audioEl.pause(); } catch (_) {}
                    if (state.currentAudio === ctrl.audioEl) {
                        state.currentAudio = null;
                        state.currentAudioUrl = "";
                    }
                    ctrl.audioEl = null;
                }
                if (ttsStopBtn) ttsStopBtn.hidden = true;
            }
            if (ctrl.pendTimer) { clearTimeout(ctrl.pendTimer); ctrl.pendTimer = null; }
            // activeSync 保留注册 (direct 模式下 stopTTSPlayback 仍能经它拦住后续段), dispose 时统一清
            ctrl.mode = "direct";
            // 已显示字符保留 (segText 是 fullText 前缀, 正常无跳变), 剩余快速补完
            ctrl.displayed = ctrl.typingSpan ? ctrl.typingSpan.textContent.length : 0;
            checkDone();
        }

        // --- 事件入口 ---

        ctrl.onDelta = function (text) {
            const first = ctrl.mode === "init";
            ctrl.fullText += (text || "");
            if (!first) return;
            // 首个 delta: 决定等待音频还是直出
            if (!state.ttsMuted && !ttsToggle.disabled) {
                ctrl.mode = "pending";
                // 首段 6s 未到 (TTS 挂了/极慢) → 直出, 保证文字不卡死
                ctrl.pendTimer = setTimeout(() => abandonSync("first-seg-timeout"), 6000);
            } else {
                ctrl.mode = "direct";
            }
        };

        ctrl.onAudioSegment = function (seg) {
            if (ctrl.mode === "init" || ctrl.stopAudio) return;
            ctrl.segments.push(seg);
            ctrl.segText += seg.text || "";
            if (ctrl.mode === "pending") {
                if (ctrl.pendTimer) { clearTimeout(ctrl.pendTimer); ctrl.pendTimer = null; }
                ctrl.mode = "sync";
                state.activeSync = ctrl;
                playSegment(0);
            } else {
                // sync: 段间 gap 续播 / direct: 超时回退后音频段仍按序背景播报
                const next = ctrl.lastEndedIdx + 1;
                const idle = !ctrl.audioEl || ctrl.audioEl.ended || ctrl.audioEl.paused;
                if (idle && next === ctrl.segments.length - 1) {
                    playSegment(next);
                }
            }
        };

        ctrl.onStreamEnd = function () {
            ctrl.streamEnded = true;
            // 流已结束仍无音频段 (回复太短没成句/合成全失败) → 不等 6s 超时, 立即直出
            if (ctrl.mode === "pending") abandonSync("stream-end-no-seg");
            checkDone();
        };

        // --- 完成等待 (调用方 await sync.wait() 后再收尾渲染) ---

        function isAllPlayed() {
            return ctrl.segments.length > 0 &&
                   ctrl.lastEndedIdx === ctrl.segments.length - 1;
        }

        function isFinished() {
            if (!ctrl.streamEnded) return false;
            if (ctrl.mode === "sync") {
                return isAllPlayed() && ctrl.displayed >= ctrl.segText.length;
            }
            return ctrl.displayed >= ctrl.fullText.length;
        }

        function checkDone() {
            if (isFinished() && ctrl._resolveWait) {
                const r = ctrl._resolveWait;
                ctrl._resolveWait = null;
                if (ctrl._waitTimer) { clearTimeout(ctrl._waitTimer); ctrl._waitTimer = null; }
                r();
            }
        }

        ctrl.wait = function () {
            return new Promise((resolve) => {
                if (isFinished()) { resolve(); return; }
                ctrl._resolveWait = resolve;
                // 兜底: 音频卡死/时钟异常时最长等 25s (超时切直出补完再放行)
                ctrl._waitTimer = setTimeout(() => {
                    abandonSync("wait-timeout");
                    if (ctrl._resolveWait) {
                        const r = ctrl._resolveWait;
                        ctrl._resolveWait = null;
                        r();
                    }
                }, 25000);
            });
        };

        function dispose(stopAudio) {
            if (ctrl.tickTimer) { clearInterval(ctrl.tickTimer); ctrl.tickTimer = null; }
            if (ctrl.pendTimer) { clearTimeout(ctrl.pendTimer); ctrl.pendTimer = null; }
            if (ctrl._waitTimer) { clearTimeout(ctrl._waitTimer); ctrl._waitTimer = null; }
            if (stopAudio && ctrl.audioEl) {
                try { ctrl.audioEl.pause(); } catch (_) {}
            }
            if (state.activeSync === ctrl) state.activeSync = null;
            if (ctrl._resolveWait) {
                const r = ctrl._resolveWait;
                ctrl._resolveWait = null;
                r();
            }
        }
        ctrl.dispose = dispose;
        ctrl.abandon = abandonSync;

        ctrl.tickTimer = setInterval(tick, 60);
        return ctrl;
    }

    // ---------- 流式请求 (SSE 打字机 + 句子级语音同步) ----------
    // 帧格式 (text/event-stream): data: {json}\n\n
    // 事件: {"type":"asr","text"} {"type":"stage","text"} {"type":"delta","text"}
    //       {"type":"audio","url","text","duration_ms","index"} (句子级 TTS 段)
    //       {"type":"done","result"} {"type":"error","error"}
    // 返回: {result, sync} — sync.wait() 等"打字+播报"完成后由调用方收尾渲染
    async function streamVoiceReply(url, init, loadingBubble) {
        const resp = await fetch(url, init);
        if (!resp.ok || !resp.body) {
            throw new Error(`HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buf = "";
        let result = null;
        const bubble = loadingBubble;
        const sync = createTypingSyncController(bubble);

        const onEvent = (ev) => {
            if (!ev || typeof ev.type !== "string") return;
            if (ev.type === "asr") {
                if (!sync.typingSpan) {
                    bubble.innerHTML = `🤔 已识别: “${escapeHtml(ev.text || "")}” 思考中 ...`;
                }
            } else if (ev.type === "stage") {
                if (!sync.typingSpan) {
                    bubble.innerHTML = escapeHtml(ev.text || "...");
                }
            } else if (ev.type === "delta") {
                sync.onDelta(ev.text || "");
            } else if (ev.type === "audio") {
                sync.onAudioSegment({
                    url: ev.url || "",
                    text: ev.text || "",
                    durationMs: ev.duration_ms || 0,
                    index: ev.index || 0,
                });
            }
        };

        // SSE 事件块: 以空行 (\n\n) 分界; 块内取 data: 行 (允许 "data: " 带空格)
        const parseSseBlock = (block) => {
            const dataLines = [];
            for (const l of block.split("\n")) {
                if (l.startsWith("data:")) {
                    dataLines.push(l.startsWith("data: ") ? l.slice(6) : l.slice(5));
                }
            }
            if (!dataLines.length) return null;
            const payload = dataLines.join("\n");
            try { return JSON.parse(payload); } catch (e) { return null; }
        };

        try {
            while (true) {
                const { done, value} = await reader.read();
                if (done) break;
                buf += decoder.decode(value, {stream: true});
                let sep;
                while ((sep = buf.indexOf("\n\n")) !== -1) {
                    const block = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    const ev = parseSseBlock(block);
                    if (!ev) continue;
                    if (ev.type === "done") { result = ev.result || null; continue; }
                    if (ev.type === "error") { throw new Error(ev.error || "链路异常"); }
                    onEvent(ev);
                }
            }
        } catch (e) {
            sync.dispose(true);
            throw e;
        }
        sync.onStreamEnd();
        if (result === null) {
            sync.dispose(true);
            throw new Error("连接中断, 未收到完整结果");
        }
        return { result, sync };
    }

    // 回复附加信息 (ASR 修正/错误/工具卡/RAG/耗时) — 整段渲染与流式收尾共用
    function buildReplyExtras(data, userInput) {
        const parts = [];
        if (data.asr_text && data.asr_text !== userInput) {
            parts.push(`<p style="color:var(--text-2);font-size:12px;">🎤 ASR: ${escapeHtml(data.asr_text)}</p>`);
        }
        if (Array.isArray(data.errors) && data.errors.length > 0) {
            parts.push(`<p style="color:var(--coral-soft);font-size:12px;">⚠ ${data.errors.map(escapeHtml).join("; ")}</p>`);
        }
        const toolHtml = data.tool_call
            ? renderToolCard(data.tool_call, data.execution_result, (data.latency_ms || {}).execute)
            : "";
        const ragHtml = renderRagContext(data.rag_context);
        const lat = data.latency_ms || {};
        const latSummary = lat.total
            ? `<div style="margin-top:8px;font-size:11px;color:var(--text-3);font-family:var(--font-mono);">
                总耗时 ${lat.total}ms (ASR ${lat.asr || 0} / RAG ${lat.rag || 0} /
                主LLM ${lat.main_llm || 0} / 次LLM ${lat.secondary_llm || 0} / 执行 ${lat.execute || 0}
                ${lat.tts ? " / TTS " + lat.tts : ""})
              </div>`
            : "";
        return { head: parts.join(""), tool: toolHtml, rag: ragHtml, lat: latSummary };
    }

    // 流式同步收尾: 正文已随语音打出, 保留打字气泡, 去光标并追加附加信息
    function finalizeStreamingBubble(data, userInput, bubble) {
        const msgEl = bubble.parentElement;
        if (msgEl) msgEl.classList.remove("msg-loading");
        const cursor = bubble.querySelector(".typing-cursor");
        if (cursor) cursor.remove();
        const extras = buildReplyExtras(data, userInput);
        if (extras.head || extras.tool || extras.rag || extras.lat) {
            const extra = document.createElement("div");
            extra.innerHTML = extras.head + extras.tool + extras.rag + extras.lat;
            bubble.appendChild(extra);
        }
        scrollChatToBottom();
    }

    // 流式请求收尾: 同步模式保留气泡, 否则移除气泡整段渲染
    function finishAiMessage(data, userInput, sync, loadingBubble) {
        const streamed = sync && sync.mode === "sync" &&
                         sync.segments.length > 0 && sync.typingSpan;
        if (streamed && loadingBubble && loadingBubble.isConnected) {
            finalizeStreamingBubble(data, userInput, loadingBubble);
            sync.dispose(false);
            return;
        }
        if (loadingBubble && loadingBubble.parentElement) {
            loadingBubble.parentElement.remove();
        }
        // direct 模式: 清打字定时器, 但不停背景播报 (音频段还在按序播)
        if (sync) sync.dispose(false);
        renderAiReply(data, userInput);
    }

    function renderAiReply(data, userInput) {
        const extras = buildReplyExtras(data, userInput);
        const replyHtml = data.reply ? `<p>${escapeHtml(data.reply)}</p>` : "";
        addMessage("ai", replyHtml + extras.head + extras.tool + extras.rag + extras.lat);

        // ===== TTS 播报: LLM 正常响应时同步播放 =====
        // (句子级流式模式 audio_url 为空 → 不重复播, 段音频已在流式阶段播出)
        if (data.audio && data.audio.audio_url) {
            playTTSReply(data.audio);
        }
    }

    // ---------- TTS 语音播报 ----------
    function playTTSReply(audioInfo) {
        if (!audioInfo || !audioInfo.audio_url) return;
        if (state.ttsMuted) {
            // 用户静音, 不播但 toast 提示一下
            return;
        }
        const url = audioInfo.audio_url;
        // 跳过相同 URL 连续播 (避免 /api/voice/text 和 /api/voice/chat 触发两次时双播)
        if (state.currentAudioUrl === url && state.currentAudio && !state.currentAudio.paused) {
            return;
        }
        // 停掉上一次播报
        stopTTSPlayback();
        try {
            const audio = new Audio(url);
            audio.preload = "auto";
            state.currentAudio = audio;
            state.currentAudioUrl = url;
            if (ttsStopBtn) ttsStopBtn.hidden = false;
            audio.addEventListener("ended", () => {
                if (state.currentAudio === audio) {
                    state.currentAudio = null;
                    state.currentAudioUrl = "";
                    if (ttsStopBtn) ttsStopBtn.hidden = true;
                }
            });
            audio.addEventListener("error", () => {
                if (state.currentAudio === audio) {
                    state.currentAudio = null;
                    state.currentAudioUrl = "";
                    if (ttsStopBtn) ttsStopBtn.hidden = true;
                }
                // 静默处理: 后端会自己 log 错误, 前端不打扰用户
            });
            audio.play().catch(() => {
                // 浏览器自动播策略可能阻断 (用户未交互), 静默忽略
                if (ttsStopBtn) ttsStopBtn.hidden = true;
                state.currentAudio = null;
            });
        } catch (e) {
            // 浏览器不支持 Audio 或网络错误
            state.currentAudio = null;
        }
    }

    function stopTTSPlayback() {
        if (state.currentAudio) {
            try {
                state.currentAudio.pause();
                state.currentAudio.currentTime = 0;
            } catch (_) {}
            state.currentAudio = null;
            state.currentAudioUrl = "";
        }
        // 停止流式同步播报: 剩余段不再播, 打字机切直出补完剩余文字
        if (state.activeSync) {
            state.activeSync.abandon("user-stop");
        }
        if (ttsStopBtn) ttsStopBtn.hidden = true;
    }

    function toggleTTSMute() {
        state.ttsMuted = !ttsToggle.checked;
        try {
            localStorage.setItem("voice_tts_muted", state.ttsMuted ? "1" : "0");
        } catch (_) {}
        if (state.ttsMuted) {
            stopTTSPlayback();
            toast("已静音语音播报", "info");
        } else {
            toast("已开启语音播报", "success");
        }
    }

    async function testTTS() {
        if (ttsToggle.disabled) {
            toast("TTS 服务不可用, 无法试听", "error");
            return;
        }
        const testText = "您好, 我是中式八球 AI 智能教练, 很高兴为您服务。";
        try {
            const resp = await fetch("/api/voice/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: testText }),
            });
            const data = await resp.json();
            if (data.status === "ok" && data.audio_url) {
                playTTSReply(data);
            } else {
                toast(`试听失败: ${data.error || "未知错误"}`, "error");
            }
        } catch (e) {
            toast(`试听请求失败: ${e.message}`, "error");
        }
    }

    function loadTTSPreference() {
        // 从 localStorage 恢复静音状态
        try {
            const muted = localStorage.getItem("voice_tts_muted");
            if (muted === "1") {
                ttsToggle.checked = false;
                state.ttsMuted = true;
            }
        } catch (_) {}
    }

    function loadWakeGreeting() {
        // 从 localStorage 恢复唤醒欢迎词 (空字符串 = 不播报)
        try {
            const saved = localStorage.getItem("voice_wake_greeting");
            if (saved !== null) wakeGreetingInput.value = saved;
        } catch (_) {}
        state.wakeGreeting = wakeGreetingInput.value;
    }

    // ---------- 录音 ----------
    class WavRecorder {
        constructor() {
            this.chunks = [];
            this.stream = null;
            this.context = null;
            this.processor = null;
            this.source = null;
            this.startTime = 0;
            this.lastSentChunkIndex = 0;
        }

        async start() {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    // 关闭浏览器内置处理, 保留原始波形给 ASR
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });
            // 浏览器通常忽略 sampleRate 约束, 读实际采样率后面再重采样
            this.context = new (window.AudioContext || window.webkitAudioContext)();
            this.actualSampleRate = this.context.sampleRate;
            this.source = this.context.createMediaStreamSource(this.stream);
            this.processor = this.context.createScriptProcessor(4096, 1, 1);
            this.chunks = [];
            this.lastSentChunkIndex = 0;
            this.processor.onaudioprocess = (e) => {
                const ch = e.inputBuffer.getChannelData(0);
                // 拷贝一份 (Float32Array)
                this.chunks.push(new Float32Array(ch));
            };
            this.source.connect(this.processor);
            this.processor.connect(this.context.destination);
            this.startTime = Date.now();
        }

        stop() {
            if (this.processor) this.processor.disconnect();
            if (this.source) this.source.disconnect();
            if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
            if (this.context) this.context.close();
            return this._encodeWav(this.chunks);
        }

        // 编码 WAV (含重采样到 16kHz)
        _encodeWav(chunksArr) {
            // 合并 chunks
            let totalLen = 0;
            for (const c of chunksArr) totalLen += c.length;
            if (totalLen === 0) return null;
            const rawSamples = new Float32Array(totalLen);
            let offset = 0;
            for (const c of chunksArr) {
                rawSamples.set(c, offset);
                offset += c.length;
            }
            return WavRecorder.encodeWav(rawSamples, this.actualSampleRate || 16000);
        }

        // Float32 采样 (srcRate) → 16kHz mono 16bit WAV Blob
        static encodeWav(rawSamples, srcRate) {
            const targetRate = 16000;
            const numChannels = 1;
            srcRate = srcRate || targetRate;
            // 线性插值重采样到 16kHz
            let samples;
            if (srcRate !== targetRate) {
                const ratio = srcRate / targetRate;
                const newLen = Math.floor(rawSamples.length / ratio);
                samples = new Float32Array(newLen);
                for (let i = 0; i < newLen; i++) {
                    const srcIdx = i * ratio;
                    const i0 = Math.floor(srcIdx);
                    const i1 = Math.min(i0 + 1, rawSamples.length - 1);
                    const frac = srcIdx - i0;
                    samples[i] = rawSamples[i0] * (1 - frac) + rawSamples[i1] * frac;
                }
            } else {
                samples = rawSamples;
            }
            // Float32 → Int16 PCM
            const pcm = new Int16Array(samples.length);
            for (let i = 0; i < samples.length; i++) {
                const s = Math.max(-1, Math.min(1, samples[i]));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            // WAV header (44 bytes) + PCM data
            const buf = new ArrayBuffer(44 + pcm.length * 2);
            const view = new DataView(buf);
            const writeStr = (off, s) => {
                for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
            };
            writeStr(0, "RIFF");
            view.setUint32(4, 36 + pcm.length * 2, true);
            writeStr(8, "WAVE");
            writeStr(12, "fmt ");
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, numChannels, true);
            view.setUint32(24, targetRate, true);
            view.setUint32(28, targetRate * numChannels * 2, true);
            view.setUint16(32, numChannels * 2, true);
            view.setUint16(34, 16, true);
            writeStr(36, "data");
            view.setUint32(40, pcm.length * 2, true);
            // PCM 数据
            const pcmBytes = new Uint8Array(buf, 44);
            const dv = new DataView(pcmBytes.buffer, 44);
            for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i], true);
            return new Blob([buf], { type: "audio/wav" });
        }

        elapsed() {
            return Math.floor((Date.now() - this.startTime) / 1000);
        }

        // 取上次发送点之后的新增 chunks, 用于增量识别
        getIncrementalWav() {
            if (this.chunks.length <= this.lastSentChunkIndex) return null;
            const newChunks = this.chunks.slice(this.lastSentChunkIndex);
            this.lastSentChunkIndex = this.chunks.length;
            return this._encodeWav(newChunks);
        }
    }

    let recTimerInterval = null;

    // ============================================================
    // 本地 ASR 唤醒监听
    // 持续录音, 每 2.5s 把最近 3s 音频送 /api/voice/asr 检测唤醒词。
    // 浏览器 SpeechRecognition 在 Chrome 下走 Google 云服务 (大陆网络不可达),
    // 本地 ASR 才是可靠通道; 两者任一命中即唤醒。
    // ============================================================
    class WakeAsrListener {
        constructor(onDetect) {
            this.onDetect = onDetect;   // (text) => void
            this.stream = null;
            this.context = null;
            this.processor = null;
            this.source = null;
            this.rolling = [];          // 最近音频块 (context 采样率)
            this.rollingLen = 0;
            this.actualSampleRate = 48000;
            this.timer = null;
            this.active = false;        // 麦克风流是否打开
            this.polling = false;       // false = 暂停检测 (唤醒指令录音/播报中)
            this.inFlight = false;
            this.failCount = 0;
            this.warned = false;
            this.gen = 0;               // start/stop 竞态令牌
            this._starting = false;
        }

        async start() {
            if (this.active || this._starting) return;
            this._starting = true;
            const myGen = ++this.gen;
            let stream, context, source, processor;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        channelCount: 1,
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                    },
                });
                // getUserMedia 等待期间可能已被 stop(), 直接释放
                if (myGen !== this.gen) {
                    stream.getTracks().forEach((t) => t.stop());
                    this._starting = false;
                    return;
                }
                context = new (window.AudioContext || window.webkitAudioContext)();
                this.actualSampleRate = context.sampleRate;
                source = context.createMediaStreamSource(stream);
                processor = context.createScriptProcessor(4096, 1, 1);
                const maxKeep = Math.ceil(4.5 * this.actualSampleRate);
                processor.onaudioprocess = (e) => {
                    const ch = e.inputBuffer.getChannelData(0);
                    this.rolling.push(new Float32Array(ch));
                    this.rollingLen += ch.length;
                    while (this.rollingLen > maxKeep) {
                        this.rollingLen -= this.rolling.shift().length;
                    }
                };
                source.connect(processor);
                processor.connect(context.destination);
            } catch (e) {
                if (stream) stream.getTracks().forEach((t) => t.stop());
                if (context) { try { context.close(); } catch (_) {} }
                this._starting = false;
                throw e;
            }
            this.stream = stream;
            this.context = context;
            this.source = source;
            this.processor = processor;
            this.rolling = [];
            this.rollingLen = 0;
            this._starting = false;
            this.active = true;
            this.polling = true;
            this.failCount = 0;
            this.warned = false;
            if (this.timer) clearInterval(this.timer);
            this.timer = setInterval(() => this._poll(), 2500);
        }

        stop() {
            this.gen++;
            this.polling = false;
            this.active = false;
            if (this.timer) { clearInterval(this.timer); this.timer = null; }
            if (this.processor) this.processor.disconnect();
            if (this.source) this.source.disconnect();
            if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
            if (this.context) { try { this.context.close(); } catch (_) {} }
            this.processor = this.source = this.stream = this.context = null;
            this.rolling = [];
            this.rollingLen = 0;
        }

        pause() { this.polling = false; }

        resume() {
            this.polling = true;
            this.failCount = 0;
            this.warned = false;
        }

        // 取最近 need 个采样
        _tail(need) {
            const out = new Float32Array(need);
            let off = need;
            for (let i = this.rolling.length - 1; i >= 0 && off > 0; i--) {
                const c = this.rolling[i];
                const take = Math.min(c.length, off);
                out.set(c.subarray(c.length - take), off - take);
                off -= take;
            }
            return out;
        }

        async _poll() {
            if (!this.active || !this.polling || this.inFlight) return;
            // 忙碌/手动录音/已唤醒/页面隐藏/TTS 播报中 → 跳过 (防 TTS 自唤醒)
            if (state.busy || state.recording || state.wakeTriggered ||
                document.hidden || state.currentAudio) return;
            const windowSamples = Math.floor(3 * this.actualSampleRate);
            if (this.rollingLen < Math.floor(windowSamples * 0.4)) return;
            const blob = WavRecorder.encodeWav(this._tail(windowSamples), this.actualSampleRate);
            if (!blob) return;
            this.inFlight = true;
            try {
                const fd = new FormData();
                fd.append("audio", blob, "wake_probe.wav");
                const resp = await fetch("/api/voice/asr", { method: "POST", body: fd });
                const data = await resp.json();
                this.failCount = 0;
                if (this.warned) {
                    this.warned = false;
                    if (state.wakeEnabled && !state.wakeTriggered) {
                        setWakeHint(`监听中 · 请说"${state.wakeWord}"唤醒`, "listening");
                    }
                }
                const text = (data.text || "").trim();
                if (text && !state.wakeTriggered && matchWakeWord(text, state.wakeWord)) {
                    this.onDetect(text);
                }
            } catch (_) {
                this.failCount++;
                if (this.failCount >= 3 && !this.warned) {
                    this.warned = true;
                    setWakeHint("本地 ASR 服务不可达, 唤醒暂时失效", "");
                }
            } finally {
                this.inFlight = false;
            }
        }
    }

    const wakeAsr = new WakeAsrListener((text) => triggerWake());

    async function startRecording() {
        if (state.busy || state.recording) return;
        try {
            state.recorder = new WavRecorder();
            await state.recorder.start();
            state.recording = true;
            micBtn.classList.add("recording");
            recordingBar.hidden = false;
            recTimer.textContent = "00:00";
            recTimerInterval = setInterval(() => {
                const s = state.recorder.elapsed();
                recTimer.textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" +
                                       String(s % 60).padStart(2, "0");
            }, 500);
            // 创建实时识别气泡, 启动增量识别 (每 2 秒一次)
            state.partialText = "";
            state.partialInFlight = false;
            state.partialBubble = addMessage("user",
                '<span style="color:var(--text-3);">🎤 正在聆听...</span>');
            state.partialTimer = setInterval(runPartialAsr, 2000);
        } catch (e) {
            state.recording = false;
            toast("麦克风授权失败: " + e.message, "error");
            state.recorder = null;
        }
    }

    // 增量识别: 上传新增片段, 识别结果追加到已有文本
    async function runPartialAsr() {
        if (!state.recording || !state.recorder || state.partialInFlight) return;
        const blob = state.recorder.getIncrementalWav();
        if (!blob || blob.size < 6400) return; // < 0.2s 跳过
        state.partialInFlight = true;
        try {
            const fd = new FormData();
            fd.append("audio", blob, "partial.wav");
            const resp = await fetch("/api/voice/asr", { method: "POST", body: fd });
            const data = await resp.json();
            const text = (data.text || "").trim();
            if (text) {
                state.partialText = state.partialText
                    ? state.partialText + text
                    : text;
                if (state.partialBubble) {
                    state.partialBubble.innerHTML =
                        '<span style="color:var(--text-2);">🎤 ' + escapeHtml(state.partialText) +
                        '</span><span class="partial-cursor">▌</span>';
                    scrollChatToBottom();
                }
            }
        } catch (e) {
            // 增量识别失败静默忽略, 不打断录音
        } finally {
            state.partialInFlight = false;
        }
    }

    async function stopRecording(cancel) {
        if (!state.recording || !state.recorder) return;
        state.recording = false;
        micBtn.classList.remove("recording");
        recordingBar.hidden = true;
        if (recTimerInterval) {
            clearInterval(recTimerInterval);
            recTimerInterval = null;
        }
        if (state.partialTimer) {
            clearInterval(state.partialTimer);
            state.partialTimer = null;
        }
        // 等待可能还在飞的增量识别
        const waitPartial = async () => {
            const start = Date.now();
            while (state.partialInFlight && Date.now() - start < 3000) {
                await new Promise(r => setTimeout(r, 100));
            }
        };
        await waitPartial();

        const blob = state.recorder.stop();
        const finalText = state.partialText;
        state.recorder = null;

        if (cancel || !blob) {
            if (state.partialBubble) {
                state.partialBubble.parentElement.remove();
                state.partialBubble = null;
            }
            state.partialText = "";
            if (cancel) toast("已取消录音");
            return;
        }

        // 把实时识别气泡转成最终用户消息 (去掉光标)
        if (state.partialBubble) {
            const duration = blob.size / 32000;
            if (finalText) {
                state.partialBubble.innerHTML =
                    '🎤 ' + escapeHtml(finalText) +
                    '<span style="color:var(--text-3);font-size:11px;margin-left:6px;">(' +
                    duration.toFixed(1) + 's)</span>';
            } else {
                // 增量识别没出文字, 显示占位
                state.partialBubble.innerHTML =
                    '🎤 语音输入 (' + duration.toFixed(1) + 's)';
            }
            state.partialBubble = null;
        }
        state.partialText = "";

        await sendAudio(blob);
    }

    async function sendAudio(blob) {
        if (state.busy) return;
        const duration = blob.size / 32000; // 16kHz mono 16bit ≈ 32KB/s
        if (duration < 0.3) {
            toast("录音太短, 请按住麦克风说久一点", "error");
            return;
        }
        // 用户消息气泡已由 stopRecording 创建 (含实时识别文字), 这里只加 AI 加载气泡
        const loadingBubble = addMessage("ai", "正在识别并思考 ...", { loading: true });
        state.busy = true;
        sendBtn.disabled = true;

        try {
            const fd = new FormData();
            fd.append("audio", blob, "input.wav");
            const outcome = await streamVoiceReply("/api/voice/chat", { method: "POST", body: fd }, loadingBubble);
            await outcome.sync.wait();
            finishAiMessage(outcome.result, outcome.result.asr_text || "", outcome.sync, loadingBubble);
        } catch (e) {
            loadingBubble.parentElement.remove();
            addMessage("ai", `请求失败: ${e.message}`, { error: true });
        } finally {
            state.busy = false;
            sendBtn.disabled = false;
        }
    }

    // ---------- 快捷操作 ----------
    async function executeTool(toolName, args) {
        if (state.busy) return;
        const loadingBubble = addMessage("ai", "正在执行 ...", { loading: true });
        state.busy = true;
        sendBtn.disabled = true;
        try {
            const resp = await fetch("/api/voice/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tool_name: toolName, arguments: args }),
            });
            const data = await resp.json();
            loadingBubble.parentElement.remove();
            const toolCall = { name: toolName, arguments: args };
            const reply = data.status === "ok"
                ? `<p>已执行操作: ${escapeHtml(toolName)}</p>`
                : `<p style="color:var(--coral-soft);">执行失败: ${escapeHtml(data.error || "未知错误")}</p>`;
            addMessage("ai", reply + renderToolCard(toolCall, data, null));
        } catch (e) {
            loadingBubble.parentElement.remove();
            addMessage("ai", `请求失败: ${e.message}`, { error: true });
        } finally {
            state.busy = false;
            sendBtn.disabled = false;
        }
    }

    function updateTableInfo() {
        if (!state.balls || state.balls.length === 0) {
            tableInfo.innerHTML = '<p class="muted">尚未摆球, 点击"标准开局"或对 AI 说"标准开局"。</p>';
            return;
        }
        const alive = state.balls.filter((b) => b.alive && b.id !== 0).length;
        const cue = state.balls.find((b) => b.id === 0);
        const cueStr = cue ? `(${cue.x.toFixed(2)}, ${cue.y.toFixed(2)})` : "-";
        tableInfo.innerHTML = `
            <div>目标球: <span class="ball-count">${alive}</span> 颗</div>
            <div style="margin-top:4px;color:var(--text-2);">母球: ${cueStr}</div>
        `;
    }

    // ---------- 服务状态 ----------
    async function loadStatus() {
        try {
            const resp = await fetch("/api/voice/status");
            const data = await resp.json();
            renderStatus(data);
        } catch (e) {
            statusDot.className = "status-dot offline";
            statusText.textContent = "服务离线";
            statusList.innerHTML = `<li><span class="k">错误</span><span class="v err">${escapeHtml(e.message)}</span></li>`;
        }
    }

    function renderStatus(data) {
        const items = [
            ["ASR", data.asr_endpoint],
            ["主 LLM", data.main_llm_model + " @ " + data.main_llm_base_url],
            ["次级 LLM", data.secondary_llm_base_url],
            ["Embedding", data.embedding_model + " @ " + data.embedding_base_url],
            ["RAG 集合", data.rag_collection],
            ["知识库块数", data.rag_chunks],
        ];
        statusList.innerHTML = items.map(([k, v]) =>
            `<li><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></li>`
        ).join("");
        statusDot.className = "status-dot online";
        statusText.textContent = "服务就绪";
        // TTS 状态面板
        renderTtsInfo(data.tts);
    }

    function renderTtsInfo(tts) {
        if (!tts) {
            ttsInfo.innerHTML = '<span style="color:var(--coral-soft);">未连接 TTS 服务</span>';
            ttsToggle.disabled = true;
            return;
        }
        if (!tts.available) {
            ttsInfo.innerHTML = `<span style="color:var(--coral-soft);">⚠ TTS 不可用: ${escapeHtml(tts.reason || "无可用后端")}</span>`;
            ttsToggle.disabled = true;
            return;
        }
        ttsToggle.disabled = false;
        const backends = (tts.available_backends || []).join(" / ") || "-";
        const cacheKb = tts.cache_bytes ? Math.round(tts.cache_bytes / 1024) : 0;
        ttsInfo.innerHTML = `
            <div>后端: <span class="v">${escapeHtml(backends)}</span></div>
            <div style="margin-top:4px;">发音人: <span class="v">${escapeHtml(tts.voice || "-")}</span></div>
            <div style="margin-top:4px;">缓存: <span class="v">${tts.cache_files || 0} 个 · ${cacheKb} KB</span></div>
        `;
    }

    // ============================================================
    // 语音唤醒 (SpeechRecognition 持续监听唤醒词)
    // ============================================================
    const SpeechRecognitionImpl =
        window.SpeechRecognition || window.webkitSpeechRecognition || null;

    function isWakeSupported() {
        return !!SpeechRecognitionImpl;
    }

    function normalizeText(s) {
        // 去标点 + 转小写 + 全角转半角 + 去空格
        return String(s || "")
            .replace(/[\s,，。.!！?？、;；:：""''""'']/g, "")
            .toLowerCase()
            .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
                String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    }

    function matchWakeWord(transcript, wakeWord) {
        const t = normalizeText(transcript);
        const w = normalizeText(wakeWord);
        if (!w) return false;
        // 完全包含 或 编辑距离 <= 1 (容忍识别误差)
        if (t.includes(w)) return true;
        return levenshtein(t, w) <= 1 && Math.abs(t.length - w.length) <= 1;
    }

    function levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (!m) return n;
        if (!n) return m;
        const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
            }
        }
        return dp[m][n];
    }

    function setWakeHint(text, cls) {
        wakeHint.textContent = text;
        wakeHint.className = "wake-hint" + (cls ? " " + cls : "");
    }

    function setWakePanelState(cls) {
        wakePanel.classList.remove("activated", "listening");
        if (cls) wakePanel.classList.add(cls);
    }

    // 原生 SpeechRecognition 监听 (低延迟补充通道, 失败不影响本地 ASR 唤醒)
    function startWakeRecognizer() {
        if (!isWakeSupported() || state.wakeRecognizer) return;
        const rec = new SpeechRecognitionImpl();
        rec.lang = "zh-CN";
        rec.continuous = true;       // 持续监听
        rec.interimResults = true;   // 返回中间结果, 提升响应速度
        rec.maxAlternatives = 3;

        rec.onresult = (event) => {
            // 多候选任一命中即唤醒
            let matched = false;
            for (let i = event.resultIndex; i < event.results.length; i++) {
                for (let alt = 0; alt < event.results[i].length; alt++) {
                    if (matchWakeWord(event.results[i][alt].transcript, state.wakeWord)) {
                        matched = true;
                        break;
                    }
                }
                if (matched) break;
            }
            if (matched && !state.wakeTriggered) {
                triggerWake();
            }
        };

        rec.onerror = (e) => {
            // no-speech / network / not-allowed 等
            if (e.error === "not-allowed" || e.error === "service-not-allowed") {
                handleMicDenied();
                return;
            }
            // 其余错误: 本地 ASR 兜底仍在跑, 不打扰用户
            if (!wakeAsr.active) setWakeHint(`识别异常 (${e.error}), 3秒后重启...`, "");
        };

        rec.onend = () => {
            // 自动重启 (除非用户主动关闭/页面隐藏)
            if (state.wakeEnabled && !state.wakeTriggered &&
                state.wakeRecognizer === rec && !document.hidden) {
                if (state.wakeRestartTimer) clearTimeout(state.wakeRestartTimer);
                state.wakeRestartTimer = setTimeout(() => {
                    if (state.wakeEnabled && !state.wakeTriggered &&
                        state.wakeRecognizer === rec && !document.hidden) {
                        try { rec.start(); } catch (_) {}
                    }
                }, 800);
            }
        };

        state.wakeRecognizer = rec;
        try {
            rec.start();
        } catch (_) {}
    }

    function stopWakeRecognizer() {
        if (state.wakeRestartTimer) {
            clearTimeout(state.wakeRestartTimer);
            state.wakeRestartTimer = null;
        }
        if (state.wakeRecognizer) {
            try {
                state.wakeRecognizer.onend = null;
                state.wakeRecognizer.onresult = null;
                state.wakeRecognizer.onerror = null;
                state.wakeRecognizer.stop();
            } catch (_) {}
            state.wakeRecognizer = null;
        }
    }

    function handleMicDenied() {
        setWakeHint("麦克风权限被拒绝, 无法唤醒", "");
        setWakePanelState("");
        stopWakeListening();
        wakeToggle.checked = false;
        state.wakeEnabled = false;
        wakeWordInput.disabled = false;
    }

    async function startWakeListening() {
        if (state.wakeListening || state.wakeTriggered) return;
        // 本地 ASR 唤醒 (主通道, 不依赖浏览器语音云服务)
        try {
            await wakeAsr.start();
        } catch (e) {
            handleMicDenied();
            return;
        }
        if (!state.wakeEnabled) return; // 等待授权期间可能已被关闭
        state.wakeListening = true;
        setWakePanelState("listening");
        setWakeHint(`监听中 · 请说"${state.wakeWord}"唤醒`, "listening");
        startWakeRecognizer();
    }

    function stopWakeListening() {
        state.wakeListening = false;
        state.wakeEnabled = false;
        stopWakeRecognizer();
        wakeAsr.stop();
        setWakePanelState("");
    }

    function triggerWake() {
        if (state.wakeTriggered) return;
        state.wakeTriggered = true;

        // 暂停两路监听 (避免唤醒词重复触发)
        stopWakeRecognizer();
        wakeAsr.pause();
        state.wakeListening = false;

        setWakeHint("✓ 已唤醒", "triggered");
        setWakePanelState("activated");
        toast("唤醒成功", "success");

        // 提示音 (Web Audio 短鸣)
        playBeep(880, 0.15);

        // 头像呼吸效果
        const aiAvatars = chatMessages.querySelectorAll(".msg-ai .msg-avatar");
        if (aiAvatars.length > 0) {
            const last = aiAvatars[aiAvatars.length - 1];
            last.classList.add("wake-on");
            setTimeout(() => last.classList.remove("wake-on"), 2400);
        }

        // 先播报欢迎词 (可配置), 播完再进入指令录音
        playWakeGreetingThenCapture();
    }

    // 唤醒后先播欢迎词 (AI 气泡 + 正常对话同款播报通道), 播完再进入 5 秒指令录音
    async function playWakeGreetingThenCapture() {
        const text = (state.wakeGreeting || "").trim();
        let settled = false;
        const proceed = () => {
            if (settled) return;
            settled = true;
            // 播报期间唤醒被关闭则不再录音
            if (!state.wakeTriggered) return;
            setWakeHint("✓ 已唤醒 · 请说出指令 (5秒内)", "triggered");
            startWakeCommandCapture(5000);
        };
        // 未配置欢迎词 → 直接进入指令录音
        if (!text) {
            proceed();
            return;
        }
        // 加入对话流 (静音时也显示文字, 与正常回复一致)
        addMessage("ai", `<p>${escapeHtml(text)}</p>`);
        // 用户静音 / TTS 不可用 → 只出文字, 直接进入指令录音
        if (state.ttsMuted || ttsToggle.disabled) {
            proceed();
            return;
        }
        setWakeHint("✓ 已唤醒 · 播报欢迎词 ...", "triggered");
        let played = false;
        try {
            const resp = await fetch("/api/voice/tts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: text }),
            });
            const data = await resp.json();
            if (data.status === "ok" && data.audio_url) {
                // 与正常对话回复同一播报通道 (静音/停止/去重/停止按钮统一处理)
                playTTSReply(data);
                played = true;
            }
        } catch (_) {}
        if (!played) {
            proceed();
            return;
        }
        // 等播报结束 (播完/被手动停止/播放失败), 最长 15 秒;
        // 前 500ms 不判定, 避开 audio.play() 尚未就绪的窗口
        const t0 = Date.now();
        setTimeout(() => {
            if (settled) return;
            const poll = setInterval(() => {
                if (settled) { clearInterval(poll); return; }
                if (!state.currentAudio || state.currentAudio.paused ||
                    Date.now() - t0 > 15000) {
                    clearInterval(poll);
                    proceed();
                }
            }, 150);
        }, 500);
    }

    // 预合成欢迎词, 唤醒触发时直接命中 TTS 缓存, 减少等待
    function warmGreetingCache() {
        const text = (state.wakeGreeting || "").trim();
        if (!text || state.ttsMuted) return;
        fetch("/api/voice/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: text }),
        }).catch(() => {});
    }

    async function startWakeCommandCapture(timeoutMs) {
        try {
            state.wakeCmdRecorder = new WavRecorder();
            await state.wakeCmdRecorder.start();

            // 显示接管状态 (复用 recording-bar, 标注 "唤醒指令")
            recordingBar.hidden = false;
            const recLabel = recordingBar.querySelector("span:nth-child(2)");
            if (recLabel) recLabel.textContent = "唤醒指令录音中 ...";
            recTimer.textContent = "00:00";

            const t0 = Date.now();
            if (state.wakeCmdTimer) clearInterval(state.wakeCmdTimer);
            state.wakeCmdTimer = setInterval(() => {
                const s = Math.floor((Date.now() - t0) / 1000);
                recTimer.textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" +
                                       String(s % 60).padStart(2, "0");
                // 检测静音提前结束 (简化: 满足 timeoutMs 或用户取消)
            }, 500);

            // 超时自动结束并发送
            setTimeout(() => endWakeCommandCapture(false), timeoutMs);

        } catch (e) {
            setWakeHint("接管录音失败: " + e.message, "");
            resetWakeState();
        }
    }

    async function endWakeCommandCapture(cancel) {
        if (!state.wakeCmdRecorder) {
            resetWakeState();
            return;
        }
        if (state.wakeCmdTimer) {
            clearInterval(state.wakeCmdTimer);
            state.wakeCmdTimer = null;
        }
        const blob = state.wakeCmdRecorder.stop();
        state.wakeCmdRecorder = null;

        // 还原 recording-bar 标签
        recordingBar.hidden = true;
        const recLabel = recordingBar.querySelector("span:nth-child(2)");
        if (recLabel) recLabel.textContent = "正在录音 ...";

        if (cancel || !blob) {
            resetWakeState();
            return;
        }
        const duration = blob.size / 32000;
        if (duration < 0.3) {
            toast("指令太短, 请重新唤醒", "error");
            resetWakeState();
            return;
        }

        addMessage("user", `🎤 唤醒指令 (${duration.toFixed(1)}s)`);
        const loadingBubble = addMessage("ai", "正在识别并思考 ...", { loading: true });
        state.busy = true;
        sendBtn.disabled = true;

        try {
            const fd = new FormData();
            fd.append("audio", blob, "wake_cmd.wav");
            const outcome = await streamVoiceReply("/api/voice/chat", { method: "POST", body: fd }, loadingBubble);
            // 播报+打字完成后再恢复唤醒监听, 避免播报声自唤醒
            await outcome.sync.wait();
            finishAiMessage(outcome.result, outcome.result.asr_text || "", outcome.sync, loadingBubble);
        } catch (e) {
            loadingBubble.parentElement.remove();
            addMessage("ai", `请求失败: ${e.message}`, { error: true });
        } finally {
            state.busy = false;
            sendBtn.disabled = false;
            resetWakeState();
        }
    }

    function resetWakeState() {
        state.wakeTriggered = false;
        // 恢复监听
        if (state.wakeEnabled) {
            state.wakeListening = true;
            wakeAsr.resume();
            if (!state.wakeRecognizer) startWakeRecognizer();
            setWakePanelState("listening");
            setWakeHint(`监听中 · 请说"${state.wakeWord}"唤醒`, "listening");
        } else {
            setWakePanelState("");
            setWakeHint("关闭中 · 开启后持续监听唤醒词", "");
        }
    }

    function playBeep(freq, durationSec) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = freq;
            osc.type = "sine";
            gain.gain.setValueAtTime(0.001, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);
            osc.start();
            osc.stop(ctx.currentTime + durationSec);
            osc.onended = () => ctx.close();
        } catch (_) {}
    }

    function enableWake() {
        const word = (wakeWordInput.value || "").trim();
        if (word.length < 2) {
            toast("唤醒词至少 2 个字", "error");
            wakeToggle.checked = false;
            return;
        }
        state.wakeWord = word;
        state.wakeEnabled = true;
        wakeWordInput.disabled = true;
        setWakeHint(`准备监听 · 唤醒词"${word}"`, "active");
        toast(`已开启语音唤醒, 请说"${word}"`, "success");
        startWakeListening();
        warmGreetingCache();
    }

    function disableWake() {
        // 取消正在进行的唤醒指令录音
        if (state.wakeTriggered && state.wakeCmdRecorder) {
            endWakeCommandCapture(true);
        }
        // 欢迎词播报期间关闭 → 停掉播报
        if (state.wakeTriggered) stopTTSPlayback();
        stopWakeListening();
        state.wakeEnabled = false;
        state.wakeTriggered = false;
        wakeWordInput.disabled = false;
        setWakeHint("关闭中 · 开启后持续监听唤醒词", "");
        setWakePanelState("");
        toast("已关闭语音唤醒");
    }

    // ---------- 事件绑定 ----------
    function bind() {
        // 发送
        sendBtn.addEventListener("click", () => sendText(textInput.value));
        textInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendText(textInput.value);
            }
        });

        // 录音: 按住说话 (mousedown/touchstart → 开始, mouseup/touchend → 结束)
        const startRec = (e) => { e.preventDefault(); startRecording(); };
        const stopRec = (e) => { e.preventDefault(); stopRecording(false); };
        micBtn.addEventListener("mousedown", startRec);
        micBtn.addEventListener("mouseup", stopRec);
        micBtn.addEventListener("mouseleave", (e) => { if (state.recording) stopRecording(true); });
        micBtn.addEventListener("touchstart", startRec, { passive: false });
        micBtn.addEventListener("touchend", stopRec, { passive: false });
        recCancel.addEventListener("click", () => stopRecording(true));

        // 快捷操作
        document.querySelectorAll("[data-action]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const act = btn.getAttribute("data-action");
                if (act === "layout-default") {
                    executeTool("set_table_layout", { layoutType: "default" });
                } else if (act === "layout-random") {
                    executeTool("set_table_layout", { layoutType: "random" });
                } else if (act === "clear-chat") {
                    chatMessages.innerHTML = "";
                    addMessage("ai", "<p>对话已清空。有什么可以帮您?</p>");
                } else if (act === "view-table") {
                    window.location.href = "/table";
                } else if (act === "tts-test") {
                    // 试听: 调后端合成本地固定文本, 自动播
                    testTTS();
                } else if (act === "tts-stop") {
                    stopTTSPlayback();
                }
            });
        });

        // TTS 静音开关
        ttsToggle.addEventListener("change", toggleTTSMute);

        // 语音唤醒开关
        wakeToggle.addEventListener("change", () => {
            if (wakeToggle.checked) {
                enableWake();
            } else {
                disableWake();
            }
        });

        // 唤醒词修改 (开启状态下变更需先关闭再开启)
        wakeWordInput.addEventListener("change", () => {
            const newWord = (wakeWordInput.value || "").trim();
            if (newWord.length < 2) {
                toast("唤醒词至少 2 个字", "error");
                wakeWordInput.value = state.wakeWord;
                return;
            }
            if (state.wakeEnabled && newWord !== state.wakeWord) {
                toast("唤醒词已更新, 重新启动监听", "success");
                disableWake();
                setTimeout(() => {
                    wakeToggle.checked = true;
                    enableWake();
                }, 600);
            } else {
                state.wakeWord = newWord;
            }
        });

        // 唤醒欢迎词修改 (即时生效, 下次唤醒使用; localStorage 持久化)
        wakeGreetingInput.addEventListener("change", () => {
            state.wakeGreeting = wakeGreetingInput.value;
            try {
                localStorage.setItem("voice_wake_greeting", wakeGreetingInput.value);
            } catch (_) {}
            warmGreetingCache();
        });

        // 页面隐藏时暂停唤醒, 节省资源 (本地 ASR 轮询在 _poll 内自行跳过隐藏状态)
        document.addEventListener("visibilitychange", () => {
            if (!state.wakeEnabled || state.wakeTriggered) return;
            if (document.hidden) {
                stopWakeRecognizer();
                setWakeHint("页面隐藏 · 唤醒已暂停", "");
            } else if (!state.wakeListening) {
                startWakeListening();
            } else {
                if (!state.wakeRecognizer) startWakeRecognizer();
                setWakePanelState("listening");
                setWakeHint(`监听中 · 请说"${state.wakeWord}"唤醒`, "listening");
            }
        });
    }

    // ---------- 启动 ----------
    function init() {
        bind();
        loadTTSPreference();
        loadWakeGreeting();
        loadStatus();
        setInterval(loadStatus, 30000); // 30s 刷新一次状态
        // 检测浏览器对原生语音识别的支持 (缺失时自动改用本地 ASR 唤醒)
        if (!isWakeSupported()) {
            wakeSupported.hidden = false;
            wakeSupported.textContent =
                "⚠ 浏览器不支持原生语音识别, 唤醒将使用本地 ASR (延迟约 2-3 秒)";
        }
        setWakeHint("关闭中 · 开启后持续监听唤醒词", "");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
