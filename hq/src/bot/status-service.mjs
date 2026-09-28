import { diagnosticState } from "../infra/diagnostics.mjs";
import { offlineStatus, parseStatus } from "./status-parser.mjs";

export class RobotStatusService {
  constructor(engineClient, robot) {
    this.engineClient = engineClient;
    this.robot = robot;
  }

  async current() {
    const observedAt = new Date().toISOString();
    const startedAt = performance.now();
    try {
      const raw = await this.engineClient.systemStatus();
      const status = parseStatus(raw, this.robot, Math.round(performance.now() - startedAt), observedAt);
      diagnosticState('robot', 'online', { address: this.engineClient.baseUrl });
      diagnosticState('boot', status.system?.bootId ?? 'unknown');
      return status;
    } catch (error) {
      diagnosticState('robot', 'offline', { error: error.message });
      return offlineStatus(this.robot, error, observedAt);
    }
  }
}
