import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ServiceLogEvent, ServiceStatusEvent } from "@devdeck/shared";

export async function subscribeToDevDeckEvents(
  onLog: (event: ServiceLogEvent) => void,
  onStatus: (event: ServiceStatusEvent) => void
): Promise<UnlistenFn> {
  const [unlistenLog, unlistenStatus] = await Promise.all([
    listen<ServiceLogEvent>("service:log", (event) => onLog(event.payload)),
    listen<ServiceStatusEvent>("service:status", (event) => onStatus(event.payload))
  ]);

  return () => {
    unlistenLog();
    unlistenStatus();
  };
}
