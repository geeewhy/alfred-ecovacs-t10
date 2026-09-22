import { createServer } from "node:http";
import { json, staticFile } from "./responses.mjs";

export class HqServer {
  constructor(config, statusService) {
    this.config = config;
    this.statusService = statusService;
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

    if (request.method === "GET" && await staticFile(response, this.config.publicDirectory, url.pathname)) return;
    json(response, 404, { error: "Not found" });
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, resolve);
    });
  }
}
