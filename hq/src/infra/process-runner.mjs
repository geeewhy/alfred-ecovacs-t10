import { spawn } from "node:child_process";

export class ProcessRunner {
  async run(command, args, { env = {}, timeoutMs = 8_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let settled = false;

      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (error, code = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const result = {
          code,
          stdout: Buffer.concat(stdout).toString("utf8").replaceAll("\r\n", "\n"),
          stderr: Buffer.concat(stderr).toString("utf8").replaceAll("\r\n", "\n"),
        };
        if (error) reject(Object.assign(error, { result }));
        else resolve(result);
      };

      child.on("error", finish);
      child.on("close", (code) => finish(null, code));
    });
  }
}
