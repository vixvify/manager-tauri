import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { DevDeckEvent } from "@devdeck/shared";
import { LogManager } from "../services/log-manager.js";
import { ProcessManager } from "../process/process-manager.js";

export class WebSocketManager {
  private readonly server: WebSocketServer;
  private readonly unsubscribeStatus: () => boolean;
  private readonly unsubscribeLogs: () => boolean;

  constructor(httpServer: Server, processManager: ProcessManager, logManager: LogManager) {
    this.server = new WebSocketServer({ server: httpServer, path: "/ws" });
    this.unsubscribeStatus = processManager.onStatusChange((state) => {
      this.broadcast({
        type: "service:status",
        projectId: state.projectId,
        serviceId: state.serviceId,
        status: state.status,
        pid: state.pid,
        error: state.error
      });
    });
    this.unsubscribeLogs = logManager.onLog((event) => this.broadcast(event));
  }

  close() {
    this.unsubscribeStatus();
    this.unsubscribeLogs();
    for (const client of this.server.clients) {
      client.close();
    }
    this.server.close();
  }

  private broadcast(event: DevDeckEvent) {
    const message = JSON.stringify(event);
    for (const client of this.server.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }
}
