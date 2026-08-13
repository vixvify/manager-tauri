import { invoke } from "@tauri-apps/api/core";
import type { GitBranch, GitPullResult } from "@devdeck/shared";

export function getGitBranches(projectId: string) {
  return invoke<GitBranch[]>("get_git_branches", { projectId });
}

export function pullProject(projectId: string, branch: string) {
  return invoke<GitPullResult>("pull_project", { projectId, branch });
}
