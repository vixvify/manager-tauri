export interface Service {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  port?: number;
}

export interface ServiceInput {
  id?: string;
  name: string;
  command: string;
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

export interface ServiceRuntimeState {
  serviceId: string;
  status: ServiceStatus;
  pid?: number;
  error?: string;
}

export interface ProjectRuntimeState {
  projectId: string;
  status: ServiceStatus;
  services: Record<string, ServiceRuntimeState>;
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

export interface HealthResponse {
  status: "ok";
  service: "devdeck-server";
  timestamp: string;
}
