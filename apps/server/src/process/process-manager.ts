import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { platform } from "node:os";
import { resolve } from "node:path";
import type { Project, ProjectRuntimeState, Service, ServiceRuntimeState, ServiceStatus } from "@devdeck/shared";
import { ProjectService } from "../services/project-service.js";

type StatusListener = (state: ServiceRuntimeState & { projectId: string }) => void;

interface ManagedProcess {
  child: ChildProcess;
  projectId: string;
  serviceId: string;
  state: ServiceRuntimeState;
}

export class ServiceNotFoundError extends Error {
  constructor(serviceId: string) {
    super(`Service ${serviceId} was not found.`);
    this.name = "ServiceNotFoundError";
  }
}

export class ProcessOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessOperationError";
  }
}

export class ProcessManager {
  private readonly managedProcesses = new Map<string, ManagedProcess>();
  private readonly lastStates = new Map<string, ServiceRuntimeState>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(private readonly projectService: ProjectService) {}

  onStatusChange(listener: StatusListener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async start(projectId: string, serviceId: string) {
    const { project, service } = await this.findService(projectId, serviceId);
    const key = this.key(projectId, serviceId);
    const current = this.managedProcesses.get(key);

    if (current?.state.status === "running" || current?.state.status === "starting") {
      return current.state;
    }

    if (current?.state.status === "stopping") {
      throw new ProcessOperationError(`${service.name} is still stopping.`);
    }

    const workingDirectory = resolve(project.path, service.cwd ?? ".");
    await this.assertDirectory(workingDirectory, service);

    const child = this.spawnCommand(service.command, workingDirectory);
    const state: ServiceRuntimeState = {
      serviceId,
      status: "starting",
      pid: child.pid
    };
    const managed: ManagedProcess = { child, projectId, serviceId, state };

    this.managedProcesses.set(key, managed);
    this.setState(projectId, state);

    child.once("spawn", () => {
      if (this.managedProcesses.get(key)?.child !== child) {
        return;
      }

      state.status = "running";
      this.setState(projectId, state);
    });

    child.once("error", (error) => {
      if (this.managedProcesses.get(key)?.child !== child) {
        return;
      }

      state.status = "error";
      state.error = error.message;
      this.setState(projectId, state);
    });

    child.once("close", (code, signal) => {
      if (this.managedProcesses.get(key)?.child !== child) {
        return;
      }

      const wasStopping = state.status === "stopping";
      state.status = wasStopping || code === 0 ? "stopped" : "error";
      state.error = state.status === "error"
        ? `Process exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}.`
        : undefined;
      state.pid = undefined;
      this.managedProcesses.delete(key);
      this.setState(projectId, state);
    });

    return state;
  }

  async stop(projectId: string, serviceId: string) {
    await this.findService(projectId, serviceId);
    const key = this.key(projectId, serviceId);
    const managed = this.managedProcesses.get(key);

    if (!managed) {
      return this.getServiceState(projectId, serviceId);
    }

    if (managed.state.status === "stopping") {
      return managed.state;
    }

    managed.state.status = "stopping";
    managed.state.error = undefined;
    this.setState(projectId, managed.state);

    await this.terminateProcessTree(managed.child);
    await this.waitForProcessToStop(key);
    return this.getServiceState(projectId, serviceId);
  }

  async restart(projectId: string, serviceId: string) {
    await this.stop(projectId, serviceId);
    return this.start(projectId, serviceId);
  }

  async startAll(projectId: string) {
    const project = await this.projectService.get(projectId);
    return Promise.all(project.services.map((service) => this.start(projectId, service.id)));
  }

  async stopAll(projectId?: string) {
    const managed = [...this.managedProcesses.values()]
      .filter((process) => projectId === undefined || process.projectId === projectId);

    await Promise.all(managed.map((process) => this.stop(process.projectId, process.serviceId)));
  }

  async getProjectState(projectId: string): Promise<ProjectRuntimeState> {
    const project = await this.projectService.get(projectId);
    return this.buildProjectState(project);
  }

  async getAllStates() {
    const projects = await this.projectService.list();
    return projects.map((project) => this.buildProjectState(project));
  }

  private async findService(projectId: string, serviceId: string) {
    const project = await this.projectService.get(projectId);
    const service = project.services.find((candidate) => candidate.id === serviceId);

    if (!service) {
      throw new ServiceNotFoundError(serviceId);
    }

    return { project, service };
  }

  private buildProjectState(project: Project): ProjectRuntimeState {
    const services = Object.fromEntries(project.services.map((service) => [service.id, this.getServiceState(project.id, service.id)]));
    const states = Object.values(services).map((service) => service.status);
    let status: ServiceStatus = "stopped";

    if (states.some((serviceStatus) => serviceStatus === "error")) {
      status = "error";
    } else if (states.some((serviceStatus) => serviceStatus === "stopping")) {
      status = "stopping";
    } else if (states.some((serviceStatus) => serviceStatus === "starting")) {
      status = "starting";
    } else if (states.some((serviceStatus) => serviceStatus === "running")) {
      status = "running";
    }

    return { projectId: project.id, status, services };
  }

  private getServiceState(projectId: string, serviceId: string) {
    const managed = this.managedProcesses.get(this.key(projectId, serviceId));
    return managed?.state ?? this.lastStates.get(this.key(projectId, serviceId)) ?? { serviceId, status: "stopped" as const };
  }

  private setState(projectId: string, state: ServiceRuntimeState) {
    const snapshot = { ...state };
    this.lastStates.set(this.key(projectId, state.serviceId), snapshot);
    for (const listener of this.statusListeners) {
      listener({ projectId, ...snapshot });
    }
  }

  private spawnCommand(command: string, workingDirectory: string) {
    if (platform() === "win32") {
      return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
        cwd: workingDirectory,
        stdio: "ignore",
        windowsHide: true
      });
    }

    return spawn("/bin/sh", ["-c", command], {
      cwd: workingDirectory,
      stdio: "ignore"
    });
  }

  private async assertDirectory(directory: string, service: Service) {
    try {
      const details = await stat(directory);
      if (!details.isDirectory()) {
        throw new Error("path is not a directory");
      }
    } catch {
      throw new ProcessOperationError(`Cannot start ${service.name}: working directory ${directory} is unavailable.`);
    }
  }

  private async terminateProcessTree(child: ChildProcess) {
    if (!child.pid) {
      return;
    }

    if (platform() !== "win32") {
      child.kill("SIGTERM");
      return;
    }

    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("error", () => {
        child.kill();
        resolve();
      });
      killer.once("close", () => resolve());
    });
  }

  private async waitForProcessToStop(key: string) {
    const deadline = Date.now() + 2000;

    while (this.managedProcesses.has(key) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const managed = this.managedProcesses.get(key);
    if (managed) {
      managed.state.status = "stopped";
      managed.state.pid = undefined;
      this.managedProcesses.delete(key);
      this.setState(managed.projectId, managed.state);
    }
  }

  private key(projectId: string, serviceId: string) {
    return `${projectId}:${serviceId}`;
  }
}
