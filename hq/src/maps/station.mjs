// A charging signal establishes docking, never a location in an unrelated map.
export function stationObservation(dock,pose,localization,now=Date.now()) {
 if(!dock?.docked || !Number.isFinite(dock.observedAt) || now-dock.observedAt>5000 || dock.observedAt>now+1000)throw Error('Fresh charging contact is required to mark the station.');
 if(!['located','tracking'].includes(localization) || !pose || !['x','y','theta'].every(k=>Number.isFinite(pose[k])))throw Error('Verify Alfred’s position in this map before marking the station.');
 return {x:pose.x,y:pose.y,theta:pose.theta,observedAt:dock.observedAt,source:'docked-robot-pose',label:'Station'};
}

// A station is a saved map landmark. Locating the robot must not relocate it.
// Replacing an existing landmark requires the explicit Locate station action.
export function retainStation(saved, observation, explicitlyRequested=false) {
 return saved && !explicitlyRequested ? saved : observation;
}
