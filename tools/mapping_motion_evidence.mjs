// Require fresh wheel observations spanning a stationary interval, not merely
// a successful stop acknowledgement or repeated copies of one sensor packet.
export function stoppedWindow(frames, minimumSeconds=.4, toleranceMm=2) {
  if(frames.length<2)return false;
  const boot=frames[0].native.boot_id;
  if(!boot)return false;
  const wheels=frames.map(frame=>frame.native.wheels);
  if(frames.some(frame=>frame.native.boot_id!==boot))return false;
  if(wheels.some(w=>!Number.isFinite(w.age_ms)||w.age_ms>300||!Number.isFinite(w.stamp)||w.values.length!==2||w.values.some(v=>!Number.isFinite(v))))return false;
  if(wheels.some((w,i)=>i>0&&w.stamp<=wheels[i-1].stamp))return false;
  if(wheels.at(-1).stamp-wheels[0].stamp<minimumSeconds)return false;
  return [0,1].every(i=>Math.max(...wheels.map(w=>w.values[i]))-Math.min(...wheels.map(w=>w.values[i]))<=toleranceMm);
}
