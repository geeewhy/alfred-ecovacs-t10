import { diagnosticState } from "../infra/diagnostics.mjs";
const ADB_ENV = { ADB_LIBUSB: "0" };

export class AdbClient {
  constructor(processRunner, address) {
    this.processRunner = processRunner;
    this.address = address;
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        // Query the host transport first. This firmware leaks a socket for each
        // redundant `adb connect`, eventually killing adbd at its FD limit.
        const state = await this.processRunner.run("adb", ["-s", this.address, "get-state"], { env: ADB_ENV, timeoutMs: 1500 });
        if (state.code === 0 && state.stdout.trim() === "device") return;
        if (/offline/i.test(state.stderr || ""))
          await this.processRunner.run("adb", ["disconnect", this.address], { env: ADB_ENV, timeoutMs: 1500 });
        const result = await this.processRunner.run("adb", ["connect", this.address], { env: ADB_ENV, timeoutMs: 3500 });
        if (result.code !== 0 || !/^(already )?connected to /m.test(result.stdout)) throw new Error((result.stderr || result.stdout).trim() || 'ADB connection failed');
        diagnosticState('adb', 'connected', { address: this.address });
      } catch (error) {
        if(process.platform==='darwin' && /No route to host/i.test(error.message)){
          error.message+=' Check macOS Privacy & Security → Local Network access for Haicue and adb.';
        }
        diagnosticState('adb', 'disconnected', { address: this.address, error: error.message });
        throw error;
      }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async shell(command, timeoutMs = 8_000) {
    await this.connect();
    const result = await this.processRunner.run(
      "adb",
      ["-s", this.address, "shell", command],
      { env: ADB_ENV, timeoutMs },
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `adb shell exited ${result.code}`);
    }
    return result.stdout;
  }

  async forward(localPort, remotePort) {
    await this.connect();
    const result = await this.processRunner.run(
      "adb",
      ["-s", this.address, "forward", `tcp:${localPort}`, `tcp:${remotePort}`],
      { env: ADB_ENV, timeoutMs: 3_500 },
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `adb forward exited ${result.code}`);
    }
  }
}
