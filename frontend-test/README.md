# frontend-test

## 语音问答展示

回答按真实 Web Audio 播放进度逐句、逐字显示。`chat/conversation.ts` 分别保留完整上下文 `assistant` 与页面可见的 `visibleAssistant`；`audio/speechTimeline.ts` 根据句子编号和 PCM 时间计算近似进度，`audio/speechPlayer.ts` 驱动更新。录音页单行提示跟随滚动到最新文字，对话弹框展示同一份可见文字。打断后停止出字；语音关闭或失败时正常显示文字。

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
