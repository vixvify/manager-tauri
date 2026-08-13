import express from "express";
import type { HealthResponse, ProjectInput } from "@devdeck/shared";
import { ProcessManager, ProcessOperationError, ServiceNotFoundError } from "./process/process-manager.js";
import { ProjectNotFoundError, ProjectService, ProjectValidationError } from "./services/project-service.js";

export function createApp(projectService = new ProjectService(), processManager = new ProcessManager(projectService)) {
  const app = express();

  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

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

  app.get("/api/projects", async (_request, response) => {
    try {
      response.json(await projectService.list());
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.post("/api/projects", async (request, response) => {
    try {
      const project = await projectService.create(request.body as ProjectInput);
      response.status(201).json(project);
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.get("/api/projects/:projectId", async (request, response) => {
    try {
      response.json(await projectService.get(request.params.projectId));
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.put("/api/projects/:projectId", async (request, response) => {
    try {
      const project = await projectService.update(request.params.projectId, request.body as ProjectInput);
      response.json(project);
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.delete("/api/projects/:projectId", async (request, response) => {
    try {
      await projectService.get(request.params.projectId);
      await processManager.stopAll(request.params.projectId);
      await projectService.remove(request.params.projectId);
      response.status(204).send();
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.get("/api/runtime", async (_request, response) => {
    try {
      response.json(await processManager.getAllStates());
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.get("/api/projects/:projectId/runtime", async (request, response) => {
    try {
      response.json(await processManager.getProjectState(request.params.projectId));
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.get("/api/projects/:projectId/services/:serviceId/logs", async (request, response) => {
    try {
      response.json(await processManager.getLogs(request.params.projectId, request.params.serviceId));
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.post("/api/projects/:projectId/start", async (request, response) => {
    try {
      await processManager.startAll(request.params.projectId);
      response.json(await processManager.getProjectState(request.params.projectId));
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.post("/api/projects/:projectId/stop", async (request, response) => {
    try {
      await processManager.stopAll(request.params.projectId);
      response.json(await processManager.getProjectState(request.params.projectId));
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.post("/api/projects/:projectId/services/:serviceId/start", async (request, response) => {
    try {
      response.json(await processManager.start(request.params.projectId, request.params.serviceId));
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.post("/api/projects/:projectId/services/:serviceId/stop", async (request, response) => {
    try {
      response.json(await processManager.stop(request.params.projectId, request.params.serviceId));
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  app.post("/api/projects/:projectId/services/:serviceId/restart", async (request, response) => {
    try {
      response.json(await processManager.restart(request.params.projectId, request.params.serviceId));
    } catch (error) {
      sendProjectError(error, response);
    }
  });

  return app;
}

function sendProjectError(error: unknown, response: express.Response) {
  if (error instanceof ProjectNotFoundError) {
    response.status(404).json({ error: error.message });
    return;
  }

  if (error instanceof ProjectValidationError) {
    response.status(400).json({ error: error.message });
    return;
  }

  if (error instanceof ServiceNotFoundError) {
    response.status(404).json({ error: error.message });
    return;
  }

  if (error instanceof ProcessOperationError) {
    response.status(409).json({ error: error.message });
    return;
  }

  console.error(error);
  response.status(500).json({ error: "Unable to complete project operation." });
}
