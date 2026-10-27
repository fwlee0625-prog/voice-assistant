/** Multipart validation and WAV response only. The worker owns decoding/inference. */
import { Router } from "express";
import multer from "multer";
import type { EnhanceAudio } from "./worker.ts";
import { HttpError } from "../http/errors.ts";

export function enhancementRoutes(enhance: EnhanceAudio): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 32 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  router.post("/api/voice/enhance", upload.single("audio"), async (req, res) => {
    if (!req.file?.buffer.length) throw new HttpError(400, "缺少 audio 文件");
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", cancel);
    try {
      const wav = await enhance(req.file.buffer, controller.signal);
      if (controller.signal.aborted) return;
      res
        .set({
          "Content-Type": "audio/wav",
          "Content-Disposition": 'inline; filename="enhanced.wav"',
          "X-Sample-Rate": "48000",
          "Cache-Control": "no-store",
        })
        .send(wav);
    } finally {
      res.off("close", cancel);
    }
  });
  return router;
}
