function value(lines, key) {
  const line = lines.find((entry) => entry.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || null;
}

function number(input) {
  if (input == null || input === "") return null;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKeyValues(input) {
  return input
    .trim()
    .split(/\s+/)
    .reduce((values, pair) => {
      const separator = pair.indexOf("=");
      if (separator > 0) values[pair.slice(0, separator)] = pair.slice(separator + 1);
      return values;
    }, {});
}

export function parseStatus(raw, robot, latencyMs, observedAt) {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const memory = parseKeyValues(value(lines, "MEMORY") ?? "");
  const dataDisk = parseKeyValues(value(lines, "DATA_DISK") ?? "");
  const load = (value(lines, "LOAD") ?? "").split(" ").map(number);
  const services = parseKeyValues(value(lines, "SERVICES") ?? "");
  const wifi = parseKeyValues(value(lines, "WIFI") ?? "");
  const manifest = parseKeyValues(value(lines, "MANIFEST") ?? "");
  let battery = {};
  try {
    battery = JSON.parse(value(lines, "BATTERY_JSON") ?? "{}").result ?? {};
  } catch {
    battery = {};
  }
  const temperatureRaw = number(value(lines, "TEMPERATURE"));

  return {
    id: robot.id,
    name: robot.name,
    model: robot.model,
    online: true,
    observedAt,
    latencyMs,
    battery: {
      percent: number(battery.percent),
      charging: typeof battery.on_charger === "boolean" ? battery.on_charger : null,
      lowVoltage: typeof battery.low_voltage === "boolean" ? battery.low_voltage : null,
      chargeState: number(battery.charge_state),
      observedAt: battery.observed_at_unix ? new Date(battery.observed_at_unix * 1000).toISOString() : null,
      source: battery.percent == null ? "Awaiting initial ROS publication" : "Engine ROS cache",
    },
    system: {
      firmware: manifest.fw_ver ?? robot.firmware,
      hardware: manifest.hw_ver ?? null,
      product: manifest.product ?? null,
      kernel: value(lines, "KERNEL"),
      architecture: value(lines, "ARCH"),
      bootId: value(lines, "BOOT_ID"),
      uptimeSeconds: number(value(lines, "UPTIME")),
      temperatureC: temperatureRaw === null ? null : Math.round(temperatureRaw / 100) / 10,
      load: { one: load[0] ?? null, five: load[1] ?? null, fifteen: load[2] ?? null },
      memory: {
        totalMiB: number(memory.total),
        availableMiB: number(memory.available),
      },
      data: {
        totalMiB: number(dataDisk.total),
        usedMiB: number(dataDisk.used),
        freeMiB: number(dataDisk.free),
      },
      rootFilesystem: "SquashFS (read-only)",
      writableRuntime: "/data/alfred",
    },
    network: {
      address: wifi.address ?? robot.wifi_address,
      mac: wifi.mac ?? robot.mac_address,
      signalDbm: number(wifi.signal),
      linkQuality: number(wifi.quality),
      transport: "Authenticated engine over Wi-Fi",
    },
    services: {
      engine: Boolean(services.engine),
      adb: Boolean(services.adbd),
      medusa: Boolean(services.medusa),
      deebot: Boolean(services.deebot),
      wifi: Boolean(services.wifi),
      pids: services,
    },
  };
}

export function offlineStatus(robot, error, observedAt) {
  return {
    id: robot.id,
    name: robot.name,
    model: robot.model,
    online: false,
    observedAt,
    error: error.message,
    battery: { percent: null, charging: null, source: "Robot offline" },
    network: { address: robot.wifi_address, mac: robot.mac_address },
  };
}
