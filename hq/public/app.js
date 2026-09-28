import { mapsPage, mountMaps } from './maps.js';
let disposeMaps = () => {};
const app = document.querySelector("#app");

const icons = {
  maps: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m3 4 4-1 6 2 4-1v12l-4 1-6-2-4 1Zm4-1v12m6-10v12"/></svg>`,
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
          <a class="nav-item ${active === "maps" ? "active" : ""}" href="/maps" data-route>${icons.maps}<span>Maps</span></a>
          <a class="nav-item ${active === "settings" ? "active" : ""}" href="/settings" data-route>${icons.robot}<span>Settings</span></a>
        </nav>
        <div class="rail-foot"><span class="local-mark"></span><span>Local</span></div>
      </aside>
      <main><div id="mapping-banner" class="mapping-banner" hidden><span id="mapping-banner-text"></span><button id="mapping-banner-stop">Pause exploration</button></div>${content}</main>
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
  return `<button class="control ${className}" data-drive="${className}" type="button"><span>${symbol}</span><small>${label}</small></button>`;
}

function driveSettingsMarkup() { return `    <dialog id="drive-settings" aria-labelledby="settings-title">
      <form id="drive-settings-form">
        <header class="settings-heading"><h2 id="settings-title">Drive settings</h2><button type="button" id="close-drive-settings" class="settings-button" aria-label="Close settings">✕</button></header>
        <p class="settings-description">Set full-throttle speeds. Shift reaches these limits immediately.</p>
        <fieldset id="settings-fields" disabled>
          <label for="max-speed">Maximum speed <span>Forward and reverse</span></label>
          <div class="settings-input"><input id="max-speed" name="max_speed_mm_s" type="number" min="0" step="any" required><span>mm/s</span></div>
          <label for="turn-speed">Turning speed <span>Wheel speed when turning in place</span></label>
          <div class="settings-input"><input id="turn-speed" name="turn_speed_mm_s" type="number" min="0" step="any" required><span>mm/s</span></div>
          <p class="settings-description">Enter positive speeds in mm/s.</p>
        </fieldset>
        <p id="settings-message" role="status" aria-live="polite">Loading settings…</p>
        <footer class="settings-actions"><button type="button" id="cancel-drive-settings" class="settings-button">Cancel</button><button type="submit" id="save-drive-settings" class="settings-button primary" disabled>Save on robot</button></footer>
      </form>
    </dialog>`; }
