import express from "express";
import type { HealthResponse } from "@devdeck/shared";

export function createApp() {
  const app = express();

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
