export interface Service {
  id: string;
  name: string;
  command: string;
  buildCommand?: string;
  cwd?: string;
  port?: number;
}

export interface ServiceInput {
  id?: string;
  name: string;
  command: string;
  buildCommand?: string;
  cwd?: string;
  port?: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  services: Service[];
}

export interface ProjectInput {
  name: string;
  path: string;
  services?: ServiceInput[];
}

export type ServiceStatus = "stopped" | "starting" | "running" | "stopping" | "error";
export type RuntimeMode = "process" | "docker";
export type PortStatus = "unknown" | "checking" | "listening" | "available" | "occupied";

export interface ServiceRuntimeState {
  serviceId: string;
  status: ServiceStatus;
  mode?: RuntimeMode;
  pid?: number;
  port?: number;
  portStatus?: PortStatus;
  error?: string;
}

export interface ProjectRuntimeState {
  projectId: string;
  status: ServiceStatus;
  services: Record<string, ServiceRuntimeState>;
}

export interface ProjectReorderInput {
  projectIds: string[];
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitPullResult {
  branch: string;
  output: string;
}

export interface BuildResult {
  success: boolean;
  output: string;
}

export interface ProjectCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
}

export type LogStream = "stdout" | "stderr";

export interface ServiceLogEntry {
  timestamp: string;
  stream: LogStream;
  message: string;
}

export interface ServiceLogEvent extends ServiceLogEntry {
  type: "service:log";
  projectId: string;
  serviceId: string;
}

export interface ServiceStatusEvent {
  type: "service:status";
  projectId: string;
  serviceId: string;
  status: ServiceStatus;
  pid?: number;
  error?: string;
}

export type DevDeckEvent = ServiceLogEvent | ServiceStatusEvent;
