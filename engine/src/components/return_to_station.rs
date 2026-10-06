use super::{camera::CameraTelemetry, cat_follow};
// Engine-owned return operation. No HTTP client, HQ heartbeat or companion dependency.
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
    pub cat: Option<cat_follow::Status>,
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
            cat: None,
        }
    }
}
struct LocalizationSweep {
    started: Instant,
    wheels: [f32; 2],
    phase: usize,
    settled: Option<Instant>,
}
impl LocalizationSweep {
    fn command(&mut self, wheels: [f32; 2]) -> f64 {
        let yaw = ((wheels[1] - self.wheels[1]) - (wheels[0] - self.wheels[0])) as f64 / 243.;
        let target = [0.45, -0.45, 0.][self.phase.min(2)];
        let error = target - yaw;
        if error.abs() < 0.045 {
            let at = self.settled.get_or_insert_with(Instant::now);
            if at.elapsed() > Duration::from_secs(5) && self.phase < 2 {
                self.phase += 1;
                self.settled = None;
            }
            0.
        } else {
            self.settled = None;
            (error * 1.5).clamp(-0.30, 0.30)
        }
    }
}
// Rotation requires an observed clear circular footprint, independent of the
// uncertain map pose. Existing contact/cliff/lift/freshness checks run first.
fn can_observe_by_turning(scan: &LidarScan) -> bool {
    let mut sectors = [false; 24];
    let mut count = 0;
    for p in &scan.points {
        let r = (p.x as f64).hypot(p.y as f64) / 1000.;
        if p.power <= 0. || r < 0.06 {
            continue;
        }
        if r < 0.205 {
            return false;
        }
        count += 1;
        let angle = (p.y as f64).atan2(p.x as f64) + std::f64::consts::PI;
        sectors[(angle / std::f64::consts::TAU * 24.) as usize % 24] = true;
    }
    count >= 100 && sectors.iter().filter(|s| **s).count() >= 18
}
/// Final contact seating uses measured wheel displacement, not noisy map fits.
/// Bounded ramp-capable rear pulses, a brief release, and a stationary contact
/// dwell. Charging confirmation above this controller stops motion immediately.
struct ContactSeating {
    started: Instant,
    origin: Pose,
    wheels: [f32; 2],
}
impl ContactSeating {
    fn pose(&self, wheels: [f32; 2]) -> Pose {
        let mut pose = self.origin;
        pose.advance(
            (wheels[0] - self.wheels[0]) as f64 / 1000.,
            (wheels[1] - self.wheels[1]) as f64 / 1000.,
        );
        pose
    }
    fn command(&self, wheels: [f32; 2], elapsed: f64) -> Option<(f64, f64)> {
        let left = (wheels[0] - self.wheels[0]) as f64 / 1000.;
        let right = (wheels[1] - self.wheels[1]) as f64 / 1000.;
        let yaw = (right - left) / 0.243;
        let distance = (right + left) / 2.;
        if elapsed >= 12. || distance.abs() > 0.08 || yaw.abs() > 0.12 {
            return None;
        }
        let cycle = (elapsed / 4.).floor() as usize;
        let phase = elapsed % 4.;
        if phase >= 3. {
            return Some((0., 0.));
        }
        if phase >= 2.5 {
            return Some((0.020, 0.));
        }
        if phase % 1.0 >= 0.6 {
            return Some((0., 0.));
        }
        let target = [0.035, -0.035, 0.][cycle.min(2)];
        Some((-0.100, ((target - yaw) * 1.5).clamp(-0.06, 0.06)))
    }
}
fn at_contacts(station: Pose, pose: Pose) -> bool {
    let p = station.relative(pose);
    (-0.10..=0.04).contains(&p.x) && p.y.abs() <= 0.05 && p.theta.abs() <= 0.30
}
struct ContactRecovery {
    started: Instant,
    wheels: [f32; 2],
    turn: f64,
}
impl ContactRecovery {
    fn command(&self, wheels: [f32; 2], elapsed: f64, pressed: bool) -> Option<(f64, f64)> {
        let left = (wheels[0] - self.wheels[0]) as f64 / 1000.;
        let right = (wheels[1] - self.wheels[1]) as f64 / 1000.;
        let distance = ((left + right) / 2.).abs();
        if elapsed >= 2.
            || distance >= 0.12
            || (right - left).abs() / 0.243 >= 0.35
            || (!pressed && distance >= 0.06)
        {
            return None;
        }
        // First unload the bumper straight; then open an angled escape.
        Some((
            -0.10,
            if distance < 0.04 {
                0.
            } else {
                self.turn * 0.25
            },
        ))
    }
}
fn contact_recovery_clear(scan: &LidarScan) -> bool {
    let mut rear = 0;
    for p in &scan.points {
        if p.power <= 0. {
            continue;
        }
        let x = p.x as f64 / 1000.;
        let y = p.y as f64 / 1000.;
        if x.hypot(y) < 0.06 {
            continue;
        }
        if x < 0. {
            rear += 1;
        }
        // Include the swept rear corners during the shallow reverse arc.
        if x < -0.06 && x > -0.30 && y.abs() < 0.23 {
            return false;
        }
    }
    rear >= 20
}
struct Operation {
    cat: Option<cat_follow::Search>,
    status: ReturnStatus,
    started: Instant,
    lost: Option<Instant>,
    lost_reason: String,
    navigator: Navigator,
    detour: bool,
    reseat: bool,
    seating: Option<ContactSeating>,
    docking: DockController,
    contact_recovery: Option<ContactRecovery>,
    contact_attempts: u8,
    departure_anchored: bool,
    departing: bool,
    contact: Option<Instant>,
    progress: Option<(Instant, Pose)>,
    localization_sweep: Option<LocalizationSweep>,
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
            cat: None,
            status: ReturnStatus::default(),
            started: Instant::now(),
            lost: None,
            lost_reason: String::new(),
            navigator: Navigator::default(),
            detour: false,
            reseat: false,
            seating: None,
            docking: DockController::default(),
            contact_recovery: None,
            contact_attempts: 0,
            departure_anchored: false,
            departing: false,
            contact: None,
            progress: None,
            localization_sweep: None,
            boot: String::new(),
        }
    }
}
pub struct ReturnService {
    camera: Arc<CameraTelemetry>,
    last_cat: RwLock<Option<cat_follow::Sighting>>,
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
        camera: Arc<CameraTelemetry>,
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
            camera,
            last_cat: RwLock::new(
                tokio::fs::read("/data/alfred/state/last-cat.json")
                    .await
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok()),
            ),
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
        s.cat = op.cat.as_ref().map(|c| {
            let mut status = c.status.clone();
            status.active = s.active;
            status
        });
        drop(op);
        if s.cat.is_none() {
            s.cat = Some(cat_follow::Status {
                last_seen: self.last_cat.read().await.clone(),
                ..Default::default()
            });
        }
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
    pub async fn follow_cat(&self, map_id: String) -> Result<(), String> {
        let map = self
            .localization
            .navigation_map()
            .await
            .ok_or("Install a saved map first")?;
        if map.map_id != map_id {
            return Err("Cat search belongs to a different map".into());
        }
        let geometry = Geometry::with_navigation_reflections(
            map.clone(),
            (*self.reflectance.load(&map_id).await?).clone(),
        )?;
        let mut search = cat_follow::Search::new(&geometry);
        search.status.last_seen = self.last_cat.read().await.clone();
        let goal = *search
            .pending
            .first()
            .ok_or("No traversable search cells in this map")?;
        self.start_operation(Some((map, goal))).await?;
        self.operation.lock().await.cat = Some(search);
        self.camera.track(true);
        Ok(())
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
    async fn seat_contacts(
        &self,
        op: &mut Operation,
        scan: &LidarScan,
        geometry: &Geometry,
        wheels: [f32; 2],
    ) {
        let seating = op.seating.as_ref().unwrap();
        let pose = seating.pose(wheels);
        let command = seating.command(wheels, seating.started.elapsed().as_secs_f64());
        let Some((v, w)) = command else {
            op.seating = None;
            if op.status.retries >= 2 {
                self.fail(op, "Charging contact not confirmed after contact seating")
                    .await;
            } else {
                op.status.retries += 1;
                op.reseat = true;
                op.detour = false;
                op.navigator.invalidate();
                let _ = self.drive.stop().await;
            }
            return;
        };
        op.status.state = "seating-contacts".into();
        op.status.message = "Gently seating contacts; waiting for charging".into();
        op.status.pose = Some(pose);
        if (v != 0. || w != 0.) && obstruction(scan, geometry, pose, v, w, true) {
            self.hold(op, "Contact seating blocked by an unexpected obstacle")
                .await;
            return;
        }
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
            Err(e) => self.hold(op, &e).await,
        }
    }
    async fn cat_tick(
        &self,
        op: &mut Operation,
        geometry: &Geometry,
        scan: &LidarScan,
        pose: Pose,
        wheels: [f32; 2],
    ) {
        let now = op.started.elapsed().as_secs_f64();
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let cat = op.cat.as_mut().unwrap();
        let frame = self.camera.vision().await;
        cat.status.camera_age_ms = frame.as_ref().map(|f| wall.saturating_sub(f.stamp));
        if !cat.status.camera_age_ms.is_some_and(|age| age < 700) {
            cat.tracker.reset();
            cat.status.target = None;
            self.hold(op, "Waiting for fresh cat camera frames").await;
            return;
        }
        let frame = frame.unwrap();
        if cat.last_wheels.is_none_or(|previous| (previous[0]-wheels[0]).abs()>1. || (previous[1]-wheels[1]).abs()>1.) {cat.last_motion=now;}
        cat.last_wheels=Some(wheels);
        let target = cat.tracker.update(frame, now - cat.last_motion > 0.45);
        let (phase, v, w) = if let Some(b) = target {
            cat.sighting(&geometry.map.map_id, pose, b, cat.tracker.stamp);
            let seen = cat.status.last_seen.clone().unwrap();
            let save = self.last_cat.read().await.as_ref().is_none_or(|old| {
                seen.observed_at_unix_ms
                    .saturating_sub(old.observed_at_unix_ms)
                    >= 1000
            });
            if save {
                *self.last_cat.write().await = Some(seen.clone());
                tokio::spawn(async move {
                    if let Ok(data) = serde_json::to_vec(&seen) {
                        let path = "/data/alfred/state/last-cat.json";
                        if tokio::fs::write(format!("{path}.new"), data).await.is_ok() {
                            let _ = tokio::fs::rename(format!("{path}.new"), path).await;
                        }
                    }
                });
            }
            cat.last_follow = now;
            cat.settled = None;
            let (v, w) = cat_follow::follow(b);
            ("following-cat", v, w)
        } else {
            cat.status.target = None;
            if now - cat.last_follow < 2. && cat.last_follow > 0. {
                ("reacquiring-cat", 0., 0.)
            } else {
                if cat.goal.is_none() && !cat.next(pose, now) {
                    op.status.active = false;
                    op.status.state = "search-complete".into();
                    op.status.message = format!(
                        "Cat search complete: {} cells checked, {} skipped",
                        cat.status.cells_checked, cat.status.cells_skipped
                    );
                    cat.status.phase = "complete".into();
                    let _ = self.drive.stop().await;
                    return;
                }
                let goal = cat.goal.unwrap();
                op.status.goal = Some(goal);
                if now - cat.cell_started > 90. {
                    cat.status.cells_skipped += 1;
                    cat.goal = None;
                    op.navigator.invalidate();
                    ("searching-cat", 0., 0.)
                } else if pose.distance(goal) < 0.16 {
                    let error = wrap(cat_follow::view_heading(cat.view) - pose.theta);
                    if error.abs() > 0.12 {
                        cat.settled = None;
                        if can_observe_by_turning(scan) {
                            ("looking-for-cat", 0., (error * 1.5).clamp(-0.35, 0.35))
                        } else {
                            cat.status.cells_skipped += 1;
                            cat.goal = None;
                            ("searching-cat", 0., 0.)
                        }
                    } else {
                        let since = *cat.settled.get_or_insert(now);
                        if now - since > 2.5 {
                            cat.view += 1;
                            cat.settled = None;
                            cat.tracker.reset();
                            if cat.view >= 4 {
                                cat.status.cells_checked += 1;
                                cat.goal = None;
                                op.navigator.invalidate();
                            }
                        }
                        ("looking-for-cat", 0., 0.)
                    }
                } else if op.departing {
                    ("searching-cat", 0.05, 0.)
                } else {
                    match op.navigator.command(geometry, pose, goal, now) {
                        Command::Moving(v, w) => ("searching-cat", v, w),
                        _ => ("searching-cat", 0., 0.),
                    }
                }
            }
        };
        let cap = if phase == "following-cat" { 0.20 } else { 0.05 };
        let (v, w) = cat_follow::limit(v, w, cap);
        cat.status.phase = phase.into();
        op.status.state = phase.into();
        op.status.message = match phase {
            "following-cat" => "Following dark moving target",
            "reacquiring-cat" => "Target lost; looking again",
            "looking-for-cat" => "Looking for dark movement",
            _ => "Searching map cells at 50 mm/s",
        }
        .into();
        // A clear mapped footprint and raw scan are required even for visual pursuit.
        let mut projected = pose;
        let mut blocked = false;
        if v != 0. || w != 0. {
            for _ in 0..10 {
                projected.advance((v - w * 0.243 / 2.) * 0.08, (v + w * 0.243 / 2.) * 0.08);
                if !op.departing && !geometry.traversable(projected) {
                    blocked = true;
                    break;
                }
            }
        }
        if phase == "following-cat" && v > 0. && scan.points.iter().filter(|p| p.power > 0. && p.x > 60. && p.x < 550. && p.y.abs() < 220.).count() >= 3 { blocked = true; }
        if blocked || ((v != 0. || w != 0.) && obstruction(scan, geometry, pose, v, w, false)) {
            op.navigator.invalidate();
            op.status.message = "Cat mode waiting for a clear trajectory".into();
            let _ = self.drive.stop().await;
            return;
        }
        if v != 0. || w != 0. {
            cat.last_motion = now;
        }
        op.lost = None;
        if let Err(e) = self
            .drive
            .mapping_twist(MappingTwist {
                linear_mm_s: (v * 1000.) as f32,
                angular_rad_s: w as f32,
                wheel_separation_mm: 243.,
            })
            .await
        {
            self.hold(op, &e).await;
        }
    }
    async fn tick(&self) {
        let _gate = self.gate.lock().await;
        let mut op = self.operation.lock().await;
        if !op.status.active {
            self.camera.track(false);
            return;
        }
        op.status.elapsed_ms = op.started.elapsed().as_millis() as u64;
        if op.started.elapsed() > Duration::from_secs(if op.cat.is_some() { 3600 } else { 300 }) {
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
        if sensors.cliff_raw.is_some_and(|x| x != 0) {
            self.fail(&mut op, "Cliff sensor active; movement stopped")
                .await;
            return;
        }
        if sensors.wheel_lift_raw.is_some_and(|x| x != 0) {
            self.fail(&mut op, "Wheel lift detected; movement stopped")
                .await;
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
        let wheels = [native.wheels.values[0], native.wheels.values[1]];
        let pressed = sensors.left == Some(true) || sensors.right == Some(true);
        if pressed && op.cat.is_some() {
            self.fail(&mut op, "Cat search stopped after contact").await;
            return;
        }
        if pressed || op.contact_recovery.is_some() {
            if op.contact_recovery.is_none() {
                if op.contact_attempts >= 3 {
                    self.fail(&mut op, "Bumper still pressed after three escape attempts")
                        .await;
                    return;
                }
                op.contact_attempts += 1;
                let turn = match (sensors.left, sensors.right) {
                    (Some(true), Some(false)) => -1.,
                    (Some(false), Some(true)) => 1.,
                    _ => {
                        if op.contact_attempts % 2 == 1 {
                            1.
                        } else {
                            -1.
                        }
                    }
                };
                op.contact_recovery = Some(ContactRecovery {
                    started: Instant::now(),
                    wheels,
                    turn,
                });
                op.seating = None;
                let _ = self.drive.stop().await;
            }
            let recovery = op.contact_recovery.as_ref().unwrap();
            let command =
                recovery.command(wheels, recovery.started.elapsed().as_secs_f64(), pressed);
            let Some((v, w)) = command else {
                op.contact_recovery = None;
                op.navigator.invalidate();
                op.progress = None;
                op.lost = None;
                let _ = self.drive.stop().await;
                return;
            };
            if !contact_recovery_clear(&scan) {
                self.hold(&mut op, "Bumper escape waiting for rear clearance")
                    .await;
                return;
            }
            op.status.state = "recovering-contact".into();
            op.status.message = format!(
                "Backing away from bumper contact; attempt {}/3",
                op.contact_attempts
            );
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
                Err(error) => self.hold(&mut op, &error).await,
            }
            return;
        }

        if op.seating.is_some() {
            self.seat_contacts(&mut op, &scan, &geometry, wheels).await;
            return;
        }
        if op.status.goal.is_some() && !op.departure_anchored && charging {
            op.departure_anchored = self
                .localization
                .anchor_charging_station(&geometry.map.map_id)
                .await;
            op.departing = op.departure_anchored;
        }
        let location = self.localization.status().await;
        if location.map_id.as_deref() != Some(&geometry.map.map_id) {
            self.fail(&mut op, "Navigation map does not match localization")
                .await;
            return;
        }
        if location.state != "located" || location.pose.is_none() {
            op.status.state = "locating".into();
            op.status.pose = None;
            let sweep = op
                .localization_sweep
                .get_or_insert_with(|| LocalizationSweep {
                    started: Instant::now(),
                    wheels: [native.wheels.values[0], native.wheels.values[1]],
                    phase: 0,
                    settled: None,
                });
            if sweep.started.elapsed() > Duration::from_secs(40) {
                self.fail(
                    &mut op,
                    "Localization recovery could not verify a position from new views",
                )
                .await;
                return;
            }
            if sweep.started.elapsed() < Duration::from_secs(2) || !can_observe_by_turning(&scan) {
                op.status.message = location.message;
                let _ = self.drive.stop().await;
            } else {
                let w = sweep.command([native.wheels.values[0], native.wheels.values[1]]);
                op.status.message = "Checking position from new viewing angles".into();
                if let Err(e) = self
                    .drive
                    .mapping_twist(MappingTwist {
                        linear_mm_s: 0.,
                        angular_rad_s: w as f32,
                        wheel_separation_mm: 243.,
                    })
                    .await
                {
                    self.hold(&mut op, &e).await;
                }
            }
            return;
        }
        if op.localization_sweep.take().is_some() {
            op.navigator.invalidate();
            op.progress = None;
        }
        op.status.pose = location.pose;
        op.status.score = location.score;
        let pose = op.status.pose.unwrap();
        let station = geometry.map.station;
        let local = station.relative(pose);
        if op.status.goal.is_none() && !op.reseat && at_contacts(station, pose) {
            op.seating = Some(ContactSeating {
                started: Instant::now(),
                origin: pose,
                wheels,
            });
            op.progress = None;
            self.seat_contacts(&mut op, &scan, &geometry, wheels).await;
            return;
        }
        let Some((scan_pose, points, scan_sequence)) =
            self.localization.navigation_scan(&scan).await
        else {
            self.hold(&mut op, "Waiting for scan motion alignment")
                .await;
            return;
        };
        let points = geometry.obstacle_points(scan_pose, &points);
        op.navigator
            .observe(&geometry, scan_pose, scan_sequence, &points);
        if local.x >= 0.42 {
            op.departing = false;
        }
        if op.cat.is_some() {
            self.cat_tick(&mut op, &geometry, &scan, pose, wheels).await;
            return;
        }

        let (phase, v, w) = if (op.departing || (op.detour && op.status.goal.is_none()))
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
            "clearing-entry" => "Clearing dock entrance",
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

#[cfg(test)]
mod observation_tests {
    use super::*;
    #[test]
    fn sweep_uses_encoder_angle_and_stops_at_each_view() {
        let mut sweep = LocalizationSweep {
            started: Instant::now(),
            wheels: [0., 0.],
            phase: 0,
            settled: None,
        };
        assert!(sweep.command([0., 0.]) > 0.);
        assert_eq!(sweep.command([-54.675, 54.675]), 0.);
        sweep.settled = Some(Instant::now() - Duration::from_secs(6));
        assert_eq!(sweep.command([-54.675, 54.675]), 0.);
        assert!(sweep.command([-54.675, 54.675]) < 0.);
    }
    #[test]
    fn observation_turn_requires_clear_footprint_and_scan_coverage() {
        let mut scan = LidarScan {
            points: (0..360)
                .map(|i| {
                    let a = i as f32 * std::f32::consts::TAU / 360.;
                    super::super::lidar::LidarPoint {
                        x: a.cos() * 1000.,
                        y: a.sin() * 1000.,
                        power: 1.,
                    }
                })
                .collect(),
            ..Default::default()
        };
        assert!(can_observe_by_turning(&scan));
        scan.points[0].x = 180.;
        assert!(!can_observe_by_turning(&scan));
        scan.points.truncate(50);
        assert!(!can_observe_by_turning(&scan));
    }
}

#[cfg(test)]
mod seating_tests {
    use super::*;
    #[test]
    fn contact_seating_alternates_gently_and_dwells() {
        let seat = ContactSeating {
            started: Instant::now(),
            origin: Pose::default(),
            wheels: [0., 0.],
        };
        let (v, w) = seat.command([0., 0.], 0.).unwrap();
        assert_eq!(v, -0.100);
        assert_eq!(seat.command([0., 0.], 0.8).unwrap(), (0., 0.));
        assert_eq!(seat.command([0., 0.], 1.0).unwrap().0, -0.100);
        assert!(w > 0. && w <= 0.06);
        assert!(seat.command([0., 0.], 4.).unwrap().1 < 0.);
        assert_eq!(seat.command([0., 0.], 2.7).unwrap(), (0.020, 0.));
        assert_eq!(seat.command([0., 0.], 3.5).unwrap(), (0., 0.));
        assert!(seat.command([0., 0.], 12.).is_none());
        assert!(seat.command([-81., -81.], 1.).is_none());
        assert!(seat.command([-20., 20.], 1.).is_none());
    }
    #[test]
    fn seating_begins_at_contacts_after_ramp_and_requires_alignment() {
        let station = Pose::default();
        for x in [0.04, 0., -0.068] {
            assert!(at_contacts(
                station,
                Pose {
                    x,
                    y: 0.,
                    theta: 0.07
                }
            ));
        }
        for pose in [
            Pose {
                x: 0.20,
                y: 0.,
                theta: 0.,
            },
            Pose {
                x: 0.,
                y: 0.07,
                theta: 0.,
            },
            Pose {
                x: 0.,
                y: 0.,
                theta: 0.4,
            },
        ] {
            assert!(!at_contacts(station, pose));
        }
        let mut controller = DockController::default();
        assert!(
            controller
                .command(
                    station,
                    Pose {
                        x: 0.20,
                        y: 0.,
                        theta: 0.
                    },
                    false
                )
                .1
                <= -0.15,
            "slow seating must not reduce ramp climbing speed"
        );
    }
}

#[cfg(test)]
mod contact_recovery_tests {
    use super::*;
    use crate::components::lidar::LidarPoint;
    #[test]
    fn escape_unloads_then_angles_and_is_bounded() {
        let r = ContactRecovery {
            started: Instant::now(),
            wheels: [0., 0.],
            turn: 1.,
        };
        assert_eq!(r.command([0., 0.], 0., true), Some((-0.10, 0.)));
        assert_eq!(r.command([-50., -50.], 0.5, true), Some((-0.10, 0.25)));
        assert!(r.command([-65., -65.], 0.7, false).is_none());
        assert!(r.command([-121., -121.], 1., true).is_none());
        assert!(r.command([0., 0.], 2., true).is_none());
        assert!(r.command([-110., 0.], 1., true).is_none());
    }
    #[test]
    fn escape_requires_observed_rear_clearance() {
        let mut scan = LidarScan::default();
        assert!(!contact_recovery_clear(&scan));
        scan.points = vec![
            LidarPoint {
                x: -700.,
                y: 0.,
                power: 1.
            };
            30
        ];
        assert!(contact_recovery_clear(&scan));
        scan.points.push(LidarPoint {
            x: -200.,
            y: 210.,
            power: 1.,
        });
        assert!(!contact_recovery_clear(&scan));
    }
}
