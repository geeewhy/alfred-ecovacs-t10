const app = document.querySelector("#app");

const icons = {
  home: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 9.1 10 3.8l6.5 5.3v7.1H12v-4.5H8v4.5H3.5Z"/></svg>`,
  cockpit: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.7"/><circle cx="10" cy="10" r="2"/><path d="M10 3.3v4.6M4.2 13.4l4-2.3m7.6 2.3-4-2.3"/></svg>`,
  robot: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10.5" r="6.4"/><path d="M6.7 6.9h6.6M10 4.1v2.8"/><circle cx="7.6" cy="10.5" r=".7"/><circle cx="12.4" cy="10.5" r=".7"/></svg>`,
  arrow: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 4.5 5 5.5-5 5.5"/></svg>`,
};

function shell(content, active) {
  return `
    <div class="shell">
      <aside class="rail">
        <a class="wordmark" href="/" data-route><span>H</span><strong>HQ</strong></a>
        <nav aria-label="Primary">
          <a class="nav-item ${active === "home" ? "active" : ""}" href="/" data-route>${icons.home}<span>Home</span></a>
          <a class="nav-item ${active === "cockpit" ? "active" : ""}" href="/cockpit" data-route>${icons.cockpit}<span>Cockpit</span></a>
        </nav>
        <div class="rail-foot"><span class="local-mark"></span><span>Local</span></div>
      </aside>
      <main>${content}</main>
    </div>`;
}

function metric(label, value, detail = "") {
  return `<div class="metric"><dt>${label}</dt><dd>${value ?? "—"}</dd>${detail ? `<small>${detail}</small>` : ""}</div>`;
}

