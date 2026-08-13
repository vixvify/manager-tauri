import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Project, ProjectInput, ProjectReorderInput, Service, ServiceInput } from "@devdeck/shared";

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} was not found.`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

function defaultDataDirectory() {
  return process.env.DEVDECK_DATA_DIR ?? join(process.env.APPDATA ?? homedir(), "DevDeck");
}

function normalizeOptionalString(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeService(input: ServiceInput, existingId?: string): Service {
  if (!input || typeof input !== "object") {
    throw new ProjectValidationError("Every service must be an object.");
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  const command = typeof input.command === "string" ? input.command.trim() : "";

  if (!name) {
    throw new ProjectValidationError("Every service needs a name.");
  }

  if (!command) {
    throw new ProjectValidationError(`Service ${name} needs a command.`);
  }

  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    throw new ProjectValidationError(`Service ${name} has an invalid port.`);
  }

  return {
    id: existingId ?? input.id ?? randomUUID(),
    name,
    command,
    cwd: normalizeOptionalString(input.cwd),
    port: input.port
  };
}

function normalizeProject(input: ProjectInput, existing?: Project): Project {
  if (!input || typeof input !== "object") {
    throw new ProjectValidationError("Project data must be an object.");
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  const projectPath = typeof input.path === "string" ? input.path.trim() : "";

  if (!name) {
    throw new ProjectValidationError("A project needs a name.");
  }

  if (!projectPath) {
    throw new ProjectValidationError("A project needs a local path.");
  }

  if (input.services !== undefined && !Array.isArray(input.services)) {
    throw new ProjectValidationError("Project services must be an array.");
  }

  const incomingServices = input.services ?? [];
  const existingServices = new Map((existing?.services ?? []).map((service) => [service.id, service]));

  return {
    id: existing?.id ?? randomUUID(),
    name,
    path: projectPath,
    services: incomingServices.map((service) => normalizeService(service, service.id ? existingServices.get(service.id)?.id : undefined))
  };
}

export class ProjectService {
  private readonly filePath: string;
  private projects: Project[] | null = null;

  constructor(filePath = join(defaultDataDirectory(), "projects.json")) {
    this.filePath = filePath;
  }

  async list() {
    await this.ensureLoaded();
    return this.projects ?? [];
  }

  async get(projectId: string) {
    const projects = await this.list();
    const project = projects.find((candidate) => candidate.id === projectId);

    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    return project;
  }

  async create(input: ProjectInput) {
    const projects = await this.list();
    const project = normalizeProject(input);

    projects.push(project);
    await this.persist();
    return project;
  }

  async update(projectId: string, input: ProjectInput) {
    const projects = await this.list();
    const projectIndex = projects.findIndex((candidate) => candidate.id === projectId);

    if (projectIndex === -1) {
      throw new ProjectNotFoundError(projectId);
    }

    const project = normalizeProject(input, projects[projectIndex]);
    projects[projectIndex] = project;
    await this.persist();
    return project;
  }

  async remove(projectId: string) {
    const projects = await this.list();
    const projectIndex = projects.findIndex((candidate) => candidate.id === projectId);

    if (projectIndex === -1) {
      throw new ProjectNotFoundError(projectId);
    }

    projects.splice(projectIndex, 1);
    await this.persist();
  }

  async reorder(input: ProjectReorderInput) {
    const projects = await this.list();

    if (!Array.isArray(input.projectIds) || input.projectIds.length !== projects.length) {
      throw new ProjectValidationError("Project reorder must include every registered project exactly once.");
    }

    const registeredIds = new Set(projects.map((project) => project.id));
    const requestedIds = new Set(input.projectIds);
    if (requestedIds.size !== input.projectIds.length || input.projectIds.some((projectId) => !registeredIds.has(projectId))) {
      throw new ProjectValidationError("Project reorder contains an unknown or duplicate project.");
    }

    this.projects = input.projectIds.map((projectId) => projects.find((project) => project.id === projectId)!);
    await this.persist();
    return this.projects;
  }

  private async ensureLoaded() {
    if (this.projects) {
      return;
    }

    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as unknown;

      if (!Array.isArray(parsed)) {
        throw new Error("Project data must be an array.");
      }

      this.projects = parsed as Project[];
    } catch (error) {
      if (isFileNotFound(error)) {
        this.projects = [];
        await this.persist();
        return;
      }

      throw new Error(`Unable to read DevDeck project data: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  private async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.projects ?? [], null, 2)}\n`, "utf8");
  }
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
