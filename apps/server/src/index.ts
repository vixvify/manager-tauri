import { createServer } from "node:http";
import { createApp } from "./app.js";
import { ProcessManager } from "./process/process-manager.js";
import { WebSocketManager } from "./websocket/websocket-manager.js";
import { LogManager } from "./services/log-manager.js";
import { ProjectService } from "./services/project-service.js";

const host = "127.0.0.1";
const port = Number(process.env.DEVDECK_SERVER_PORT ?? 4317);
const projectService = new ProjectService();
const logManager = new LogManager();
const processManager = new ProcessManager(projectService, logManager);
const app = createApp(projectService, processManager, logManager);
const server = createServer(app);
const websocketManager = new WebSocketManager(server, processManager, logManager);

server.listen(port, host, () => {
  console.log(`DevDeck server listening on http://${host}:${port}`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down DevDeck server.`);
  await processManager.stopAll();
  websocketManager.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
