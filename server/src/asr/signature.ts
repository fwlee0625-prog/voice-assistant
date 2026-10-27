/** Tencent TLS v2 signing, scoped to one voice_id. Never sent to the browser. */
import { createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";

export function createUserSig(
  appId: string,
  secretKey: string,
  voiceId: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const fields = {
    "TLS.identifier": voiceId,
    "TLS.sdkappid": Number(appId),
    "TLS.time": now,
    "TLS.expire": 86400,
  };
  const input = Object.entries(fields)
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
  const sig = createHmac("sha256", secretKey).update(input).digest("base64");
  return deflateSync(Buffer.from(JSON.stringify({ "TLS.ver": "2.0", ...fields, "TLS.sig": sig })))
    .toString("base64")
    .replaceAll("+", "*")
    .replaceAll("/", "-")
    .replaceAll("=", "_");
}
