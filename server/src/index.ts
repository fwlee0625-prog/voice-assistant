/** Process entry: configuration, listen and graceful shutdown. No feature logic. */
import { loadConfig } from "./config.ts";
import { createVoiceServer } from "./server.ts";

const config = loadConfig();
const { server, closeAsr } = createVoiceServer(config);
server.listen(config.port, config.host, () =>
  console.info(`Voice Express listening on http://${config.host}:${config.port}`),
);
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`Voice Express failed to listen (${error.code || "unknown"})`);
  process.exitCode = 1;
});
function shutdown(): void {
  closeAsr();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
