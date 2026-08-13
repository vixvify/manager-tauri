import { spawn } from "node:child_process";
import { platform } from "node:os";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class DockerComposeService {
  isDetachedUp(command: string) {
    return /(?:docker\s+compose|docker-compose)[\s\S]*\bup\b[\s\S]*(?:^|\s)(?:-d|--detach)(?:\s|$)/i.test(command);
  }

  async start(command: string, workingDirectory: string) {
    const result = await this.run(command, workingDirectory);

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Docker Compose exited with code ${result.code}.`);
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (await this.isRunning(command, workingDirectory)) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    return false;
  }

  async isRunning(command: string, workingDirectory: string) {
    const result = await this.run(this.toStatusCommand(command), workingDirectory);
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  async stop(command: string, workingDirectory: string) {
    const result = await this.run(this.toStopCommand(command), workingDirectory);

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Docker Compose stop exited with code ${result.code}.`);
    }
  }

  private toStatusCommand(command: string) {
    const { prefix, services } = this.splitComposeUpCommand(command);
    return `${prefix}ps --services --filter status=running${services ? ` ${services}` : ""}`;
  }

  private toStopCommand(command: string) {
    const { prefix, services } = this.splitComposeUpCommand(command);
    return `${prefix}stop${services ? ` ${services}` : ""}`;
  }

  private splitComposeUpCommand(command: string) {
    const upIndex = command.search(/\bup\b/i);

    if (upIndex === -1) {
      return { prefix: command, services: "" };
    }

    const prefix = command.slice(0, upIndex);
    const afterUp = command.slice(upIndex + 2);
    const services = afterUp
      .trim()
      .split(/\s+/)
      .filter((token) => token && !token.startsWith("-"))
      .join(" ");

    return { prefix, services };
  }

  private run(command: string, workingDirectory: string) {
    return new Promise<CommandResult>((resolve) => {
      const child = platform() === "win32"
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], { cwd: workingDirectory, windowsHide: true })
        : spawn("/bin/sh", ["-c", command], { cwd: workingDirectory });
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
      child.once("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
}
