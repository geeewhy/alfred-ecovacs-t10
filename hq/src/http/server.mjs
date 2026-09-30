import { IntentModel } from '../bot/intent-model.mjs';
import { RobotIntents } from '../bot/robot-intents.mjs';
import { MapService } from '../maps/map-service.mjs';
import { VoiceService } from "../bot/voice-service.mjs";
import { ChatService } from "../bot/chat-service.mjs";
import { SpeechService } from "../bot/speech-service.mjs";
import { createServer } from "node:http";
import { json, staticFile } from "./responses.mjs";

export class HqServer {
  constructor(config, statusService, engineClient) {
    this.config = config;
    this.maps = new MapService(engineClient);
    this.speech = new SpeechService(engineClient);
    this.chat = new ChatService(this.speech, {sections:()=>this.maps.sectionCatalog(), direct:{
      model:new IntentModel(),commands:new RobotIntents(this.maps,engineClient,statusService,async()=>{
        const task=(async()=>{await engineClient.stop();await this.maps.stopExploration();})();
        this.driveStopTask=task;
        try{await task;}finally{if(this.driveStopTask===task)this.driveStopTask=null;}
      })
    }});
    this.voice = new VoiceService(this.chat, this.speech);
    this.statusService = statusService;
    this.engineClient = engineClient;
    this.server = createServer(this.handle.bind(this));
  }

  async handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

    if(url.pathname==="/api/bots/alfred/station" && request.method==="GET"){
      try{return json(response,200,{ok:true,result:await this.engineClient.dockStatus()});}
      catch(error){return json(response,503,{ok:false,error:error.message});}
    }
    if (url.pathname === "/api/maps" || url.pathname.startsWith("/api/maps/")) {
      try {
        if(url.pathname === "/api/maps/active" && request.method === "GET") return json(response,200,{ok:true,result:this.maps.summary()});
        if(url.pathname === "/api/maps/active/pause" && request.method === "POST") return json(response,200,{ok:true,result:await this.maps.pauseActive()});
        if(url.pathname === "/api/maps/settings") {
          if(request.method==="GET")return json(response,200,{ok:true,result:(await this.maps.navigation.call("status")).settings});
          if(request.method==="PUT"){if(this.maps.active?.status.state==="scanning")await this.maps.pauseActive();else await this.maps.navigation.call("pause");return json(response,200,{ok:true,result:await this.maps.navigation.call("settings",await readJson(request))});}
        }
        if(url.pathname === "/api/maps/engine-return" && request.method === "GET") return json(response,200,{ok:true,result:await this.engineClient.onboardReturn()});
        if(url.pathname === "/api/maps/sections" && request.method === "GET") return json(response,200,{ok:true,result:await this.maps.sectionCatalog()});
        if(url.pathname === "/api/maps/sections/resolve" && request.method === "GET") return json(response,200,{ok:true,result:await this.maps.resolveSection(url.searchParams.get("name"),url.searchParams.get("map_id"))});
        const [, , , id, action] = url.pathname.split("/");
        let result;
        if (!id && request.method === "GET") result = await this.maps.list();
        else if (!id && request.method === "POST") result = await this.maps.create(await readJson(request));
        else if (id && !action && request.method === "DELETE") result = await this.maps.remove(id);
        else if (id && !action && request.method === "GET") result = await this.maps.get(id);
        else if (id && action === "structure-refresh" && request.method === "POST") result = await this.maps.refreshStructure(id);
        else if (id && action === "position" && request.method === "GET") result = await this.maps.position(id);
        else if (id && action === "edit" && request.method === "POST") result = await this.maps.edit(id, await readJson(request));
        else if (id && action === "navigate" && request.method === "POST") result = await this.maps.navigateTo(id, await readJson(request));
        else if (id && action === "return-onboard" && request.method === "POST") result = await this.maps.returnOnboard(id);
        else if (id && action === "return" && request.method === "POST") result = await this.maps.returnToStation(id);
        else if (id && action === "scan" && request.method === "POST") {
          const body=await readJson(request), controller=new AbortController();
          const timer=setTimeout(()=>controller.abort(),12000);
          response.once('close',()=>{if(!response.writableEnded)controller.abort();});
          try{result=await this.maps.scan(id,body.action,{...body,signal:controller.signal});}finally{clearTimeout(timer);}
        }
        else return json(response, 405, {ok:false,error:"Method not allowed"});
        return json(response, 200, {ok:true,result});
      } catch (error) { return json(response, 400, {ok:false,error:error.message}); }
    }

