import { createServer } from "node:http";
import { json, staticFile } from "./responses.mjs";

export class HqServer {
  constructor(config, statusService, engineClient) {
    this.config = config;
    this.statusService = statusService;
    this.engineClient = engineClient;
    this.server = createServer(this.handle.bind(this));
  }

  async handle(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/bots") {
      const robot = await this.statusService.current();
      return json(response, 200, { robots: [robot] });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, service: "hq", version: "0.1.0" });
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

    if (request.method === "PUT" && url.pathname === "/api/bots/alfred/drive") {
      try {
        const vector = await readJson(request);
        return json(response, 200, await this.engineClient.drive(vector));
      } catch (error) {
        return json(response, 503, { ok: false, error: error.message });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/bots/alfred/drive/stop") {
      try {
        return json(response, 200, await this.engineClient.stop());
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
    if (size > 4_096) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
