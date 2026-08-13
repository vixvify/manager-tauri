export interface Service {
  id: string;
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

export type ServiceStatus = "stopped" | "starting" | "running" | "stopping" | "error";

export interface HealthResponse {
  status: "ok";
  service: "devdeck-server";
  timestamp: string;
}
