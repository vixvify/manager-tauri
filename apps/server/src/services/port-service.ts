import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PortCheckResult {
  port: number;
  status: "available" | "occupied";
  pid?: number;
  processName?: string;
}

export class PortService {
  async check(port: number): Promise<PortCheckResult> {
    const server = createServer();

    return new Promise((resolve, reject) => {
      server.once("error", async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EADDRINUSE") {
          reject(error);
          return;
        }

        const owner = await this.findOwner(port);
        resolve({ port, status: "occupied", ...owner });
      });
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve({ port, status: "available" }));
      });
    });
  }

  async waitUntilListening(port: number, attempts = 12) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.check(port);
      if (result.status === "occupied") {
        return result;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return { port, status: "available" as const };
  }

  private async findOwner(port: number) {
    if (process.platform !== "win32") {
      return {};
    }

    try {
      const { stdout } = await execFileAsync("netstat.exe", ["-ano", "-p", "tcp"], { windowsHide: true });
      const line = stdout.split(/\r?\n/).find((candidate) => {
        const columns = candidate.trim().split(/\s+/);
        return columns[0] === "TCP" && columns[1]?.endsWith(`:${port}`) && columns[3] === "LISTENING";
      });
      const pidText = line?.trim().split(/\s+/).at(-1);
      const pid = pidText ? Number(pidText) : undefined;

      if (!pid) {
        return {};
      }

      const task = await execFileAsync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
      const processName = task.stdout.match(/^"([^"]+)"/)?.[1];
      return { pid, processName };
    } catch {
      return {};
    }
  }
}
