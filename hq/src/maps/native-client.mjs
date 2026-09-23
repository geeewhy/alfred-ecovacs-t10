import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Commands go once through ADB: never retry a possibly delivered motion command.
export class NativeMapClient {
  constructor(adb) {
    this.adb = adb;
    this.installing = null;
    this.installed = false;
  }
  async prepare() {
    if (this.installed) return;
    if (this.installing) return this.installing;
    this.installing = (async () => {
      const source = await readFile(
        new URL("../../../runtime/map_bridge.py", import.meta.url),
      );
      const digest = createHash("sha256").update(source).digest("hex");
      const code =
        "import os,hashlib; p='/data/alfred/map_bridge.py'; print(hashlib.sha256(open(p,'rb').read()).hexdigest() if os.path.exists(p) else 'missing')";
      const current = await this.adb.shell(
        "python -c '" + code.replaceAll("'", "'\\''") + "'",
        3000,
      );
      if (current.trim() !== digest) {
        const deployed = await this.adb.processRunner.run(
          "python3",
          [new URL("../../../setup/deploy_maps.py", import.meta.url).pathname],
          { timeoutMs: 12000 },
        );
        if (deployed.code !== 0)
          throw Error(deployed.stderr || "Could not install mapping bridge");
      }
      this.installed = true;
    })().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }
  async call(action, owner = "") {
    if (
      ![
        "status",
        "snapshot",
        "start",
        "pause",
        "resume",
        "stop",
        "heartbeat",
      ].includes(action) ||
      (owner && !/^[a-zA-Z0-9-]{1,80}$/.test(owner))
    )
      throw Error("Invalid mapping command");
    await this.prepare();
    await this.adb.connect();
    const result = await this.adb.processRunner.run(
      "adb",
      [
        "-s",
        this.adb.address,
        "shell",
        `python /data/alfred/map_bridge.py ${action} ${owner}`,
      ],
      { env: { ADB_LIBUSB: "0" }, timeoutMs: 9500 },
    );
    const line = result.stdout
      .split("\n")
      .find((l) => l.startsWith("ALFRED_MAP_JSON:"));
    if (!line)
      throw Error(result.stderr.trim() || "No mapping response from robot");
    const data = JSON.parse(line.slice("ALFRED_MAP_JSON:".length));
    if (data.error) throw Error(data.error);
    if (data.accepted === false) throw Error(data.message);
    return data;
  }
}
