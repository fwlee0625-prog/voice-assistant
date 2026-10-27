/** Non-secret runtime preferences, serialized atomic JSON writes. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HttpError } from '../http/errors.ts';
import { TTS_VOICES } from '../tts/provider.ts';
import { DEFAULT_FILLERS, FILLER_MAX_COUNT, FILLER_MAX_LENGTH } from '../tts/fillers.ts';

export interface TtsPreferences { enabled: boolean; provider: 'xiaomi'; voice: string; filler: boolean; fillers: string[] }
export interface Preferences { baseUrl: string; model: string; systemPrompt: string; tts?: TtsPreferences }
export const defaults: Preferences = {
  baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
  tts: { enabled: true, provider: 'xiaomi', voice: '冰糖', filler: true, fillers: [...DEFAULT_FILLERS] },
  systemPrompt: '你是一位友好的中文语音助手。请简洁自然地回答用户的问题。',
};
function validFillers(input: unknown): input is string[] {
  if (!Array.isArray(input) || input.length > FILLER_MAX_COUNT) return false;
  return input.every(item => typeof item === 'string' && item.trim().length > 0 && item.trim().length <= FILLER_MAX_LENGTH);
}
export function validatePreferences(input: unknown): Preferences {
  if (!input || typeof input !== 'object') throw new HttpError(400, '配置格式错误');
  const value = input as Record<string, unknown>;
  if (typeof value.baseUrl !== 'string' || typeof value.model !== 'string' ||
      typeof value.systemPrompt !== 'string' || !value.model.trim() || value.model.length > 200 ||
      value.systemPrompt.length > 16000) throw new HttpError(400, '请填写接口地址、模型和有效提示词');
  let url: URL;
  try { url = new URL(value.baseUrl); } catch { throw new HttpError(400, '接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new HttpError(400, '接口地址必须是 HTTP(S) 地址，不能包含凭证、查询或片段');
  const tts = value.tts as TtsPreferences | undefined;
  if (tts !== undefined && (!tts || typeof tts.enabled !== 'boolean' || tts.provider !== 'xiaomi' ||
      !TTS_VOICES.includes(tts.voice) || (tts.filler !== undefined && typeof tts.filler !== 'boolean') ||
      (tts.fillers !== undefined && !validFillers(tts.fillers))))
    throw new HttpError(400, 'TTS 配置无效');
  return { baseUrl: url.href.replace(/\/+$/, ''), model: value.model.trim(), systemPrompt: value.systemPrompt,
    tts: tts ? { enabled: tts.enabled, provider: tts.provider, voice: tts.voice, filler: tts.filler !== false,
      fillers: tts.fillers === undefined ? [...DEFAULT_FILLERS] : tts.fillers.map(text => text.trim()) }
      : { enabled: true, provider: 'xiaomi', voice: '冰糖', filler: true, fillers: [...DEFAULT_FILLERS] } };

}
export function createSettingsStore(path: string) {
  let pending = Promise.resolve();
  async function read(): Promise<Preferences> {
    await pending;
    try { return validatePreferences(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { ...defaults, tts: { ...defaults.tts!, fillers: [...defaults.tts!.fillers] } };
      throw new HttpError(500, '本地配置文件无法读取，请检查 JSON 文件');
    }
  }
  function write(input: unknown) {
    const value = validatePreferences(input);
    const operation = pending.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      await rename(path + '.tmp', path);
    });
    pending = operation.catch(() => {});
    return operation.then(() => value);
  }
  return { read, write };
}
export type SettingsStore = ReturnType<typeof createSettingsStore>;
