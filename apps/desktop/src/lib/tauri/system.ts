import { invoke } from "@tauri-apps/api/core";

export function openServiceUrl(port: number) {
  return invoke<void>("open_service_url", { port });
}
