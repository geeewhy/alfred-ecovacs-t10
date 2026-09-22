import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export async function loadConfig() {
  const robot = JSON.parse(await readFile(path.join(root, "robot.json"), "utf8"));

  return {
    host: process.env.HQ_HOST ?? "127.0.0.1",
    port: Number(process.env.HQ_PORT ?? 4173),
    publicDirectory: path.join(root, "hq/public"),
    engineForwardPort: Number(process.env.HQ_ENGINE_PORT ?? 48765),
    robot: {
      id: "alfred",
      name: "Alfred",
      ...robot,
      adbAddress: `${robot.wifi_address}:5555`,
    },
  };
}
