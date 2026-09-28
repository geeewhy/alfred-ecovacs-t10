// Never mix native odometry coordinates with saved-map coordinates.
export function livePosition(id, onboard, navigation) {
  const valid = p => p && ['x','y','theta'].every(k=>Number.isFinite(p[k]));
  if (onboard?.active && onboard.map_id===id) {
    const tracking = ['approaching','rear-alignment','staging','entering','clearing-entry','reseating','confirming'].includes(onboard.state);
    return {pose:tracking && !/waiting|obstruct|stale/i.test(onboard.message || "") && valid(onboard.pose)?onboard.pose:null,message:onboard.message || 'Onboard localization pending'};
  }
  const m = navigation?.mapping;
  if (m?.map_id !== id) return {pose:null,message:'Locate Alfred in this map'};
  const fresh = Number.isFinite(navigation.telemetry?.wheel_age_ms) && navigation.telemetry.wheel_age_ms < 750;
  if (!fresh || !valid(m.pose) || !Number.isFinite(m.pose.age_ms) || m.pose.age_ms > 750 || m.tracking_error || ['locating','failed','cancelled'].includes(m.location?.state)) return {pose:null,message:m.tracking_error || 'Waiting for fresh position'};
  return {pose:m.pose,message:'Live'};
}
