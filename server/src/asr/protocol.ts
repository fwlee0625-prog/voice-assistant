/** Normalize Tencent frames into the record page's existing wire contract. */
export interface SpeakerSegment {
  speaker_id: number;
  text: string;
  stable_flag: number;
}
export type AsrEvent =
  | { type: "ready" }
  | {
      type: "result";
      index: number;
      text: string;
      final: boolean;
      speaker_segments: SpeakerSegment[];
    }
  | { type: "done" }
  | { type: "error"; error: string };

export interface TencentFrame {
  code: number;
  final?: number;
  result?: {
    index: number;
    voice_text_str?: string;
    slice_type: number;
    speaker_segments?: SpeakerSegment[];
  };
}

export function normalizeResult(frame: TencentFrame): AsrEvent | undefined {
  const result = frame.result;
  if (!result) return undefined;
  if (!Number.isInteger(result.index) || result.index < 0)
    throw new Error("Invalid ASR sentence index");
  return {
    type: "result",
    index: result.index,
    text: result.voice_text_str || "",
    final: result.slice_type === 2,
    speaker_segments: (result.speaker_segments || []).map((part) => ({
      speaker_id: Number.isInteger(part.speaker_id) ? part.speaker_id : -1,
      text: part.text || "",
      stable_flag: part.stable_flag === 1 ? 1 : 0,
    })),
  };
}

export function cloudError(code: number): string {
  const messages: Record<number, string> = {
    4001: "腾讯云 ASR 参数无效",
    4002: "腾讯云 ASR 鉴权失败，请检查 TRTC 应用 SDK 凭证",
    4003: "腾讯云 ASR 服务未开通",
    4004: "腾讯云 ASR 资源包耗尽",
    4005: "腾讯云账户欠费",
    4006: "腾讯云 ASR 并发超限",
    4007: "腾讯云音频解码失败",
    4008: "腾讯云 ASR 音频等待超时",
  };
  return `${messages[code] || "腾讯云 ASR 识别失败"}（${code}）`;
}
