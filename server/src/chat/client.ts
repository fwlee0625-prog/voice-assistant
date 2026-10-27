import { controlPrompt, controlTools, parseControl, type ControlAction } from './control.ts';
import { voiceReplyPrompt, createToneDecoder } from './tone.ts';
import { readSse } from '../http/sse.ts';
/** OpenAI-compatible Chat Completions adapter. Never expose upstream error bodies. */
import type { Preferences } from '../settings/store.ts';
import { HttpError } from '../http/errors.ts';
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export function validateMessages(body: unknown): ChatMessage[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 100 || messages.some(m =>
    !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' ||
    !m.content.trim() || m.content.length > 16000) || messages.at(-1)?.role !== 'user')
    throw new HttpError(400, 'messages 需包含 1–100 条有效消息，并以 user 消息结束');
  return messages.map(m => ({ role: m.role, content: m.content }));
}
export async function completeChat(settings: Preferences, key: string, messages: ChatMessage[], signal: AbortSignal) {
  if (!key) throw new HttpError(503, '请先在设置中配置 OpenAI API Key');
  try {
    const response = await fetch(settings.baseUrl + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: settings.model, stream: false, messages: [
        { role: 'system', content: [settings.systemPrompt, voiceReplyPrompt].filter(Boolean).join('\n\n') }, ...messages,
      ] }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(502, response.status === 401 || response.status === 403
        ? '模型鉴权失败，请检查 API Key 和访问权限' : `模型服务请求失败（${response.status}），请检查配置或稍后重试`);
    }
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(502, '模型未返回文本回答');
    const visible = createToneDecoder().push(text, true).filter(part => part.type === 'text').map(part => part.value).join('');
    if (!visible.trim()) throw new HttpError(502, '模型未返回文本回答');
    return { text: visible, model: settings.model };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted) throw new HttpError(499, '对话请求已取消');
    throw new HttpError(502, '模型连接失败或超时，请检查接口地址和网络');
  }
}

/** Provider tool fragments stay here; only validated controls reach the caller. */
export async function* streamChat(settings: Preferences, key: string, messages: ChatMessage[], signal: AbortSignal, onControl?: (action: ControlAction) => Promise<void>): AsyncGenerator<string> {
  if (!key) throw new HttpError(503, '请先在设置中配置模型 API Key');
  try {
    const response = await fetch(settings.baseUrl + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: settings.model, stream: true, ...(onControl ? { tools: controlTools, tool_choice: 'auto' } : {}), messages: [
        { role: 'system', content: [settings.systemPrompt, voiceReplyPrompt, ...(onControl ? [controlPrompt] : [])].filter(Boolean).join('\n\n') }, ...messages,
      ] }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(502, response.status === 401 || response.status === 403
        ? '模型鉴权失败，请检查 API Key 和访问权限' : `模型服务请求失败（${response.status}）`);
    }
    let text = ''; let finished = false; let toolFinished = false;
    const calls = new Map<number, { name: string; args: string }>();
    for await (const data of readSse(response)) {
      if (data === '[DONE]') { finished = true; break; }
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error('Provider stream error');
      const choice = chunk.choices?.[0];
      for (const part of choice?.delta?.tool_calls || []) {
        if (!onControl || !Number.isInteger(part.index) || part.index < 0 || part.index > 0) throw new HttpError(502, '会话控制调用无效');
        const call = calls.get(part.index) || { name: '', args: '' };
        call.name += part.function?.name || ''; call.args += part.function?.arguments || '';
        if (call.name.length > 64 || call.args.length > 1024) throw new HttpError(502, '会话控制调用过长');
        calls.set(part.index, call);
      }
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
        if (text.length > 16000) throw new HttpError(502, '模型回答过长');
        yield delta;
      }
      if (choice?.finish_reason) {
        if (choice.finish_reason !== 'stop' && !(onControl && choice.finish_reason === 'tool_calls')) throw new HttpError(502, '模型回答未完整生成，请重试');
        finished = true; toolFinished = choice.finish_reason === 'tool_calls';
      }
    }
    if (!finished) throw new HttpError(502, '模型回答连接中断，请重试');
    if (calls.size) {
      if (!toolFinished || calls.size !== 1 || !onControl) throw new HttpError(502, '会话控制调用未完成');
      const call = calls.values().next().value!;
      let action: ControlAction;
      try { action = parseControl(call.name, call.args); } catch { throw new HttpError(502, '会话控制调用无效'); }
      signal.throwIfAborted(); await onControl(action);
      return;
    }
    if (toolFinished || !text.trim()) throw new HttpError(502, '模型未返回文本回答');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted) throw new HttpError(499, '对话请求已取消');
    throw new HttpError(502, '模型连接失败或超时，请检查接口地址和网络');
  }
}