function drivePanelMarkup() { return `<div class="deck-title"><h2>Drive</h2><button class="settings-button" id="open-drive-settings" type="button">Settings</button><span id="drive-status">Ready</span></div><div class="dpad">${controlButton("Forward","↑","forward")}${controlButton("Left","←","left")}${controlButton("Stop","■","stop")}${controlButton("Right","→","right")}${controlButton("Reverse","↓","reverse")}</div><div class="control-readouts"><div><span>Throttle</span><strong id="drive-throttle">0%</strong></div><div><span>Wheels L / R</span><strong id="drive-wheels">0 / 0 mm/s</strong></div></div><p class="map-muted">Hold to drive · Arrow keys · Shift for full throttle</p>`; }
function cockpit(robot) {
  return shell(`
    <header class="topbar"><span>Cockpit</span><div class="top-status"><span class="status-dot ${robot?.online ? "online" : "offline"}"></span>${robot?.online ? "Alfred online" : "Alfred offline"}</div></header>
    <div class="cockpit-content">
      <section class="heading cockpit-heading"><p class="eyebrow">ALFRED / DIRECT CONTROL</p><h1>Cockpit</h1></section>
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
              <div class="viewport-head"><span>LIDAR</span><button class="settings-button" id="lidar-wake" type="button" title="Wake Alfred and start LiDAR without driving">Wake LiDAR</button><code id="lidar-status">CONNECTING</code></div>
              <div class="sensor-surface lidar-surface"><canvas id="lidar-canvas"></canvas></div><p id="lidar-wake-message" role="status" aria-live="polite" hidden></p>
            </section>
          </div>
          <div class="bumper-strip" aria-label="Front bumpers" role="status">
            <span>Front bumpers</span><span id="bumper-left" class="bumper-reading" data-state="unknown">Left · Waiting</span><span id="bumper-right" class="bumper-reading" data-state="unknown">Right · Waiting</span><small id="bumper-status">CONNECTING</small>
          </div>
          <div class="viewport-foot"><span>DBX53</span><span>${robot?.network?.address ?? "192.168.1.89"}</span><span>${robot?.system?.temperatureC ?? "—"} °C</span></div>
        </section>
        <aside class="control-deck">
          ${drivePanelMarkup()}
          <form id="speech-form" class="speech-form">
            <div class="chat-controls"><label><input type="checkbox" id="chat-mode"> Chat mode</label><button type="button" class="settings-button" id="chat-history">History</button></div>
            <p id="microphone-status" class="microphone-status" role="status"></p>
            <label for="speech-text" id="speech-label">Text to speech</label>
            <textarea id="speech-text" rows="2" maxlength="1000" required placeholder="How can I help you, my good sir?"></textarea>
            <div class="speech-actions"><a href="/settings" data-route>Voice settings</a><button class="settings-button primary" id="speak-button" type="submit">Speak</button></div>
            <p id="speech-status" role="status"></p>
          </form>
          <div class="deck-note"><strong>Hold to drive</strong><p>Arrows to drive · Shift for full speed · Release to stop.</p></div>
        </aside>
      </div>
    </div>
    <dialog id="alfred-chat" aria-labelledby="chat-title">
      <header class="settings-heading"><h2 id="chat-title">You & Alfred</h2><button class="settings-button" id="close-chat" aria-label="Close conversation">✕</button></header>
      <div class="chat-toolbar"><span id="chat-session-status">Haicue session</span><label><input type="checkbox" id="chat-speaker"> Speaker output</label></div>
      <div id="chat-messages" role="log" aria-live="polite"></div>
      <p id="chat-pending" role="status"></p>
      <form id="chat-compose"><label class="sr-only" for="chat-text">Message Alfred</label><textarea id="chat-text" rows="2" maxlength="1000" placeholder="Ask Alfred…" required></textarea><button id="chat-send" class="settings-button primary">Send</button></form>
    </dialog>
    ${driveSettingsMarkup()}`, "cockpit");
}

function settingsPage() {
  return shell(`<div class="content settings-page"><section class="heading"><p class="eyebrow">ALFRED</p><h1>Settings</h1></section>
    <form id="mapping-settings-form" class="voice-settings-form"><h2>Mapping</h2>
      <label for="mapping-cruise">Cruise speed (mm/s)</label><input id="mapping-cruise" type="number" min="0" step="any" required value="120">
      <label for="mapping-approach">Approach speed (mm/s)</label><input id="mapping-approach" type="number" min="0" step="any" required value="60">
      <p class="settings-description">Slows near edges and turns, then returns to cruise in clear space.</p>
      <button class="settings-button primary" id="save-mapping">Save mapping speeds</button><p id="mapping-settings-status" role="status"></p>
    </form>
    <form id="voice-settings-form" class="voice-settings-form"><h2>Speech</h2>
      <label for="speech-voice">Voice</label><select id="speech-voice" disabled><option>Loading…</option></select>
      <p class="settings-description">Used when Alfred speaks text from Cockpit. Saved on this Mac.</p>
      <button class="settings-button primary" id="save-voice" disabled>Save voice</button>
      <p id="voice-status" role="status"></p>
    </form>
    <form id="agent-settings-form" class="voice-settings-form agent-settings-form"><h2>Haicue</h2>
      <label for="chat-agent">Agent</label><select id="chat-agent" disabled></select>
      <label for="chat-model">Model</label><select id="chat-model" disabled></select>
      <p class="settings-description">Changing agent or model starts a new Alfred session on your next message. Conversation history stays here.</p>
      <button class="settings-button primary" id="save-agent" disabled>Save agent</button><p id="agent-status" role="status">Loading available models…</p>
    </form></div>`, "settings");
}

