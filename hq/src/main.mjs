import { startMappingRuntime } from "./maps/runtime.mjs";
import { diagnostic } from "./infra/diagnostics.mjs";
import { EngineClient } from "./bot/engine-client.mjs";
import { RobotStatusService } from "./bot/status-service.mjs";
import { loadConfig } from "./config.mjs";
import { HqServer } from "./http/server.mjs";

const config = await loadConfig();
const engineClient = new EngineClient(config.engineUrl, config.engineToken);
await diagnostic('hq-start', { pid: process.pid });
try { await engineClient.connect(); }
catch (error) { await diagnostic('initial-connection-failed', { error: error.message }); }
const statusService = new RobotStatusService(engineClient, config.robot);
const server = new HqServer(config, statusService, engineClient);

await server.listen();
void startMappingRuntime().catch(error=>diagnostic("mapping-runtime-unavailable",{error:error.message}));
await diagnostic('hq-listening', { port: config.port });
console.log(`HQ listening at http://${config.host}:${config.port}`);
