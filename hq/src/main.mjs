import { AdbClient } from "./bot/adb-client.mjs";
import { RobotStatusService } from "./bot/status-service.mjs";
import { loadConfig } from "./config.mjs";
import { HqServer } from "./http/server.mjs";
import { ProcessRunner } from "./infra/process-runner.mjs";

const config = await loadConfig();
const processRunner = new ProcessRunner();
const adbClient = new AdbClient(processRunner, config.robot.adbAddress);
const statusService = new RobotStatusService(adbClient, config.robot);
const server = new HqServer(config, statusService);

await server.listen();
console.log(`HQ listening at http://${config.host}:${config.port}`);
