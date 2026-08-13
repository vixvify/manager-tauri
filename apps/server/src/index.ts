import { createApp } from "./app.js";

const host = "127.0.0.1";
const port = Number(process.env.DEVDECK_SERVER_PORT ?? 4317);
const app = createApp();

const server = app.listen(port, host, () => {
  console.log(`DevDeck server listening on http://${host}:${port}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down DevDeck server.`);
  server.close(() => process.exit(0));
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