function formatUptime(seconds) {
  if (seconds == null) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function service(name, running) {
  return `<li><span class="service-mark ${running ? "up" : "down"}"></span><span>${name}</span><code>${running ? "running" : "stopped"}</code></li>`;
}

function home(robot) {
  const online = robot?.online;
  const system = robot?.system ?? {};
  const network = robot?.network ?? {};
  const services = robot?.services ?? {};
  const battery = robot?.battery ?? {};
  const memoryUsed = system.memory?.totalMiB && system.memory?.availableMiB != null
    ? system.memory.totalMiB - system.memory.availableMiB
    : null;

  return shell(`
    <header class="topbar"><span>Home</span><time id="observed">${robot ? `Updated ${new Date(robot.observedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Connecting"}</time></header>
    <div class="content">
      <section class="heading"><p class="eyebrow">FLEET / 01</p><h1>Robots</h1><p>Local machines connected to HQ.</p></section>
      <a class="robot-row" href="/cockpit" data-route>
        <div class="robot-glyph">${icons.robot}</div>
        <div class="robot-identity"><strong>${robot?.name ?? "Alfred"}</strong><span>${robot?.model ?? "Ecovacs T10 Omni DBX53"}</span></div>
        <div class="connection"><span class="status-dot ${online ? "online" : "offline"}"></span><span>${online ? "Online" : "Offline"}</span><code>${network.address ?? "192.168.1.89"}</code></div>
        <div class="battery"><span>Battery</span><strong>${battery.percent == null ? "—" : `${battery.percent}%`}</strong><small>${battery.charging === true ? "Charging" : battery.charging === false ? "On battery" : battery.source ?? "Waiting"}</small></div>
        <span class="row-arrow">${icons.arrow}</span>
      </a>

      ${!online && robot?.error ? `<div class="error-line"><strong>Connection failed</strong><span>${robot.error}</span></div>` : ""}

      <div class="detail-columns">
        <section class="detail-section">
          <div class="section-title"><h2>System</h2><span>Live from Linux</span></div>
          <dl class="metric-list">
            ${metric("Firmware", system.firmware, `${system.product ?? "zj2116c"} · hardware ${system.hardware ?? "1.0"}`)}
            ${metric("Kernel", system.kernel, system.architecture)}
            ${metric("Uptime", formatUptime(system.uptimeSeconds), system.bootId ? `boot ${system.bootId.slice(0, 8)}` : "")}
            ${metric("Load average", system.load ? `${system.load.one} / ${system.load.five} / ${system.load.fifteen}` : null, "1 / 5 / 15 minutes")}
            ${metric("Memory", memoryUsed == null ? null : `${memoryUsed} / ${system.memory.totalMiB} MiB`, `${system.memory?.availableMiB ?? "—"} MiB available`)}
            ${metric("Data volume", system.data ? `${system.data.usedMiB} / ${system.data.totalMiB} MiB` : null, `${system.data?.freeMiB ?? "—"} MiB free`)}
            ${metric("SoC temperature", system.temperatureC == null ? null : `${system.temperatureC} °C`, "thermal_zone0")}
          </dl>
        </section>

        <section class="detail-section">
          <div class="section-title"><h2>Runtime</h2><span>${robot?.latencyMs ?? "—"} ms round trip</span></div>
          <ul class="service-list">
            ${service("Alfred engine", services.engine)}
            ${service("ADB daemon", services.adb)}
            ${service("Medusa", services.medusa)}
            ${service("Deebot", services.deebot)}
            ${service("Wi-Fi daemon", services.wifi)}
          </ul>
          <dl class="metric-list compact">
            ${metric("Transport", network.transport)}
            ${metric("Wi-Fi signal", network.signalDbm == null ? null : `${network.signalDbm} dBm`, network.linkQuality == null ? "" : `link quality ${network.linkQuality}`)}
            ${metric("MAC address", network.mac)}
            ${metric("Root filesystem", system.rootFilesystem)}
            ${metric("Writable runtime", system.writableRuntime)}
          </dl>
        </section>
      </div>
    </div>`, "home");
}

function controlButton(label, symbol, className = "") {
  return `<button class="control ${className}" disabled><span>${symbol}</span><small>${label}</small></button>`;
}

function cockpit(robot) {
  return shell(`
    <header class="topbar"><span>Cockpit</span><div class="top-status"><span class="status-dot ${robot?.online ? "online" : "offline"}"></span>${robot?.online ? "Alfred online" : "Alfred offline"}</div></header>
    <div class="cockpit-content">
      <section class="heading cockpit-heading"><p class="eyebrow">ALFRED / DIRECT CONTROL</p><h1>Cockpit</h1><p>The remote-control workspace. Controls are intentionally inactive until their robot interfaces are verified.</p></section>
      <div class="cockpit-grid">
        <section class="viewport" aria-label="Robot sensors">
          <div class="sensor-grid">
            <section class="sensor-panel camera-panel">
              <div class="viewport-head"><span>Forward camera</span><code id="camera-status">CONNECTING</code></div>
              <div class="sensor-surface camera-surface">
                <canvas id="camera-canvas"></canvas>
                <p id="camera-empty">Waiting for camera pipeline</p>
              </div>
            </section>
            <section class="sensor-panel lidar-panel">
              <div class="viewport-head"><span>LIDAR</span><code id="lidar-status">CONNECTING</code></div>
              <div class="sensor-surface lidar-surface"><canvas id="lidar-canvas"></canvas></div>
            </section>
          </div>
          <div class="viewport-foot"><span>DBX53</span><span>${robot?.network?.address ?? "192.168.1.89"}</span><span>${robot?.system?.temperatureC ?? "—"} °C</span></div>
        </section>
        <aside class="control-deck">
          <div class="deck-title"><h2>Drive</h2><span>Interface pending</span></div>
          <div class="dpad">
            ${controlButton("Forward", "↑", "forward")}
            ${controlButton("Left", "←", "left")}
            ${controlButton("Stop", "■", "stop")}
            ${controlButton("Right", "→", "right")}
            ${controlButton("Reverse", "↓", "reverse")}
          </div>
          <div class="control-readouts">
            <div><span>Linear</span><strong>0.00 m/s</strong></div>
            <div><span>Angular</span><strong>0.00 rad/s</strong></div>
          </div>
          <div class="deck-note"><strong>Next interface</strong><p>Bind verified ROS movement commands, then add hold-to-drive safety and a dead-man stop.</p></div>
        </aside>
      </div>
    </div>`, "cockpit");
}

let robot = null;
let cockpitRun = 0;

function route() {
  const run = ++cockpitRun;
  app.innerHTML = location.pathname === "/cockpit" ? cockpit(robot) : home(robot);
  document.querySelectorAll("[data-route]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    history.pushState({}, "", link.href);
    route();
  }));
  if (location.pathname === "/cockpit") startSensors(run);
}

function prepareCanvas(canvas) {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { context: canvas.getContext("2d"), width, height, ratio };
}

function drawLidar(scan) {
  const canvas = document.querySelector("#lidar-canvas");
  if (!canvas) return;
  const { context, width, height, ratio } = prepareCanvas(canvas);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#e1e4e8";
  context.lineWidth = ratio;
  context.beginPath();
  context.moveTo(width / 2, 0);
  context.lineTo(width / 2, height);
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();

  const points = scan.points ?? [];
  const distances = points.map(({ x, y }) => Math.hypot(x, y)).filter(Number.isFinite).sort((a, b) => a - b);
  const extent = Math.max(distances[Math.floor(distances.length * .96)] ?? 1, 1);
  const scale = Math.min(width, height) * .44 / extent;
  context.fillStyle = "#30343a";
  for (const point of points) {
    const px = width / 2 + point.y * scale;
    const py = height / 2 - point.x * scale;
    if (px < 0 || py < 0 || px > width || py > height) continue;
    context.globalAlpha = Math.max(.22, Math.min(.9, point.power / 700));
    context.fillRect(px, py, Math.max(1.2 * ratio, 1), Math.max(1.2 * ratio, 1));
  }
  context.globalAlpha = 1;
  context.fillStyle = "#5b65d8";
  context.beginPath();
  context.moveTo(width / 2, height / 2 - 7 * ratio);
  context.lineTo(width / 2 - 5 * ratio, height / 2 + 5 * ratio);
  context.lineTo(width / 2 + 5 * ratio, height / 2 + 5 * ratio);
  context.closePath();
  context.fill();
}

async function pollLidar(run) {
  try {
    const response = await fetch("/api/bots/alfred/lidar", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { result } = await response.json();
    if (run !== cockpitRun) return;
    drawLidar(result);
    const status = document.querySelector("#lidar-status");
    const fresh = Date.now() - result.observed_at_unix_ms < 2_000;
    if (status) status.textContent = `${result.source_points ?? 0} PTS · ${fresh ? "LIVE" : "STALE"}`;
  } catch {
    const status = document.querySelector("#lidar-status");
    if (status) status.textContent = "SOURCE OFFLINE";
  }
  if (run === cockpitRun) setTimeout(() => pollLidar(run), 250);
}

async function pollCamera(run) {
  try {
    const response = await fetch("/api/bots/alfred/camera/frame", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const width = Number(response.headers.get("x-frame-width"));
    const height = Number(response.headers.get("x-frame-height"));
    const observedAt = Number(response.headers.get("x-observed-at"));
    const bitmap = await createImageBitmap(await response.blob());
    if (run !== cockpitRun) {
      bitmap.close();
      return;
    }
    const canvas = document.querySelector("#camera-canvas");
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    canvas.classList.add("visible");
    document.querySelector("#camera-empty")?.classList.add("hidden");
    const status = document.querySelector("#camera-status");
    const fresh = Date.now() - observedAt < 2_000;
    if (status) status.textContent = `${width}×${height} · ${fresh ? "LIVE" : "STALE"}`;
  } catch {
    const status = document.querySelector("#camera-status");
    if (status) status.textContent = "SOURCE OFFLINE";
  }
  if (run === cockpitRun) setTimeout(() => pollCamera(run), 650);
}

function startSensors(run) {
  pollLidar(run);
  pollCamera(run);
}

async function refresh() {
  try {
    const response = await fetch("/api/bots", { cache: "no-store" });
    if (!response.ok) throw new Error(`HQ returned ${response.status}`);
    robot = (await response.json()).robots[0];
  } catch (error) {
    robot = { name: "Alfred", model: "Ecovacs T10 Omni DBX53", online: false, observedAt: new Date().toISOString(), error: error.message };
  }
  route();
}

window.addEventListener("popstate", route);
route();
refresh();
setInterval(refresh, 5_000);
