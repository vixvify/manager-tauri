import { invoke } from "@tauri-apps/api/core";
import type { BuildResult, ProjectRuntimeState, ServiceLogEntry, ServiceRuntimeState } from "@devdeck/shared";

export function getRuntime() {
  return invoke<ProjectRuntimeState[]>("get_runtime");
}

export function getProjectRuntime(projectId: string) {
  return invoke<ProjectRuntimeState>("get_project_runtime", { projectId });
}

export function startProject(projectId: string) {
  return invoke<ProjectRuntimeState>("start_project", { projectId });
}

export function stopProject(projectId: string) {
  return invoke<ProjectRuntimeState>("stop_project", { projectId });
}

export function startService(projectId: string, serviceId: string) {
  return invoke<ServiceRuntimeState>("start_service", { projectId, serviceId });
}

export function stopService(projectId: string, serviceId: string) {
  return invoke<ServiceRuntimeState>("stop_service", { projectId, serviceId });
}

export function restartService(projectId: string, serviceId: string) {
  return invoke<ServiceRuntimeState>("restart_service", { projectId, serviceId });
}

export function buildService(projectId: string, serviceId: string) {
  return invoke<BuildResult>("build_service", { projectId, serviceId });
}

export function getServiceLogs(projectId: string, serviceId: string) {
  return invoke<ServiceLogEntry[]>("get_service_logs", { projectId, serviceId });
}