async function startVoiceSettings() {
  const form = document.querySelector("#voice-settings-form");
  const select = form.querySelector("select");
  const button = form.querySelector("button");
  const status = form.querySelector("#speech-status");
  try {
    const response = await chatFetch("/api/bots/alfred/speech/settings");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    select.replaceChildren(...data.result.voices.map(voice => new Option(voice.label, voice.id)));
    select.value = data.result.voice; select.disabled = false; button.disabled = false;
  } catch (error) { status.textContent = error.message; }
  form.addEventListener("submit", async event => {
    event.preventDefault(); button.disabled = true; status.textContent = "Saving…";
    try {
      const response = await chatFetch("/api/bots/alfred/speech/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice: select.value }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      status.textContent = "Voice saved";
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

async function startAgentSettings() {
  const form = document.querySelector("#agent-settings-form");
  const agent = document.querySelector("#chat-agent"), model = document.querySelector("#chat-model"), button = document.querySelector("#save-agent"), status = document.querySelector("#agent-status");
  let catalog = {};
  function fillModels(selected = "") { model.replaceChildren(new Option("Agent default", ""), ...catalog[agent.value].map(id => new Option(id, id))); model.value = selected; }
  try {
    const [modelsResponse, stateResponse] = await Promise.all([chatFetch("/api/bots/alfred/chat/models"), chatFetch("/api/bots/alfred/chat/settings")]);
    const models = await modelsResponse.json(), state = await stateResponse.json();
    if (!modelsResponse.ok || !stateResponse.ok) throw new Error(models.error || state.error);
    catalog = models.result; agent.replaceChildren(...Object.keys(catalog).map(id => new Option(id === "codex" ? "Codex" : "Claude", id)));
    agent.value = state.result.agent; fillModels(state.result.model);
    agent.disabled = false; model.disabled = false; button.disabled = false; status.textContent = "";
  } catch (error) { status.textContent = error.message; }
  agent.onchange = () => fillModels();
  form.onsubmit = async event => {
    event.preventDefault(); button.disabled = true; status.textContent = "Saving…";
    try { await chatSettings({ agent: agent.value, model: model.value }); status.textContent = "Saved for your next conversation"; }
    catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
}

function startSpeech() {
  const form = document.querySelector("#speech-form");
  const field = form.querySelector("textarea");
  const button = form.querySelector("#speak-button");
  const status = form.querySelector("#speech-status");
  field.addEventListener("focus", () => stopDrive());
  field.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!event.repeat && !button.disabled) form.requestSubmit();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (button.disabled || !field.value.trim()) return;
    button.disabled = true; status.textContent = "Preparing speech…";
    try {
      const response = await chatFetch("/api/bots/alfred/speech", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: field.value }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      status.textContent = data.result.message;
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}

let chatState = { enabled: false, speaker: false, messages: [], pending: null };
let renderedChat = "";
function renderChat() {
  const toggle = document.querySelector("#chat-mode");
  if (!toggle) return;
  toggle.checked = chatState.enabled;
  document.querySelector("#microphone-status").textContent = chatState.enabled ? (((chatState.microphone?.message || "Starting robot microphone…") + (chatState.microphone?.status === "listening" && chatState.microphone?.meter ? ` Audio level: ${chatState.microphone.meter.rmsPeak}.` : "") + (chatState.microphone?.transcription && !chatState.microphone.transcription.text ? " No words recognized in the last audio segment." : "")) + (chatState.microphone?.lastHeard ? ` Last heard: “${chatState.microphone.lastHeard.text}”${chatState.microphone.lastHeard.accepted ? "" : " (uncertain audio, skipped)"}` : "")) : "";
  document.querySelector("#chat-speaker").checked = chatState.speaker;
  document.querySelector("#chat-send").disabled = !chatState.enabled || chatState.sessionStatus !== "ready" || !!chatState.pending;
  document.querySelector("#chat-session-status").textContent = chatState.sessionStatus === "ready" ? `Haicue · ${chatState.agent || "codex"}` : chatState.enabled ? "Connecting Alfred…" : "Haicue · Alfred";
  const pending = chatState.error || chatState.pending?.status || (!chatState.enabled ? "Turn on Chat mode to send messages." : "");
  document.querySelector("#chat-pending").textContent = pending;
  const signature = JSON.stringify(chatState.messages);
  if (signature === renderedChat) return;
  renderedChat = signature;
  const log = document.querySelector("#chat-messages");
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.replaceChildren();
  if (!chatState.messages.length) { const p = document.createElement("p"); p.className = "chat-empty"; p.textContent = "Your conversation with Alfred will appear here."; log.append(p); }
  for (const message of chatState.messages) {
    const row = document.createElement("article"); row.className = "chat-message " + message.role;
    const label = document.createElement("strong"); label.textContent = message.role === "you" ? "You" : "Alfred";
    const text = document.createElement("p"); text.textContent = message.text;
    const meta = document.createElement("small"); meta.textContent = new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (message.audio === "failed") meta.textContent += " · Speaker failed: " + message.audioError;
    if (message.audio === "sending") meta.textContent += " · Preparing speech";
    if (message.audio === "sent") meta.textContent += " · Sent to speaker";
    row.append(label, text, meta); log.append(row);
  }
  if (nearBottom) log.scrollTop = log.scrollHeight;
}
async function chatSettings(change) {
  const response = await chatFetch("/api/bots/alfred/chat/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error);
  chatState = data.result; renderChat();
}
function startChat(run) {
  renderedChat = "";
  const dialog = document.querySelector("#alfred-chat");
  document.querySelector("#chat-history").onclick = () => { stopDrive(); dialog.showModal(); document.querySelector("#chat-text").focus(); };
  document.querySelector("#close-chat").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { stopDrive(); document.querySelector("#chat-history").focus(); });
  for (const [id, key] of [["chat-mode", "enabled"], ["chat-speaker", "speaker"]]) {
    document.getElementById(id).onchange = async event => {
      const field = event.target; field.disabled = true; stopDrive();
      try { await chatSettings({ [key]: field.checked }); }
      catch (error) { renderChat(); document.querySelector("#microphone-status").textContent = error.message; }
      finally { field.disabled = false; }
    };
  }
  const form = document.querySelector("#chat-compose"); const field = form.querySelector("textarea");
  field.onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!event.repeat && !document.querySelector("#chat-send").disabled) form.requestSubmit(); } };
  form.onsubmit = async event => {
    event.preventDefault(); if (!field.value.trim() || chatState.pending) return;
    document.querySelector("#chat-send").disabled = true;
    try {
      const response = await chatFetch("/api/bots/alfred/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: field.value }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      field.value = ""; chatState = data.result; renderChat();
    } catch (error) { document.querySelector("#chat-pending").textContent = error.message; document.querySelector("#chat-send").disabled = false; }
  };
  async function poll() {
    try {
      const response = await chatFetch("/api/bots/alfred/chat", { cache: "no-store", signal: AbortSignal.timeout(3000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      if (run !== cockpitRun) return;
      chatState = data.result; renderChat();
    } catch (error) { if (run === cockpitRun) document.querySelector("#microphone-status").textContent = "Chat unavailable: " + error.message; }
    if (run === cockpitRun) setTimeout(poll, 1000);
  }
  poll();
}

let robot = null;
let cockpitRun = 0;
const driveKeys = new Set();
const drivePointers = new Map();
let driveStartedAt = 0;
let driveTimer = null;
let pendingDriveStop = Promise.resolve();
let lastDriveVector = { linear: 0, angular: 0 };
let driveEpoch = 0;

function route() {
  disposeMaps();
  stopDrive();
  const run = ++cockpitRun;
  document.body.classList.toggle("cockpit-mode", location.pathname === "/cockpit");
  document.body.classList.toggle("maps-mode", location.pathname === "/maps");
  app.innerHTML = location.pathname === "/maps" ? shell(mapsPage(drivePanelMarkup(), driveSettingsMarkup()), "maps") : location.pathname === "/cockpit" ? cockpit(robot) : location.pathname === "/settings" ? settingsPage() : home(robot);
  document.querySelectorAll("[data-route]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    history.pushState({}, "", link.href);
    route();
  }));
  if (location.pathname === "/cockpit") {
    startSensors(run);
    startLidarWake();
    startControls();
    startDriveSettings();
    startSpeech();
    startChat(run);
  }
  const mappingStop=document.querySelector('#mapping-banner-stop');
  if(mappingStop)mappingStop.onclick=()=>fetch('/api/maps/active/pause',{method:'POST',signal:AbortSignal.timeout(5000)}).then(refreshMappingBanner);
  refreshMappingBanner();
  if (location.pathname === "/maps") { startControls(); startDriveSettings(); disposeMaps = mountMaps({stopDrive:(force=false)=>stopDrive(false,force)}); }
  if (location.pathname === "/settings") { startVoiceSettings(); startAgentSettings(); startMappingSettings(); }
}

function activeDirections() {
  return new Set([...driveKeys, ...drivePointers.values()]);
}

function driveVector() {
  const active = activeDirections();
  const vertical = Number(active.has("forward")) - Number(active.has("reverse"));
  const horizontal = Number(active.has("right")) - Number(active.has("left"));
  if (!vertical && !horizontal) return { linear: 0, angular: 0, throttle: 0 };
  const heldMs = driveStartedAt ? performance.now() - driveStartedAt : 0;
  const ramp = Math.min(1, .12 + heldMs / 1_800);
  const throttle = driveKeys.has("boost") ? 1 : ramp;
  return { linear: vertical * throttle, angular: horizontal * throttle, throttle };
}

function renderDrive(state = null) {
  const vector = driveVector();
  document.querySelectorAll("[data-drive]").forEach((button) => {
    button.classList.toggle("active", activeDirections().has(button.dataset.drive));
  });
  const throttle = document.querySelector("#drive-throttle");
  if (throttle) throttle.textContent = `${Math.round(vector.throttle * 100)}%${driveKeys.has("boost") ? " · BOOST" : ""}`;
  const wheels = document.querySelector("#drive-wheels");
  if (wheels && state) wheels.textContent = `${Math.round(state.left_mm_s)} / ${Math.round(state.right_mm_s)} mm/s`;
}

async function sendDrive() {
  const epoch = driveEpoch;
  const vector = driveVector();
  lastDriveVector = vector;
  renderDrive();
  try {
    const response = await fetch("/api/bots/alfred/drive", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linear: vector.linear, angular: vector.angular }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error ?? result.message ?? `HTTP ${response.status}`);
    }
    const { result } = await response.json();
    if (epoch !== driveEpoch) return;
    renderDrive(result);
    const status = document.querySelector("#drive-status");
    if (status) status.textContent = result.active ? "Driving" : "Ready";
  } catch (error) {
    const status = document.querySelector("#drive-status");
    if (status && epoch === driveEpoch) status.textContent = error.message;
  }
}

function ensureDriveTimer() {
  const directions = activeDirections();
  const active = ["forward", "reverse", "left", "right"].some((direction) => directions.has(direction));
  if (active && !driveStartedAt) driveStartedAt = performance.now();
  if (active) {
    // Every key/pointer transition sends the combined held state immediately.
    driveEpoch += 1;
    sendDrive();
    if (!driveTimer) driveTimer = setInterval(sendDrive, 100);
  } else {
    stopDrive(directions.has("boost"));
  }
}

function stopDrive(preserveBoost = false, force = false) {
  const shouldNotify = driveTimer || lastDriveVector.linear !== 0 || lastDriveVector.angular !== 0;
  const boostHeld = preserveBoost && driveKeys.has("boost");
  driveEpoch += 1;
  driveKeys.clear();
  if (boostHeld) driveKeys.add("boost");
  drivePointers.clear();
  driveStartedAt = 0;
  if (driveTimer) clearInterval(driveTimer);
  driveTimer = null;
  lastDriveVector = { linear: 0, angular: 0 };
  renderDrive({ left_mm_s: 0, right_mm_s: 0 });
  const status = document.querySelector("#drive-status");
  if (status) status.textContent = "Stopped";
  if (shouldNotify || force) {
    pendingDriveStop = fetch("/api/bots/alfred/drive/stop", { method: "POST", keepalive: true }).then(response=>{if(!response.ok)throw Error("Could not stop previous movement");});
    pendingDriveStop.catch(()=>{});
  }
  return pendingDriveStop;
}

function startDriveSettings() {
  const dialog = document.querySelector("#drive-settings");
  const form = document.querySelector("#drive-settings-form");
  const fields = document.querySelector("#settings-fields");
  const save = document.querySelector("#save-drive-settings");
  const message = document.querySelector("#settings-message");
  const max = document.querySelector("#max-speed");
  const turn = document.querySelector("#turn-speed");
  let busy = false;
  const close = () => { if (!busy) dialog.close(); };
  document.querySelector("#close-drive-settings").onclick = close;
  document.querySelector("#cancel-drive-settings").onclick = close;
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => { stopDrive(); document.querySelector("#open-drive-settings")?.focus(); });

  document.querySelector("#open-drive-settings").onclick = async () => {
    stopDrive();
    fields.disabled = true; save.disabled = true;
    message.textContent = "Loading settings…";
    dialog.showModal();
    try {
      const response = await fetch("/api/bots/alfred/drive/settings", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || data.result || "Cannot load settings");
      if (!dialog.open || !dialog.isConnected) return;
      max.value = data.result.max_speed_mm_s;
      turn.value = data.result.turn_speed_mm_s;
      fields.disabled = false; save.disabled = false;
      message.textContent = "Saved on the robot, including after restart.";
      max.focus();
    } catch (error) { message.textContent = error.message; }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    if (Number(max.value) <= 0 || Number(turn.value) <= 0) { message.textContent = "Speeds must be greater than zero."; return; }
    busy = true; save.disabled = true; fields.disabled = true;
    message.textContent = "Saving…";
    try {
      const response = await fetch("/api/bots/alfred/drive/settings", {
        method: "PUT", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ max_speed_mm_s: Number(max.value), turn_speed_mm_s: Number(turn.value) }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || data.result || "Cannot save settings");
      dialog.close();
      document.querySelector("#drive-status").textContent = `Max ${data.result.max_speed_mm_s} mm/s`;
    } catch (error) { message.textContent = error.message; }
    finally { busy = false; save.disabled = false; fields.disabled = false; }
  });
}

function startControls() {
  document.querySelectorAll("[data-drive]").forEach((button) => {
    const direction = button.dataset.drive;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (!manualControlsAvailable()) return;
      if (direction === "stop") return stopDrive(false, true);
      button.setPointerCapture(event.pointerId);
      drivePointers.set(event.pointerId, direction);
      ensureDriveTimer();
    });
    const release = (event) => {
      if (!drivePointers.delete(event.pointerId)) return;
      ensureDriveTimer();
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  });
}