    if (url.pathname === "/api/bots/alfred/chat/models" && request.method === "GET") {
      try { return json(response, 200, { ok: true, result: await this.chat.catalog() }); }
      catch (error) { return json(response, 503, { ok: false, error: error.message }); }
    }
    if (url.pathname === "/api/bots/alfred/chat" || url.pathname === "/api/bots/alfred/chat/settings") {
      try {
        let result;
        if (request.method === "GET") result = await this.chat.current();
        else if (request.method === "PUT" && url.pathname.endsWith("/settings")) result = await this.chat.settings(await readJson(request));
        else if (request.method === "POST" && !url.pathname.endsWith("/settings")) result = await this.chat.send((await readJson(request)).text);
        else return json(response, 405, { ok: false, error: "Method not allowed" });
        if (request.method === "PUT") this.voice.reset();
        return json(response, 200, { ok: true, result: { ...result, microphone: this.voice.state } });
      } catch (error) { return json(response, 400, { ok: false, error: error.message }); }
    }

    if (url.pathname === "/api/bots/alfred/speech/settings" && ["GET", "PUT"].includes(request.method)) {
      try {
        const result = request.method === "GET" ? await this.speech.settings() : await this.speech.save(await readJson(request));
        return json(response, 200, { ok: true, result });
      } catch (error) { return json(response, 400, { ok: false, error: error.message }); }
    }
    if (url.pathname === "/api/bots/alfred/speech" && request.method === "POST") {
      try { return json(response, 200, { ok: true, result: await this.speech.say((await readJson(request)).text) }); }
      catch (error) { return json(response, 400, { ok: false, error: error.message }); }
    }

    if (request.method === "GET" && url.pathname === "/api/bots") {
      const robot = await this.statusService.current();
      return json(response, 200, { robots: [robot] });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, service: "hq", version: "0.1.0" });
    }

    if (request.method === "GET" && url.pathname === "/api/bots/alfred/bumpers") {
      try { return json(response, 200, await this.engineClient.bumpers()); }
      catch (error) { return json(response, 503, { ok: false, error: error.message }); }
    }

    if (request.method === "GET" && url.pathname === "/api/bots/alfred/lidar") {
      try {
        const scan = await this.engineClient.lidar();
        return json(response, 200, scan);
      } catch (error) {
        return json(response, 503, { ok: false, error: error.message });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/bots/alfred/camera/frame") {
      try {
        const frame = await this.engineClient.cameraFrame();
        const headers = {
          "Content-Type": frame.headers.get("content-type") ?? "application/octet-stream",
          "Cache-Control": "no-store",
        };
        for (const name of ["x-frame-width", "x-frame-height", "x-observed-at"]) {
          const value = frame.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(frame.status, headers);
        response.end(Buffer.from(await frame.arrayBuffer()));
      } catch (error) {
        return json(response, 503, { ok: false, error: error.message });
      }
      return;
    }

    if (["GET", "PUT"].includes(request.method) && url.pathname === "/api/bots/alfred/drive/settings") {
      try {
        const options = request.method === "PUT" ? {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify(await readJson(request)),
        } : {};
        const upstream = await this.engineClient.request("/v1/drive/settings", 3000, options);
        return json(response, upstream.status, await upstream.json());
      } catch (error) {
        return json(response, 503, { ok: false, error: error.message });
      }
    }

    if (request.method === "PUT" && url.pathname === "/api/bots/alfred/drive") {
      try {
        if(this.driveStopTask) throw Error("Stopping previous controller; retry while held");
        if(this.maps.ownsMotion) {
          // Cancel autonomous motion without retaining this drive vector across
          // slow cleanup. A fresh held-control update may take over afterward.
          const task=(async()=>{await this.engineClient.stop();await this.maps.pauseActive();})();
          this.driveStopTask=task;
          task.catch(()=>{}).finally(()=>{if(this.driveStopTask===task)this.driveStopTask=null;});
          throw Error("Stopping previous controller; retry while held");
        }
        const vector = await readJson(request);
        this.maps.prepareManualDrive(vector);
        return json(response, 200, await this.engineClient.drive(vector));
      } catch (error) {
        return json(response, 503, { ok: false, error: error.message });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/bots/alfred/lidar/wake") {
      try {
        await this.engineClient.wakeForMapping();
        return json(response, 200, {ok:true,result:"Alfred and LiDAR are awake"});
      } catch (error) {
        return json(response, 503, {ok:false,error:error.message});
      }
    }

    if (request.method === "POST" && url.pathname === "/api/bots/alfred/drive/wake") {
      try {
        const upstream = await this.engineClient.request("/v1/drive/wake", 1500, { method: "POST" });
        return json(response, upstream.status, await upstream.json());
      } catch (error) {
        return json(response, 503, { ok: false, error: error.message });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/bots/alfred/drive/stop") {
      try {
        // Stop immediately. Controller cleanup may send further stops, so
        // reject new drive commands until that cleanup is finished.
        const task = (async () => {
          const result = await this.engineClient.stop();
          await this.maps.stopExploration();
          return result;
        })();
        this.driveStopTask = task;
        try { return json(response, 200, await task); }
        finally { if(this.driveStopTask === task) this.driveStopTask = null; }
      } catch (error) {
        return json(response, 503, { ok: false, error: error.message });
      }
    }

    if (request.method === "GET" && await staticFile(response, this.config.publicDirectory, url.pathname)) return;
    json(response, 404, { error: "Not found" });
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, resolve);
    });
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 131_072) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
