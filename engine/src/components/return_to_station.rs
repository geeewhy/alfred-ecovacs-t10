//! Engine-owned return operation. No HTTP client, HQ heartbeat or companion dependency.
use super::navigation::{Command, Navigator};
use super::return_geometry::{DockController, Geometry, Pose, ReturnMap, wrap};
use super::{
    bumpers::BumperTelemetry,
    drive::{DriveService, MappingTwist},
    lidar::{LidarScan, LidarTelemetry},
    mapping::NativeMapping,
    power::{BatterySnapshotSource, NativeBatterySnapshot},
};
use serde::{Deserialize, Serialize};
#[derive(Deserialize)]
pub struct NavigationGoal {
    pub map_id: String,
    pub pose: Pose,
}
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, RwLock};
const CONFIG: &str = "/data/alfred/state/return-map.json";
#[derive(Clone, Serialize)]
pub struct ReturnStatus {
    pub active: bool,
    pub state: String,
    pub message: String,
    pub map_id: Option<String>,
    pub pose: Option<Pose>,
    pub score: f64,
    pub retries: u8,
    pub goal: Option<Pose>,
    pub replans: u32,
    pub elapsed_ms: u64,
    pub navigation: serde_json::Value,
}
impl Default for ReturnStatus {
    fn default() -> Self {
        Self {
            active: false,
            state: "idle".into(),
            message: "Engine return idle".into(),
            map_id: None,
            pose: None,
            score: 0.,
            retries: 0,
            goal: None,
            replans: 0,
            elapsed_ms: 0,
            navigation: serde_json::Value::Null,
        }
    }
}
struct Operation {
    status: ReturnStatus,
    started: Instant,
    lost: Option<Instant>,
    lost_reason: String,
    navigator: Navigator,
    detour: bool,
    reseat: bool,
    docking: DockController,
    contact: Option<Instant>,
    progress: Option<(Instant, Pose)>,
    boot: String,
}
impl Operation {
    fn cancel(&mut self) {
        self.status.active = false;
        self.status.state = "stopped".into();
        self.status.message = "Engine return stopped".into();
    }
}
impl Default for Operation {
    fn default() -> Self {
        Self {
            status: ReturnStatus::default(),
            started: Instant::now(),
            lost: None,
            lost_reason: String::new(),
            navigator: Navigator::default(),
            detour: false,
            reseat: false,
            docking: DockController::default(),
            contact: None,
            progress: None,
            boot: String::new(),
        }
    }
}
pub struct ReturnService {
    pub gate: Mutex<()>,
    localization: Arc<super::localization::LocalizationService>,
    operation: Mutex<Operation>,
    geometry: RwLock<Option<Arc<Geometry>>>,
    reflectance: Arc<super::reflectance::ReflectanceService>,
    drive: Arc<DriveService>,
    lidar: Arc<LidarTelemetry>,
    mapping: Arc<NativeMapping>,
    bumpers: Arc<BumperTelemetry>,
    contact: RwLock<Option<(Instant, bool, u8)>>,
}
impl ReturnService {
    pub async fn new(
        drive: Arc<DriveService>,
        lidar: Arc<LidarTelemetry>,
        mapping: Arc<NativeMapping>,
        bumpers: Arc<BumperTelemetry>,
        reflectance: Arc<super::reflectance::ReflectanceService>,
        localization: Arc<super::localization::LocalizationService>,
    ) -> Arc<Self> {
        let geometry = tokio::fs::read(CONFIG)
            .await
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .and_then(|m| Geometry::new(m).ok())
            .map(Arc::new);
        let service = Arc::new(Self {
            localization,
            reflectance,
            gate: Mutex::new(()),
            operation: Mutex::new(Operation::default()),
            geometry: RwLock::new(geometry),
            drive,
            lidar,
            mapping,
            bumpers,
            contact: RwLock::new(None),
        });
        let owner = service.clone();
        tokio::spawn(async move {
            loop {
                if owner.active().await {
                    let began = Instant::now();
                    if let Ok(Ok(b)) = tokio::time::timeout(
                        Duration::from_millis(800),
                        NativeBatterySnapshot::new().read(),
                    )
                    .await
                    {
                        *owner.contact.write().await = Some((began, b.on_charger, b.percent));
                    }
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
        let owner = service.clone();
        tokio::spawn(async move {
            loop {
                let began = Instant::now();
                owner.tick().await;
                tokio::time::sleep(Duration::from_millis(50).saturating_sub(began.elapsed())).await;
            }
        });
        service
    }
    pub async fn active(&self) -> bool {
        self.operation.lock().await.status.active
    }
    pub async fn status(&self) -> ReturnStatus {
        let op = self.operation.lock().await;
        let mut s = op.status.clone();
        s.navigation = op.navigator.summary();
        drop(op);
        s.map_id = self
            .geometry
            .read()
            .await
            .as_ref()
            .map(|g| g.map.map_id.clone());
        s
    }
    // HTTP handlers hold gate for mutations and all external motor commands.
    pub async fn configure(&self, map: ReturnMap) -> Result<(), String> {
        if self.active().await {
            return Err("Stop engine return before replacing its map".into());
        }
        let geometry = Arc::new(Geometry::new(map)?);
        let data = serde_json::to_vec(&geometry.map).map_err(|e| e.to_string())?;
        tokio::fs::create_dir_all("/data/alfred/state")
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(format!("{CONFIG}.new"), data)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::rename(format!("{CONFIG}.new"), CONFIG)
            .await
            .map_err(|e| e.to_string())?;
        self.localization
            .install(super::localization::Config::from_return(&geometry.map))
            .await?;
        *self.geometry.write().await = Some(geometry);
        *self.operation.lock().await = Operation::default();
        Ok(())
    }
    pub async fn start(&self) -> Result<(), String> {
        self.start_operation(None).await
    }
    pub async fn navigate(&self, goal: NavigationGoal) -> Result<(), String> {
        if [goal.pose.x, goal.pose.y, goal.pose.theta]
            .iter()
            .any(|v| !v.is_finite())
        {
            return Err("Destination must be finite map coordinates".into());
        }
        let map = self
            .localization
            .navigation_map()
            .await
            .ok_or("Install a navigation map first")?;
        if map.map_id != goal.map_id {
            return Err("Destination belongs to a different map".into());
        }
        self.start_operation(Some((map, goal.pose))).await
    }
    async fn start_operation(&self, destination: Option<(ReturnMap, Pose)>) -> Result<(), String> {
        if self.active().await {
            return Err(
                "A navigation operation is already active; stop it before replacing its goal"
                    .into(),
            );
        }
        if destination.is_none() && self.geometry.read().await.is_none() {
            return Err("Install a return map first".into());
        }
        let goal = destination.as_ref().map(|(_, p)| *p);
        let map = if let Some((map, _)) = destination {
            map
        } else {
            // Keep saved dock calibration, but route on the latest localization grid.
            let saved = serde_json::from_slice::<ReturnMap>(
                &tokio::fs::read(CONFIG).await.map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if let Some(mut current) = self
                .localization
                .navigation_map()
                .await
                .filter(|m| m.map_id == saved.map_id)
            {
                current.station = saved.station;
                current.enclosure = saved.enclosure;
                current
            } else {
                saved
            }
        };
        let location = self.localization.status().await;
        if location.map_id.as_deref() != Some(&map.map_id) {
            self.localization
                .install(super::localization::Config::from_return(&map))
                .await?;
        }
        let reflections = self.reflectance.load(&map.map_id).await?;
        let geometry = if goal.is_some() {
            Geometry::with_navigation_reflections(map, (*reflections).clone())?
        } else {
            Geometry::with_reflections(map, (*reflections).clone())?
        };
        if goal.is_some_and(|p| !geometry.traversable(p)) {
            return Err("Destination does not have room for the robot in the saved map".into());
        }
        *self.geometry.write().await = Some(Arc::new(geometry));
        let native = self.mapping.status().await;
        let work = native.reports["/task/WorkState"]["bytes"]
            .as_array()
            .ok_or("Firmware task state unavailable")?;
        if work.len() < 3 || work[2].as_u64() != Some(0) && work[0].as_u64() != Some(9) {
            return Err("Another firmware task owns motion".into());
        }
        self.drive.stop().await?;
        *self.contact.write().await = None;
        let mut op = Operation::default();
        op.status.active = true;
        op.status.goal = goal;
        op.status.state = "preparing".into();
        op.status.message = "Waking sensors for onboard return".into();
        op.boot = native.boot_id;
        *self.operation.lock().await = op;
        // Fixed local sensor preparation; never launches a cleaning task.
        tokio::spawn(async {
            let _ = tokio::time::timeout(
                Duration::from_secs(5),
                tokio::process::Command::new("python")
                    .arg("/data/alfred/lidar_start.py")
                    .kill_on_drop(true)
                    .output(),
            )
            .await;
        });
        Ok(())
    }
    pub async fn stop(&self) -> Result<(), String> {
        let mut op = self.operation.lock().await;
        op.cancel();
        drop(op);
        self.drive.stop().await.map(|_| ())
    }
    async fn hold(&self, op: &mut Operation, reason: &str) {
        if op.status.message != reason {
            eprintln!(
                "return hold={} phase={} elapsed_ms={} pose={:?}",
                reason, op.status.state, op.status.elapsed_ms, op.status.pose
            );
        }
        if op.lost_reason != reason {
            op.lost = None;
            op.lost_reason = reason.into();
        }
        let since = op.lost.get_or_insert_with(Instant::now);
        op.status.message = reason.into();
        if since.elapsed() > Duration::from_secs(5) {
            op.status.active = false;
            op.status.state = "failed".into();
        }
        let _ = self.drive.stop().await;
    }
    async fn fail(&self, op: &mut Operation, reason: &str) {
        op.status.active = false;
        op.status.state = "failed".into();
        op.status.message = reason.into();
        let _ = self.drive.stop().await;
    }
    async fn tick(&self) {
        let _gate = self.gate.lock().await;
        let mut op = self.operation.lock().await;
        if !op.status.active {
            return;
        }
        op.status.elapsed_ms = op.started.elapsed().as_millis() as u64;
        if op.started.elapsed() > Duration::from_secs(300) {
            self.fail(&mut op, "Engine return timed out").await;
            return;
        }
        let contact = *self.contact.read().await;
        let Some((at, charging, percent)) =
            contact.filter(|(t, _, _)| t.elapsed() < Duration::from_millis(1500))
        else {
            self.hold(&mut op, "Waiting for charging telemetry").await;
            return;
        };
        let _ = at;
        if charging && op.status.goal.is_none() {
            let since = *op.contact.get_or_insert_with(Instant::now);
            let _ = self.drive.stop().await;
            op.status.state = "confirming".into();
            op.status.message = "Confirming charging contact".into();
            if since.elapsed() > Duration::from_secs(1) {
                op.status.active = false;
                op.status.state = "docked".into();
                op.status.message = "Docked; charging confirmed by engine".into()
            }
            return;
        }
        op.contact = None;
        if percent <= 10 {
            self.fail(&mut op, "Battery too low for return").await;
            return;
        }
        let native = self.mapping.status().await;
        let scan = self.lidar.current().await;
        let sensors = self.bumpers.current();
        if native.boot_id != op.boot {
            self.fail(&mut op, "Robot restarted").await;
            return;
        }
        let work = &native.reports["/task/WorkState"]["bytes"];
        if work[2].as_u64() != Some(0) {
            if work[0].as_u64() == Some(9) {
                let _ = self.drive.ensure_awake().await;
                self.hold(&mut op, "Waking robot").await;
            } else {
                self.fail(&mut op, "Firmware task took control").await;
            }
            return;
        }
        if sensors.left == Some(true)
            || sensors.right == Some(true)
            || sensors.cliff_raw.is_some_and(|x| x != 0)
            || sensors.wheel_lift_raw.is_some_and(|x| x != 0)
        {
            self.fail(&mut op, "Contact, cliff or wheel lift").await;
            return;
        }
        if !sensors.fresh
            || sensors.cliff_raw != Some(0)
            || sensors.wheel_lift_raw != Some(0)
            || !native.wheels.age_ms.is_some_and(|x| x < 300)
            || !scan.age_ms.is_some_and(|x| x < 500)
            || native.wheels.values.len() != 2
        {
            self.hold(
                &mut op,
                "Waiting for fresh safety, wheel and LiDAR telemetry",
            )
            .await;
            return;
        }
        let geometry = self.geometry.read().await.clone().unwrap();
        let location = self.localization.status().await;
        if location.map_id.as_deref() != Some(&geometry.map.map_id)
            || location.state != "located"
            || location.pose.is_none()
        {
            op.status.state = "locating".into();
            op.status.pose = None;
            op.status.message = location.message;
            let _ = self.drive.stop().await;
            return;
        }
        op.status.pose = location.pose;
        op.status.score = location.score;
        let pose = op.status.pose.unwrap();
        let station = geometry.map.station;
        let local = station.relative(pose);
        let Some((scan_pose, points)) = self.localization.navigation_scan(&scan).await else {
            self.hold(&mut op, "Waiting for scan motion alignment")
                .await;
            return;
        };
        let points = geometry.obstacle_points(scan_pose, &points);
        op.navigator
            .observe(&geometry, scan_pose, scan.sequence, &points);
        let (phase, v, w) = if op.detour
            && op.status.goal.is_none()
            && local.x < 0.42
            && local.y.abs() < 0.15
            && local.theta.abs() < 0.4
        {
            // Leave the calibrated tight enclosure before asking the room
            // planner for full-footprint clearance. Forward guard still applies.
            ("clearing-entry", 0.10, 0.)
        } else if op.status.goal.is_some()
            || pose.distance(station) > 0.85
            || op.detour
            || !op.navigator.route.is_empty()
        {
            let target = op.status.goal.unwrap_or(Pose {
                x: station.x + 0.55 * station.theta.cos(),
                y: station.y + 0.55 * station.theta.sin(),
                theta: station.theta,
            });
            let now = op.started.elapsed().as_secs_f64();
            let command = op.navigator.command(&geometry, pose, target, now);
            op.status.replans = op.navigator.replans;
            match command {
                Command::Moving(v, w) => (
                    if op.navigator.recovering() {
                        "checking-approach"
                    } else {
                        "navigating"
                    },
                    v,
                    w,
                ),
                Command::Waiting => {
                    op.status.state = "replanning".into();
                    op.status.message =
                        "Searching for a clear route; watching for obstacles to move".into();
                    op.progress = None;
                    op.lost = None;
                    let _ = self.drive.stop().await;
                    return;
                }
                Command::Arrived => {
                    op.detour = false;
                    if op.status.goal.is_some() {
                        let heading = wrap(target.theta - pose.theta);
                        if heading.abs() > 0.15 {
                            ("goal-alignment", 0., (heading * 1.5).clamp(-0.6, 0.6))
                        } else {
                            op.status.active = false;
                            op.status.state = "arrived".into();
                            op.status.message = "Destination reached".into();
                            let _ = self.drive.stop().await;
                            return;
                        }
                    } else {
                        op.docking.command(station, pose, false)
                    }
                }
            }
        } else {
            if local.x < -0.035 && !op.reseat {
                if op.status.retries >= 2 {
                    self.fail(&mut op, "Charging contact not found at saved station")
                        .await;
                    return;
                }
                op.status.retries += 1;
                op.reseat = true;
            }
            if op.reseat && local.x > 0.05 {
                op.reseat = false;
            }
            if local.x < 0.30 && wrap(station.theta - pose.theta).abs() > 0.6 {
                self.fail(
                    &mut op,
                    "Entry angle requires repositioning outside enclosure",
                )
                .await;
                return;
            }
            {
                let reseat = op.reseat;
                op.docking.command(station, pose, reseat)
            }
        };
        if obstruction(&scan, &geometry, pose, v, w, op.status.goal.is_none()) {
            op.navigator.invalidate();
            op.detour = true;
            op.progress = None;
            op.lost = None;
            op.status.state = "replanning".into();
            op.status.message = "Obstacle detected; finding another trajectory".into();
            let _ = self.drive.stop().await;
            return;
        }
        if let Some((at, p)) = op.progress {
            if pose.distance(p) > 0.015 || wrap(pose.theta - p.theta).abs() > 0.06 {
                op.progress = Some((Instant::now(), pose))
            } else if at.elapsed() > Duration::from_secs(10) {
                op.navigator.invalidate();
                op.detour = true;
                op.progress = None;
                op.status.state = "replanning".into();
                op.status.message = "Progress stalled; replanning approach".into();
                let _ = self.drive.stop().await;
                return;
            }
        } else {
            op.progress = Some((Instant::now(), pose))
        }
        if op.status.state != phase {
            eprintln!(
                "return phase={} elapsed_ms={} local=({:.3},{:.3},{:.3}) velocity=({:.3},{:.3}) score={:.3}",
                phase, op.status.elapsed_ms, local.x, local.y, local.theta, v, w, op.status.score
            );
        }
        op.status.state = phase.into();
        op.status.message = match phase {
            "navigating" => "Following route around observed obstacles",
            "checking-approach" => "Moving to another clear approach to reassess the route",
            "goal-alignment" => "Aligning at destination",
            "entering" => "Backing into station",
            "rear-alignment" => "Aligning rear with station",
            "staging" => "Positioning in front of station",
            "clearing-entry" => "Clearing dock entrance before realigning",
            "reseating" => "Clearing contacts for another entry",
            _ => phase,
        }
        .into();
        match self
            .drive
            .mapping_twist(MappingTwist {
                linear_mm_s: (v * 1000.) as f32,
                angular_rad_s: w as f32,
                wheel_separation_mm: 243.,
            })
            .await
        {
            Ok(_) => op.lost = None,
            Err(e) => self.hold(&mut op, &e).await,
        }
    }
}
#[cfg(test)]
fn obstructed(scan: &LidarScan, g: &Geometry, pose: Pose, v: f64, w: f64) -> bool {
    obstruction(scan, g, pose, v, w, true)
}
fn obstruction(scan: &LidarScan, g: &Geometry, pose: Pose, v: f64, w: f64, docking: bool) -> bool {
    let station = g.map.station;
    let local = station.relative(pose);
    let mut hits = 0;
    let target = pose.relative(station);
    let (s, c) = target.theta.sin_cos();
    for p in &scan.points {
        if p.power <= 0. {
            continue;
        }
        let x = p.x as f64 / 1000.;
        let y = p.y as f64 / 1000.;
        let r = x.hypot(y);
        if r < 0.06 {
            continue;
        }
        if v == 0. && w.abs() > 0.05 {
            if r < 0.18 {
                hits += 1
            }
        } else {
            let forward = if v > 0. { x } else { -x };
            if y.abs() >= 0.18
                || forward <= 0.06
                || forward > (0.18f64.powi(2) - y * y).sqrt() + 0.04
            {
                continue;
            }
            if docking
                && v < 0.
                && local.x < 0.30
                && g.map.enclosure.iter().any(|q| {
                    (target.x + c * q[0] - s * q[1] - x).hypot(target.y + s * q[0] + c * q[1] - y)
                        < 0.05
                })
            {
                continue;
            }
            hits += 1;
        }
    }
    hits >= 3
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::lidar::LidarPoint;
    fn geometry() -> Geometry {
        Geometry::new(serde_json::from_str(include_str!("../../fixtures/return-map.json")).unwrap())
            .unwrap()
    }
    #[tokio::test]
    async fn cancellation_stops_return_and_restart_is_idle() {
        let mut op = Operation::default();
        op.status.active = true;
        op.cancel();
        assert!(!op.status.active);
        assert!(!Operation::default().status.active);
    }
    #[test]
    fn recorded_near_dock_scan_refines_false_obstruction_without_ignoring_objects() {
        let g = geometry();
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/near-dock-scan.json")).unwrap();
        let scan = LidarScan {
            points: fixture["points"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| LidarPoint {
                    x: p["x"].as_f64().unwrap() as f32,
                    y: p["y"].as_f64().unwrap() as f32,
                    power: p["power"].as_f64().unwrap() as f32,
                })
                .collect(),
            ..Default::default()
        };
        let pose = Pose {
            x: 4.592463710906592,
            y: -1.5068052739997815,
            theta: 1.745796326794897,
        };
        assert!(obstructed(&scan, &g, pose, -0.10, 0.));
        let points: Vec<_> = scan
            .points
            .iter()
            .filter(|p| p.power > 0.)
            .map(|p| [p.x as f64 / 1000., p.y as f64 / 1000.])
            .collect();
        let refined = g
            .refine_dock(pose, &points)
            .expect("three dock surfaces support refinement");
        assert!(refined.distance(pose) < 0.06);
        assert!(!obstructed(&scan, &g, refined, -0.10, 0.));
        let mut blocked = scan.clone();
        for i in 0..5 {
            blocked.points.push(LidarPoint {
                x: -190. - i as f32,
                y: 0.,
                power: 1.,
            });
        }
        assert!(obstructed(&blocked, &g, refined, -0.10, 0.));
        assert!(g.refine_dock(pose, &points[..20]).is_none());
    }
    #[test]
    fn enclosure_match_survives_room_map_occlusion() {
        let g = geometry();
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/entry-dock-scan.json")).unwrap();
        let points: Vec<[f64; 2]> = fixture["points"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["power"].as_f64().unwrap() > 0.)
            .map(|p| {
                [
                    p["x"].as_f64().unwrap() / 1000.,
                    p["y"].as_f64().unwrap() / 1000.,
                ]
            })
            .collect();
        let pose = Pose {
            x: 4.626253570115478,
            y: -1.6487978668352223,
            theta: 1.7420344904360765,
        };
        let refined = g
            .refine_dock(pose, &points)
            .expect("dock remains visible with room occluded");
        let mut controller = super::super::return_geometry::DockController::default();
        let (_, linear, _) = controller.command(g.map.station, refined, false);
        assert!(linear < 0., "continue backing toward charging contacts");
    }
    #[test]
    fn unexpected_rear_obstacle_stops_entry() {
        let g = geometry();
        let s = g.map.station;
        let pose = Pose {
            x: s.x + 0.5 * s.theta.cos(),
            y: s.y + 0.5 * s.theta.sin(),
            theta: s.theta,
        };
        let scan = LidarScan {
            points: (0..5)
                .map(|i| LidarPoint {
                    x: -190. - i as f32,
                    y: 0.,
                    power: 1.,
                })
                .collect(),
            ..Default::default()
        };
        assert!(obstructed(&scan, &g, pose, -0.1, 0.));
        assert!(!obstructed(&scan, &g, pose, 0.1, 0.));
    }
    #[test]
    fn dock_sides_do_not_block_centered_reverse() {
        let g = geometry();
        let s = g.map.station;
        let pose = Pose {
            x: s.x + 0.1 * s.theta.cos(),
            y: s.y + 0.1 * s.theta.sin(),
            theta: s.theta,
        };
        let scan = LidarScan {
            points: g
                .map
                .enclosure
                .iter()
                .map(|p| LidarPoint {
                    x: ((p[0] - 0.1) * 1000.) as f32,
                    y: (p[1] * 1000.) as f32,
                    power: 1.,
                })
                .collect(),
            ..Default::default()
        };
        assert!(!obstructed(&scan, &g, pose, -0.1, 0.));
    }
}