function manualControlsAvailable() {
  return location.pathname === "/cockpit" || (location.pathname === "/maps" && document.querySelector("#map-manual-controls")?.hidden === false);
}
const keyDirections = { ArrowUp: "forward", ArrowDown: "reverse", ArrowLeft: "left", ArrowRight: "right" };
window.addEventListener("keydown", (event) => {
  if (!manualControlsAvailable() || document.querySelector("dialog[open]") || event.target.closest("input, textarea, select, [contenteditable]")) return;
  const direction = event.key === "Shift" ? "boost" : keyDirections[event.key];
  if (!direction) return;
  event.preventDefault();
  if (driveKeys.has(direction)) return;
  driveKeys.add(direction);
  ensureDriveTimer();
});
window.addEventListener("keyup", (event) => {
  const direction = event.key === "Shift" ? "boost" : keyDirections[event.key];
  if (!direction || !driveKeys.delete(direction)) return;
  event.preventDefault();
  ensureDriveTimer();
});
window.addEventListener("blur", () => stopDrive());
window.addEventListener("pagehide", () => stopDrive());
document.addEventListener("visibilitychange", () => { if (document.hidden) stopDrive(); });

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
    const response = await fetch("/api/bots/alfred/lidar", { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { result } = await response.json();
    if (run !== cockpitRun) return;
    drawLidar(result);
    const status = document.querySelector("#lidar-status");
    const fresh = (Number.isFinite(result.age_ms) ? result.age_ms : Date.now() - result.observed_at_unix_ms) < 2_000;
    if (status) status.textContent = `${result.source_points ?? 0} PTS · ${fresh ? "LIVE" : "STALE"}`;
  } catch {
    const status = document.querySelector("#lidar-status");
    if (status) status.textContent = "SOURCE OFFLINE";
  }
  if (run === cockpitRun) setTimeout(() => pollLidar(run), 250);
}

