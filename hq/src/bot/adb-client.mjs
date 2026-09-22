const ADB_ENV = { ADB_LIBUSB: "0" };

export class AdbClient {
  constructor(processRunner, address) {
    this.processRunner = processRunner;
    this.address = address;
  }

  async connect() {
    await this.processRunner.run("adb", ["connect", this.address], {
      env: ADB_ENV,
      timeoutMs: 3_500,
    });
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
