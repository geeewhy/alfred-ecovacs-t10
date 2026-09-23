import { diagnosticState } from "../infra/diagnostics.mjs";
import { offlineStatus, parseStatus } from "./status-parser.mjs";

const STATUS_COMMAND = String.raw`
printf 'BOOT_ID='; cat /proc/sys/kernel/random/boot_id
printf 'KERNEL='; uname -r
printf 'ARCH='; uname -m
printf 'UPTIME='; cut -d' ' -f1 /proc/uptime
printf 'LOAD='; cut -d' ' -f1-3 /proc/loadavg
awk '/MemTotal:/ { total=int($2/1024) } /MemAvailable:/ { available=int($2/1024) } END { printf "MEMORY=total=%s available=%s\n", total, available }' /proc/meminfo
df -k /data | awk 'NR==2 { printf "DATA_DISK=total=%d used=%d free=%d\n", $2/1024, $3/1024, $4/1024 }'
printf 'TEMPERATURE='; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || true
ip addr show wlan0 | awk '/link\/ether/ { mac=$2 } /inet / { split($2,a,"/"); address=a[1] } END { printf "WIFI=address=%s mac=%s ", address, mac }'
awk '/wlan0:/ { printf "quality=%s signal=%s\n", $3, $4 }' /proc/net/wireless
printf 'MANIFEST='; awk -F'[:,]' '/"product"|"hw_ver"|"fw_ver"/ { gsub(/[ "{}]/,"",$1); gsub(/[ "{}]/,"",$2); printf "%s=%s ",$1,$2 } END { print "" }' /etc/fw.manifest
printf 'SERVICES=engine=%s adbd=%s medusa=%s deebot=%s wifi=%s\n' "$(pidof alfred-engine | awk '{print $1}')" "$(pidof adbd | awk '{print $1}')" "$(pidof medusa | awk '{print $1}')" "$(pidof deebot | awk '{print $1}')" "$(pidof wifi_daemon | awk '{print $1}')"
printf 'BATTERY_JSON='; curl -fsS --max-time 1 http://127.0.0.1:8765/v1/telemetry/battery 2>/dev/null || printf '{}'; printf '\n'
`;

export class RobotStatusService {
  constructor(adbClient, robot) {
    this.adbClient = adbClient;
    this.robot = robot;
  }

  async current() {
    const observedAt = new Date().toISOString();
    const startedAt = performance.now();
    try {
      const raw = await this.adbClient.shell(STATUS_COMMAND);
      const status = parseStatus(raw, this.robot, Math.round(performance.now() - startedAt), observedAt);
      diagnosticState('robot', 'online', { address: this.robot.adbAddress });
      diagnosticState('boot', status.system?.bootId ?? 'unknown');
      return status;
    } catch (error) {
      diagnosticState('robot', 'offline', { error: error.message });
      return offlineStatus(this.robot, error, observedAt);
    }
  }
}
