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
    const started = Date.now();
    const response = await this.request("/v1/telemetry/lidar");
    if (!response.ok) throw new Error(`engine returned ${response.status}`);
    const data = await response.json();
    if (Number.isFinite(data.result?.age_ms)) {
      data.result.age_ms += Date.now() - started;
      data.result.received_at_unix_ms = Date.now();
    }
    return data;
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
      throw new Error(result.message ?? result.error ?? result.result ?? `engine returned ${response.status}`);
    }
    return response.json();
  }

  async mappingDrive(vector) {
    const response = await fetch(`${this.baseUrl}/v1/mapping/drive`, {
      method: "PUT", headers: {"content-type":"application/json"},
      body: JSON.stringify(vector), signal: AbortSignal.timeout(250),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw Error(data.result || data.error || "Mapping motion rejected");
    return data.result;
  }

  async wakeForMapping(signal) {
    // A robot reboot removes adb forwards while shell/status can already be
    // online again. Restore transport before sending any mapping mutation.
    signal?.throwIfAborted();
    try { await this.connect(); }
    catch (error) { throw Error(`Cannot reach Alfred's engine: ${error.message}`); }
    for(let attempt=0;attempt<5;attempt++){
      signal?.throwIfAborted();
      const response=await fetch(this.baseUrl+'/v1/drive/wake',{method:'POST',signal:AbortSignal.timeout(1500)});
      const value=await response.json();
      if(response.ok&&value.ok)return;
      if(!/waking|wake check/i.test(value.result||''))throw Error(value.result||'Robot wake failed');
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw Error('Robot did not wake in time.');
  }
  async nativeMapping(action, body) {
    const path = `/v1/mapping/native/${action}`;
    // Never retry a control mutation whose delivery might have succeeded.
    const response = await fetch(this.baseUrl+path, {method:['grid','status','snapshot'].includes(action)?'GET':'POST',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(action==='load'?5000:1500)});
    const value=await response.json();
    if(!response.ok||!value.ok)throw Error(value.result||'Native mapping request failed');
    return value.result;
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
