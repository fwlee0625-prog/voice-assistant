/** HTTP upgrade routing and origin checks; delegates each accepted socket to a session. */
import type { TurnDetector } from '../turns/worker.ts';
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { ConnectAsr } from "./tencent-client.ts";
import { bridgeSession } from "./session.ts";

export function attachAsr(server: Server, origins: Set<string>, connect: ConnectAsr, detector?: TurnDetector): () => void {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    const path = request.url?.split("?")[0];
    if (
      path !== "/api/voice/asr/realtime" ||
      !request.headers.origin ||
      !origins.has(request.headers.origin)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const params = new URL(request.url!, 'http://localhost').searchParams;
    const activated = ['manual', 'wake'].includes(params.get('entry') || '');
    sockets.handleUpgrade(request, socket, head, (ws) => bridgeSession(ws, connect, params.get('turns') === '1' ? detector : undefined, activated));
  });
  return () => {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
  };
}
