import express from "express";
import type { HealthResponse } from "@devdeck/shared";

export function createApp() {
  const app = express();

  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }

    next();
  });

  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    const payload: HealthResponse = {
      status: "ok",
      service: "devdeck-server",
      timestamp: new Date().toISOString()
    };

    response.json(payload);
  });

  return app;
}
