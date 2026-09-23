import { parentPort, workerData } from 'node:worker_threads';
import { locate } from './localization.mjs';
try { parentPort.postMessage({ result: locate(workerData.scan, workerData.checkpoint) }); }
catch(error) { parentPort.postMessage({ error: error.message }); }
