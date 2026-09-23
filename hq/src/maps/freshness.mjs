// Device monotonic age plus local transport/processing time; never compare
// robot and HQ wall clocks when the device reports sample age.
export function scanAge(scan) {
  if(Number.isFinite(scan?.age_ms)) return scan.age_ms + (Number.isFinite(scan.received_at_unix_ms) ? Math.max(0,Date.now()-scan.received_at_unix_ms) : 0);
  return Number.isFinite(scan?.observed_at_unix_ms) ? Date.now()-scan.observed_at_unix_ms : Infinity;
}
