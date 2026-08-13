import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectInput } from "@devdeck/shared";

export function getProjects() {
  return invoke<Project[]>("get_projects");
}

export function getProject(projectId: string) {
  return invoke<Project>("get_project", { projectId });
}

export function addProject(input: ProjectInput) {
  return invoke<Project>("add_project", { input });
}

export function updateProject(projectId: string, input: ProjectInput) {
  return invoke<Project>("update_project", { projectId, input });
}

export function removeProject(projectId: string) {
  return invoke<void>("remove_project", { projectId });
}

export function reorderProjects(projectIds: string[]) {
  return invoke<Project[]>("reorder_projects", { input: { projectIds } });
}