async function pollCamera(run) {
  try {
    const response = await fetch("/api/bots/alfred/camera/frame", { cache: "no-store", signal: AbortSignal.timeout(5000) });
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
  pollBumpers(run);
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
  if (location.pathname === "/maps" && document.querySelector(".maps-page")) return;
  if (location.pathname === "/settings" && document.querySelector(".settings-page")) return;
  if (location.pathname !== "/cockpit" || !document.querySelector(".cockpit-grid")) route();
  else {
    const status = document.querySelector(".top-status");
    if (status) status.innerHTML = `<span class="status-dot ${robot?.online ? "online" : "offline"}"></span>${robot?.online ? "Alfred online" : "Alfred offline"}`;
  }
}

window.addEventListener("popstate", route);
route();
refresh();
setInterval(refresh, 5_000);

function chatFetch(url, options = {}) {
  return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(15000) });
}

async function pollBumpers(run) {
  if (run !== cockpitRun) return;
  let state;
  try {
    const response = await fetch("/api/bots/alfred/bumpers", { cache: "no-store", signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state = (await response.json()).result;
  } catch { state = null; }
  if (run !== cockpitRun) return;
  for (const side of ["left", "right"]) {
    const element = document.querySelector(`#bumper-${side}`);
    if (!element) return;
    const known = state?.fresh && typeof state[side] === "boolean";
    element.dataset.state = known ? (state[side] ? "pressed" : "clear") : "unknown";
    element.textContent = `${side === "left" ? "Left" : "Right"} · ${known ? (state[side] ? "Pressed" : "Clear") : "Unknown"}`;
  }
  document.querySelector("#bumper-status").textContent = !state ? "OFFLINE" : state.fresh ? "LIVE" : "STALE";
  setTimeout(() => pollBumpers(run), 250);
}

async function refreshMappingBanner(){
 try{const response=await fetch('/api/maps/active',{signal:AbortSignal.timeout(2000)}),{result}=await response.json();const banner=document.querySelector('#mapping-banner');if(!banner)return;banner.hidden=!(result?.mode==='explore'&&result.state==='scanning');if(!banner.hidden)document.querySelector('#mapping-banner-text').textContent='Alfred is mapping · '+(result.message||'Exploring');}catch{}
}
setInterval(refreshMappingBanner,1000);

async function startMappingSettings(){
 const form=document.querySelector('#mapping-settings-form'),status=document.querySelector('#mapping-settings-status'),cruise=document.querySelector('#mapping-cruise'),approach=document.querySelector('#mapping-approach');
 const call=async(body)=>{const r=await fetch('/api/maps/settings',{method:body?'PUT':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});const d=await r.json();if(!d.ok)throw Error(d.error);return d.result;};
 try{const value=await call();cruise.value=value.cruise_mm_s;approach.value=value.approach_mm_s;}catch(e){status.textContent=e.message;}
 form.onsubmit=async(e)=>{e.preventDefault();const button=document.querySelector('#save-mapping');button.disabled=true;try{await call({cruise_mm_s:Number(cruise.value),approach_mm_s:Number(approach.value)});status.textContent='Mapping speeds saved.';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
}

function startLidarWake() {
 const button=document.querySelector('#lidar-wake'),message=document.querySelector('#lidar-wake-message');
 button.onclick=async()=>{
  button.disabled=true;button.textContent='Waking…';message.hidden=false;message.textContent='Waking Alfred and LiDAR…';
  try {
   const response=await fetch('/api/bots/alfred/lidar/wake',{method:'POST',signal:AbortSignal.timeout(20000)});
   const value=await response.json();if(!response.ok || !value.ok)throw Error(value.error||value.result||'Wake failed');
   message.textContent='LiDAR awake. Ready for manual control.';
  } catch(error) { message.textContent='Could not wake LiDAR: '+error.message; }
  finally {button.disabled=false;button.textContent='Wake LiDAR';}
 };
}
