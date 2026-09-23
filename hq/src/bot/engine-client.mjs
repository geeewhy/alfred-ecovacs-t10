import { diagnosticState } from "../infra/diagnostics.mjs";
export class EngineClient {
  constructor(adbClient, localPort, remotePort = 8765) {
    this.adbClient = adbClient;
    this.localPort = localPort;
    this.remotePort = remotePort;
    this.baseUrl = `http://127.0.0.1:${localPort}`;
  }

  async connect() {
    await this.adbClient.forward(this.localPort, this.remotePort);
  }

  async bumpers() {
    const response = await this.request("/v1/telemetry/bumpers");
    if (!response.ok) throw new Error(`engine returned ${response.status}`);
    return response.json();
  }

  async lidar() {
    const response = await this.request("/v1/telemetry/lidar");
    if (!response.ok) throw new Error(`engine returned ${response.status}`);
    return response.json();
  }

  cameraFrame() {
    return this.request("/v1/camera/frame", 4_000);
  }

  async drive(vector) {
    const response = await this.request("/v1/drive", 2_000, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(vector),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.message ?? result.error ?? `engine returned ${response.status}`);
    }
    return response.json();
  }

  async stop() {
    const response = await this.request("/v1/drive/stop", 2_000, { method: "POST" });
    if (!response.ok) throw new Error(`engine returned ${response.status}`);
    return response.json();
  }

  async request(path, timeoutMs = 2_000, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        cache: "no-store",
        signal: controller.signal,
      });
      diagnosticState("engine-http", "connected");
      return response;
    } catch (error) {
      diagnosticState("engine-http", "unreachable", { error: error.message });
      await this.connect();
      return fetch(`${this.baseUrl}${path}`, {
        ...options,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
