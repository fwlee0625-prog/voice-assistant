/** Whitelisted session controls; no business tools or model-supplied farewell text. */
export const controlActions = ['pause_reply', 'end_conversation', 'disable_listening'] as const;
export type ControlAction = typeof controlActions[number];
export const controlPrompt = `你可以控制当前语音会话。用户让你稍等、暂停说话时调用 pause_reply；明确结束本次交谈、让你退出或退下时调用 end_conversation；明确关闭麦克风、关闭唤醒或不要再监听时调用 disable_listening。结合最近上下文理解“先这样吧”等表达。否定命令、询问操作方法、引用他人话语、业务里的关台/结束计时都不是会话控制，不调用工具。选择工具时不要先输出普通回答，只调用一个工具。普通问题直接回答。`;
export const controlTools = controlActions.map(name => ({ type: 'function', function: {
  name, description: name === 'pause_reply' ? '暂停当前回答，保持监听等待用户继续' : name === 'end_conversation' ? '播报结束语后结束本次对话，允许本地唤醒待机' : '播报结束语后关闭对话和唤醒，释放麦克风',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
} }));
export function parseControl(name: string, args: string): ControlAction {
  if (!controlActions.includes(name as ControlAction)) throw new Error('Unknown session control');
  const value = JSON.parse(args);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error('Invalid session control arguments');
  return name as ControlAction;
}
/** Whole utterances only: avoid negation, quotations, questions and business endings. */
export function explicitEnd(text: string): 'end_conversation' | 'disable_listening' | undefined {
  const value = text.replace(/[\p{P}\s]/gu, '').replace(/^(?:好的|好|行)?(?:请你|请|你)?/, '').replace(/(?:吧|了|谢谢|谢谢你)$/u, '');
  if (/^(?:关闭麦克风|关掉麦克风|关闭语音唤醒|关闭唤醒|不要再监听|别再监听|停止监听)$/.test(value)) return 'disable_listening';
  if (/^(?:退出|退出对话|结束|结束掉|结束对话|结束会话|停止对话|不聊|不聊了|不用回答了|你可以退下|可以退下|退下|再见)$/.test(value)) return 'end_conversation';
}
