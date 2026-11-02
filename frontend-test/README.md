# frontend-test

## 语音问答展示

回答按真实 Web Audio 播放进度逐句、逐字显示。`chat/conversation.ts` 分别保留完整上下文 `assistant` 与页面可见的 `visibleAssistant`；`audio/speechTimeline.ts` 根据句子编号和 PCM 时间计算近似进度，`audio/speechPlayer.ts` 驱动更新。录音页单行提示跟随滚动到最新文字，对话弹框展示同一份可见文字。打断后停止出字；语音关闭或失败时正常显示文字。

PCM 播放仅在首次播放或缓冲耗尽后预留 120ms，后续分片按采样时长连续拼接，避免网络抖动时每片重新预留提前量造成断续声。分片到达不重置音量，保留打断判断期间的平滑降音量过渡。该缓冲不能消除上游合成音中的杂音或超过缓冲时长的网络停顿。

## 杂音诊断

设置 → 语音诊断，开启「记录语音诊断日志」；需要对比音源时再开启「保留最近一条回答的合成音频」。开关立即生效，无需保存配置。重新对话，出现杂音后标记并导出 JSON 和 WAV，先导出再进行下一轮，避免新回答替换音频。诊断只在当前页面内存中保留，刷新后清空并关闭；关闭音频捕获会删除已捕获音频，关闭日志保留已记录的元数据供导出。

`audio/speechDiagnostics.ts` 管理有界记录、音频捕获和导出；`chat/stream.ts` 记录流读取/事件/异常；`speechPlayer.ts` 记录采样率、接收间隔、调度时间、缓冲余量、缓冲耗尽、峰值/RMS、削波采样数、片内最大跳变、片间跳变、音量操作、停止和播放结束。`reply.response` 将 player ID 与后端 request ID 关联，`stream.event` 包含服务端序号和相对时间，可对照分片输出间隔和浏览器接收间隔。跳变和削波只是定位线索，不能单独证明存在可听杂音；时间轴基于单调时钟，不用浏览器与后端的绝对时间相减。

最多保留最近 4000 条事件，导出标明被覆盖的数量；合成音频最多 8MB，达到上限或采样率变化时截断并标明。日志不包含对话正文、音频 base64、密钥或麦克风数据。可选 WAV 是最近播放器收到的 PCM，包含衔接词及可能尚未播出的部分；不模拟网络停顿、音量变化、重采样或扬声器输出。如果 WAV 同样有杂音，重点检查音源/合成；如果 WAV 干净，结合缓冲耗尽、采样率和音量事件检查实时播放链路。中途开启捕获只包含之后收到的完整采样。

`pnpm test` 运行模拟测试。通过 Spark 启动前端后，可在 Chrome 打开 `http://localhost:5178/test/browser-speech-sync.html`，点击「运行验证」检查真实 Web Audio、生产消息组件、句间切换、播完补齐和打断。验证使用模拟 SSE 与静音 PCM，不调用云端、不采集麦克风。句内进度为估算，没有供应商逐字时间戳。

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) to make the TypeScript language service aware of `.vue` types.

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

唤醒词设置：输入中文后点击“识别”，通过现有大模型生成标准发音，再按模型词表补齐常见变调和声调容错，无需手填拼音。支持查看生成的读音；改动中文会清空旧发音，识别中不可保存，失败可重试。点击“保存配置”后下次开启唤醒生效。最多 10 个中文词、每词最多 96 种读音；声调容错不穷举所有组合，读音更宽松也可能增加误唤醒。已有手填配置仍可读取。

```sh
pnpm install
```

### Compile and Hot-Reload for Development

```sh
pnpm dev
```

### Type-Check, Compile and Minify for Production

```sh
pnpm build
```

### Lint with [ESLint](https://eslint.org/)

```sh
pnpm lint
```

### 每轮耗时分析

设置 → 语音诊断 → 开启记录后重新对话。表格每秒更新最近 10 次回答，显示话轮等待、模型首字、首句准备（包含隐藏语气标记生成）、TTS 首包、说完到正文播放，以及最大已测阶段。状态保留打断/失败；缺失节点显示“未采集”。JSON 导出为 version 2，`analysis` 包含每轮指标、逐句合成耗时和播放断流次数，`events` 保留节点原始时间；requestId 关联服务端流，trace/player 关联每轮与播放。

浏览器节点使用 performance 单调时钟；后端节点使用从请求进入路由起的单调毫秒时间。两侧仅分别求差，不直接相减，网络传输等包含在浏览器端总耗时内。说完时刻依据 VAD 已观察的静音回推，播放时刻依据 AudioContext 调度估算，不包含扬声器/蓝牙设备延迟。话轮预算与 ASR final 有重叠，不将重叠指标相加。首包指首个 PCM 块，音频自身可能含起始静音。最大阶段仅比较已测的四个关键阶段，不能据此推断全部网络耗时。记录默认关闭，仅存在当前页面内存；中途开启或旧记录被覆盖时可能缺失节点。
