import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const root=fileURLToPath(new URL('../../../',import.meta.url));

// Start the installed companion when HQ starts. Building/installing remains a
// setup operation; a missing Docker runtime must never prevent Cockpit opening.
export async function startMappingRuntime() {
  const response=await fetch('http://127.0.0.1:48766/status',{signal:AbortSignal.timeout(800)}).catch(()=>null);
  if(response?.ok)return;
  try {
    await run('docker',['compose','-f','mapping/compose.yaml','up','-d','--no-build','--pull','never'],{cwd:root,timeout:10000,maxBuffer:32*1024});
  } catch {
    throw Error('Mapping companion unavailable. Start Docker, then run python3 setup/mapping.py --build once and --start.');
  }
}
