import type { LogStream, ServiceLogEntry, ServiceLogEvent } from "@devdeck/shared";

type LogListener = (event: ServiceLogEvent) => void;

export class LogManager {
  private readonly history = new Map<string, ServiceLogEntry[]>();
  private readonly listeners = new Set<LogListener>();

  constructor(private readonly maxEntries = 500) {}

  onLog(listener: LogListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(projectId: string, serviceId: string, stream: LogStream, message: string) {
    if (!message) {
      return;
    }

    const entry: ServiceLogEntry = {
      timestamp: new Date().toISOString(),
      stream,
      message
    };
    const key = this.key(projectId, serviceId);
    const entries = this.history.get(key) ?? [];

    entries.push(entry);
    if (entries.length > this.maxEntries) {
      entries.splice(0, entries.length - this.maxEntries);
    }
    this.history.set(key, entries);

    const event: ServiceLogEvent = { type: "service:log", projectId, serviceId, ...entry };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  get(projectId: string, serviceId: string) {
    return [...(this.history.get(this.key(projectId, serviceId)) ?? [])];
  }

  clear(projectId: string, serviceId: string) {
    this.history.delete(this.key(projectId, serviceId));
  }

  private key(projectId: string, serviceId: string) {
    return `${projectId}:${serviceId}`;
  }
}
