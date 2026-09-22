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
    if (!response.ok) throw new Error(`engine returned ${response.status}`);
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
      return await fetch(`${this.baseUrl}${path}`, {
        ...options,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
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
