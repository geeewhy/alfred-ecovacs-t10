// Never mix native odometry coordinates with saved-map coordinates.
export function livePosition(id, onboard, navigation, localization) {
  const valid = p => p && ['x','y','theta'].every(k=>Number.isFinite(p[k]));
  if (onboard?.active && onboard.map_id===id) {
    const tracking = ['navigating','checking-approach','replanning','goal-alignment','approaching','rear-alignment','staging','entering','clearing-entry','reseating','confirming'].includes(onboard.state);
    return {pose:tracking && !/waiting|obstruct|stale/i.test(onboard.message || "") && valid(onboard.pose)?onboard.pose:null,message:onboard.message || 'Onboard localization pending'};
  }
  if(localization!==undefined){
    const located=localization?.map_id===id && localization.state==="located" && Number.isFinite(localization.age_ms) && localization.age_ms<1500 && valid(localization.pose);
    return {pose:located?{...localization.pose,age_ms:localization.age_ms}:null,message:located?"Engine tracking":localization?.message || "Engine position unavailable"};
  }
  const m = navigation?.mapping;
  if (m?.map_id !== id) return {pose:null,message:'Locate Alfred in this map'};
  const fresh = Number.isFinite(navigation.telemetry?.wheel_age_ms) && navigation.telemetry.wheel_age_ms < 750;
  if (!fresh || !valid(m.pose) || !Number.isFinite(m.pose.age_ms) || m.pose.age_ms > 750 || m.tracking_error || ['locating','failed','cancelled'].includes(m.location?.state)) return {pose:null,message:m.tracking_error || 'Waiting for fresh position'};
  return {pose:m.pose,message:'Live'};
}
