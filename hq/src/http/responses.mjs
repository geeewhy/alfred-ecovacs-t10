import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export async function staticFile(response, publicDirectory, pathname) {
  const requested = ["/", "/cockpit", "/settings"].includes(pathname) ? "index.html" : pathname.slice(1);
  const absolute = path.resolve(publicDirectory, requested);
  if (!absolute.startsWith(`${path.resolve(publicDirectory)}${path.sep}`)) return false;

  try {
    if (!(await stat(absolute)).isFile()) return false;
    const body = await readFile(absolute);
    response.writeHead(200, {
      "Content-Type": MIME[path.extname(absolute)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
    return true;
  } catch {
    return false;
  }
}
