import { diagnosticState } from "../infra/diagnostics.mjs";
export class EngineClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async localization(action="status",body) {
    const response=await this.request(action==="map"?"/v1/localization/map":"/v1/localization",8000,{method:action==="status"?"GET":action==="map"?"PUT":"POST",headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();
    if(!response.ok || !value.ok)throw Error(value.error||value.result||"Engine localization unavailable");
    return value.result;
  }

  async catFollow(action="status",body) {
    const response=await this.request(action==="stop"?"/v1/cat-follow/stop":"/v1/cat-follow",8000,{method:action==="status"?"GET":"POST",headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();
    if(!response.ok||!value.ok)throw Error(value.result||value.error||"Cat mode unavailable");
    return value.result;
  }

  async navigate(action="status",body) {
    const path=action==="stop"?"/v1/navigation/stop":"/v1/navigation";
    const response=await this.request(path,8000,{method:action==="status"?"GET":"POST",headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();
    if(!response.ok || !value.ok)throw Error(value.result||"Engine navigation unavailable");
    return value.result;
  }

  async onboardReturn(action="status", body) {
    const path=action==="config"?"/v1/return/config":action==="stop"?"/v1/return/stop":"/v1/return";
    const response=await this.request(path,8000,{method:action==="status"?"GET":action==="config"?"PUT":"POST",headers:{"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();
    if(!response.ok || !value.ok)throw Error(value.result||"Engine return unavailable");
    return value.result;
  }

  async connect() {
    const response=await this.request("/health");
    if(!response.ok)throw Error(`Engine health returned ${response.status}`);
  }
  async dockStatus() {
    const requestedAt=Date.now();
    const response=await this.request("/v1/telemetry/dock",800);
    const value=await response.json();
    if(!response.ok || !value.ok)throw Error(value.result||"Dock telemetry unavailable");
    // This endpoint performs a fresh native query. Use its request start in
    // the host clock domain, conservatively including the full round trip.
    return {...value.result,sourceObservedAt:value.result.observedAt,observedAt:requestedAt};
  }
  async systemStatus() {
    const response=await this.request("/v1/system/status",7000);
    const value=await response.json();
    if(!response.ok || !value.ok)throw Error(value.result||"System telemetry unavailable");
    return value.result;
  }
  async stopNativeReturn() {
    const response=await this.request("/v1/drive/native-return/stop",7000,{method:"POST"});
    const value=await response.json();
    const line=typeof value.result==="string" && value.result.split('\n').find(line=>line.startsWith('ALFRED_MAP_JSON:'));
    const result=line && JSON.parse(line.slice('ALFRED_MAP_JSON:'.length));
    if(!response.ok || !value.ok || !result?.accepted)throw Error(result?.message||value.result||"Native return did not stop");
    return result;
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
    const response = await this.request("/v1/mapping/drive",250, {
      method: "PUT", headers: {"content-type":"application/json"},
      body: JSON.stringify(vector), signal: AbortSignal.timeout(250),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw Error(data.result || data.error || "Mapping motion rejected");
    return data.result;
  }

  async wakeForMapping(signal) {
    // Check the direct engine connection before requesting wake.
    signal?.throwIfAborted();
    try { await this.connect(); }
    catch (error) { throw Error(`Cannot reach Alfred's engine: ${error.message}`); }
    for(let attempt=0;attempt<5;attempt++){
      signal?.throwIfAborted();
      const response=await this.request('/v1/drive/wake',1500,{method:'POST'});
      const value=await response.json();
      if(response.ok&&value.ok){await this.ensureMappingLidar(signal);return {woke:attempt>0};}
      if(!/waking|wake check/i.test(value.result||''))throw Error(value.result||'Robot wake failed');
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw Error('Robot did not wake in time.');
  }
  async ensureMappingLidar(signal) {
    const first=(await this.lidar()).result;
    if(Number.isFinite(first?.age_ms)&&first.age_ms<=750)return;
    // Firmware may be awake while its docked LiDAR remains powered down.
    signal?.throwIfAborted();
    const response=await this.request('/v1/drive/lidar-wake',7000,{method:'POST'});
    if(!response.ok)throw Error('LiDAR wake failed');
    for(let attempt=0;attempt<5;attempt++){
      signal?.throwIfAborted();
      const scan=(await this.lidar()).result;
      if(scan?.sequence!==first?.sequence && Number.isFinite(scan?.age_ms)&&scan.age_ms<=750)return;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    throw Error('LiDAR did not resume fresh scans. Position search has not started.');
  }
  async nativeMapping(action, body) {
    const path = `/v1/mapping/native/${action}`;
    // Never retry a control mutation whose delivery might have succeeded.
    const response = await this.request(path,action==='load'?5000:1500, {method:['grid','status','snapshot'].includes(action)?'GET':'POST',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(action==='load'?5000:1500)});
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
    if(!this.token)throw Error("Engine credential is not installed");
    try {
      const headers=new Headers(options.headers);
      headers.set("Authorization",`Bearer ${this.token}`);
      const response=await fetch(`${this.baseUrl}${path}`,{
        ...options,headers,cache:"no-store",signal:AbortSignal.timeout(timeoutMs),
      });
      diagnosticState("engine-http",response.ok?"connected":"rejected",{status:response.status});
      return response;
    } catch(error) {
      diagnosticState("engine-http","unreachable",{error:error.message});
      // Never replay a mutation or switch transports after uncertain delivery.
      throw error;
    }
  }
}
