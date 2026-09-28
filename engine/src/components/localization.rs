//! Shared saved-map position authority. Sensor-driven; no HQ lease or motor commands.
use super::scan_matcher::{Hypothesis, ScanMatcher, consolidate, unique};
use super::{
    lidar::{LidarScan, LidarTelemetry},
    map_evidence::{EvidenceMap, Reference},
    mapping::NativeMapping,
    reflectance::{Grid, ReflectanceService},
    return_geometry::{Geometry, Pose, ReturnMap, wrap},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
const CONFIG: &str = "/data/alfred/state/localization.json";
#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub map_id: String,
    pub revision: String,
    pub grid: Grid,
    #[serde(default)]
    pub station: Option<Pose>,
    #[serde(default)]
    pub enclosure: Vec<[f64; 2]>,
}
impl Config {
    pub fn from_return(m: &ReturnMap) -> Self {
        Self {
            map_id: m.map_id.clone(),
            revision: "return-map".into(),
            grid: Grid {
                width: m.width,
                height: m.height,
                resolution: m.resolution,
                origin: m.origin,
                cells: m.cells.clone(),
            },
            station: Some(m.station),
            enclosure: m.enclosure.clone(),
        }
    }
    fn geometry(&self) -> Result<Geometry, String> {
        Geometry::localization(ReturnMap {
            map_id: self.map_id.clone(),
            resolution: self.grid.resolution,
            width: self.grid.width,
            height: self.grid.height,
            origin: self.grid.origin,
            cells: self.grid.cells.clone(),
            station: self.station.unwrap_or_default(),
            enclosure: self.enclosure.clone(),
        })
    }
}
#[derive(Clone, Serialize)]
pub struct Status {
    pub map_id: Option<String>,
    pub revision: Option<String>,
    pub state: String,
    pub message: String,
    pub pose: Option<Pose>,
    pub score: f64,
    pub age_ms: Option<u64>,
    pub sequence: u32,
    pub generation: u64,
    pub source_stamp: Option<f64>,
    pub hypotheses: Vec<Hypothesis>,
}
struct Map {
    config: Config,
    geometry: Geometry,
    matcher: ScanMatcher,
    evidence: EvidenceMap,
}
const CONFIRM_SCANS: u8 = 4;
#[derive(Clone, Copy)]
struct MotionPrior {
    pose: Pose,
    travel: f64,
    turn: f64,
}
impl MotionPrior {
    fn new(pose: Pose) -> Self {
        Self {
            pose,
            travel: 0.,
            turn: 0.,
        }
    }
    fn advance(&mut self, left: f64, right: f64) {
        self.pose.advance(left, right);
        self.travel += (left.abs() + right.abs()) / 2.;
        self.turn += ((right - left) / 0.243).abs();
    }
    fn accepts(&self, pose: Pose) -> bool {
        self.pose.distance(pose) <= (0.30 + 0.15 * self.travel).min(0.75)
            && wrap(self.pose.theta - pose.theta).abs() <= (0.30 + 0.10 * self.turn).min(0.70)
    }
}
#[derive(Default)]
struct Consensus {
    winner: Option<Pose>,
    margins: VecDeque<f64>,
}
impl Consensus {
    fn observe(&mut self, modes: &[Hypothesis]) -> Option<Hypothesis> {
        let Some(best) = modes.first().copied().filter(|h| h.agreement >= 0.75) else {
            *self = Self::default();
            return None;
        };
        if !self.winner.is_some_and(|p| {
            p.distance(best.pose) < 0.2 && wrap(p.theta - best.pose.theta).abs() < 0.2
        }) {
            self.margins.clear();
        }
        self.winner = Some(best.pose);
        self.margins.push_back(
            modes
                .get(1)
                .map_or(1., |next| best.likelihood - next.likelihood),
        );
        while self.margins.len() > 8 {
            self.margins.pop_front();
        }
        let n = self.margins.len() as f64;
        let mean = self.margins.iter().sum::<f64>() / n;
        let deviation = (self.margins.iter().map(|m| (m - mean).powi(2)).sum::<f64>() / n).sqrt();
        // No sqrt(n) confidence boost: successive stationary sweeps are correlated.
        if n >= CONFIRM_SCANS as f64 && mean > 0.01 && mean > 2. * deviation {
            Some(best)
        } else {
            None
        }
    }
}
struct State {
    map: Option<Arc<Map>>,
    generation: u64,
    pose: Option<Pose>,
    consensus: Consensus,
    anchor: Option<MotionPrior>,
    score: f64,
    matched: Option<Instant>,
    previous: Option<([f32; 2], f64)>,
    odom: Pose,
    history: VecDeque<(f64, Pose)>,
    sequence: u32,
    message: String,
    confirm: u8,
    boot: String,
    search: Option<tokio::task::JoinHandle<(u64, Pose, Instant, Vec<Hypothesis>)>>,
    last_scan_stamp: Option<f64>,
    last_search: Instant,
    last_global: Instant,
    modes: Vec<Hypothesis>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            last_scan_stamp: None,
            modes: Vec::new(),
            map: None,
            generation: 0,
            pose: None,
            consensus: Consensus::default(),
            anchor: None,
            score: 0.,
            matched: None,
            previous: None,
            odom: Pose::default(),
            history: VecDeque::new(),
            sequence: 0,
            message: "Install a saved map".into(),
            confirm: 0,
            boot: String::new(),
            search: None,
            last_search: Instant::now() - Duration::from_secs(10),
            last_global: Instant::now() - Duration::from_secs(10),
        }
    }
}
pub struct LocalizationService {
    state: Mutex<State>,
    configure_gate: Mutex<()>,
    lidar: Arc<LidarTelemetry>,
    mapping: Arc<NativeMapping>,
    reflectance: Arc<ReflectanceService>,
}
pub fn advance(p: Pose, from: Pose, to: Pose) -> Pose {
    let d = from.relative(to);
    let (s, c) = p.theta.sin_cos();
    Pose {
        x: p.x + c * d.x - s * d.y,
        y: p.y + s * d.x + c * d.y,
        theta: wrap(p.theta + d.theta),
    }
}
fn invalidate(s: &mut State, message: &str) {
    s.generation += 1;
    s.modes.clear();
    s.anchor = None;
    s.consensus = Consensus::default();
    s.pose = None;
    s.matched = None;
    s.confirm = 0;
    s.message = message.into();
    // Keep the in-flight worker until it finishes; generation rejects its result.
    // spawn_blocking cannot be aborted once running. Never spawn overlapping searches.
}
fn accept_match(
    s: &mut State,
    generation: u64,
    at: Pose,
    observed: Instant,
    modes: Vec<Hypothesis>,
) {
    if generation == s.generation {
        s.modes = modes
            .into_iter()
            .map(|mut h| {
                h.pose = advance(h.pose, at, s.odom);
                h
            })
            .filter(|h| s.anchor.is_none_or(|anchor| anchor.accepts(h.pose)))
            .collect();
        let selected = if s.anchor.is_some() && s.confirm >= CONFIRM_SCANS {
            s.consensus = Consensus::default();
            unique(&s.modes)
        } else {
            s.consensus.observe(&s.modes)
        };
        if let Some(best) = selected {
            let updated = best.pose;
            s.confirm = if s.pose.is_some_and(|old| {
                old.distance(updated) < 0.2 && wrap(old.theta - updated.theta).abs() < 0.2
            }) {
                (s.confirm + 1).min(CONFIRM_SCANS)
            } else {
                CONFIRM_SCANS
            };
            s.pose = Some(updated);
            if s.confirm >= CONFIRM_SCANS {
                s.anchor = Some(MotionPrior::new(updated));
            }
            s.score = best.agreement;
            s.matched = Some(observed);
            s.message = "Confirming position with a new scan".into();
        } else {
            s.pose = None;
            s.confirm = 0;
            s.matched = None;
            s.message = if s.modes.is_empty() {
                "Tracking lost; searching saved map"
            } else {
                "Comparing competing locations against new scans"
            }
            .into();
        }
    }
}
impl LocalizationService {
    pub async fn new(
        lidar: Arc<LidarTelemetry>,
        mapping: Arc<NativeMapping>,
        reflectance: Arc<ReflectanceService>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            state: Mutex::new(State::default()),
            configure_gate: Mutex::new(()),
            lidar,
            mapping,
            reflectance,
        });
        if let Ok(bytes) = tokio::fs::read(CONFIG).await {
            if let Ok(c) = serde_json::from_slice(&bytes) {
                let _ = service.install(c).await;
            }
        }
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
    pub async fn install(&self, mut config: Config) -> Result<(), String> {
        let _gate = self.configure_gate.lock().await;
        {
            let s = self.state.lock().await;
            if let Some(m) = &s.map {
                if m.config.map_id == config.map_id {
                    if config.station.is_none() {
                        config.station = m.config.station;
                        config.enclosure = m.config.enclosure.clone();
                    }
                    if serde_json::to_vec(&m.config).ok() == serde_json::to_vec(&config).ok() {
                        return Ok(());
                    }
                }
            }
        }
        let c = config.clone();
        let map = tokio::task::spawn_blocking(move || {
            Ok::<_, String>(Map {
                geometry: c.geometry()?,
                matcher: ScanMatcher::new(c.grid.clone()),
                evidence: EvidenceMap::new(Reference {
                    map_id: c.map_id.clone(),
                    revision: c.revision.clone(),
                    grid: c.grid.clone(),
                })?,
                config: c,
            })
        })
        .await
        .map_err(|e| e.to_string())??;
        tokio::fs::create_dir_all("/data/alfred/state")
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(
            format!("{CONFIG}.new"),
            serde_json::to_vec(&config).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
        tokio::fs::rename(format!("{CONFIG}.new"), CONFIG)
            .await
            .map_err(|e| e.to_string())?;
        let mut s = self.state.lock().await;
        let prior = if s
            .map
            .as_ref()
            .is_some_and(|m| m.config.map_id == config.map_id)
        {
            s.pose
        } else {
            None
        };
        let anchor = if s
            .map
            .as_ref()
            .is_some_and(|m| m.config.map_id == config.map_id)
        {
            s.anchor
        } else {
            None
        };
        invalidate(&mut s, "Checking position against the updated map");
        s.anchor = anchor;
        if let Some(p) = prior {
            s.modes = vec![Hypothesis {
                pose: p,
                likelihood: 0.,
                agreement: 0.,
            }];
        }
        s.map = Some(Arc::new(map));
        s.sequence = 0;
        Ok(())
    }
    pub async fn locate(&self, map_id: &str) -> Result<(), String> {
        let mut s = self.state.lock().await;
        if s.map.as_ref().map(|m| m.config.map_id.as_str()) != Some(map_id) {
            return Err("Install this localization map first".into());
        }
        invalidate(&mut s, "Locating in saved map onboard");
        s.last_search = Instant::now() - Duration::from_secs(10);
        Ok(())
    }
    pub async fn status(&self) -> Status {
        let wheels = self.mapping.status().await.wheels;
        let scan = self.lidar.current().await;
        let s = self.state.lock().await;
        let age = s.matched.map(|t| t.elapsed().as_millis() as u64);
        let fresh = age.is_some_and(|a| a < 1500)
            && wheels.age_ms.is_some_and(|a| a < 500)
            && scan.age_ms.is_some_and(|a| a < 750)
            && s.confirm >= CONFIRM_SCANS;
        Status {
            map_id: s.map.as_ref().map(|m| m.config.map_id.clone()),
            revision: s.map.as_ref().map(|m| m.config.revision.clone()),
            state: if s.map.is_none() {
                "idle"
            } else if fresh {
                "located"
            } else {
                "locating"
            }
            .into(),
            message: if fresh {
                "Position tracked by engine".into()
            } else {
                s.message.clone()
            },
            pose: if fresh { s.pose } else { None },
            score: s.score,
            age_ms: age,
            sequence: s.sequence,
            generation: s.generation,
            source_stamp: s.previous.map(|(_, stamp)| stamp),
            hypotheses: s.modes.clone(),
        }
    }
    async fn tick(&self) {
        let native = self.mapping.status().await;
        let scan = self.lidar.current().await;
        let mut s = self.state.lock().await;
        let Some(map) = s.map.clone() else { return };
        if native.wheels.values.len() != 2 || !native.wheels.age_ms.is_some_and(|a| a < 500) {
            s.message = "Waiting for wheel telemetry".into();
            return;
        }
        let w = [native.wheels.values[0], native.wheels.values[1]];
        let stamp = native.wheels.stamp;
        if s.boot != native.boot_id {
            invalidate(&mut s, "Recovering after robot restart");
            s.previous = None;
            s.history.clear();
            s.boot = native.boot_id;
        }
        if let Some((prev, t)) = s.previous {
            let dl = (w[0] - prev[0]) as f64 / 1000.;
            let dr = (w[1] - prev[1]) as f64 / 1000.;
            if stamp < t || dl.abs() > 0.25 || dr.abs() > 0.25 {
                invalidate(&mut s, "Recovering after wheel discontinuity");
                s.history.clear();
            } else {
                s.odom.advance(dl, dr);
                if let Some(winner) = &mut s.consensus.winner {
                    winner.advance(dl, dr);
                }
                if let Some(anchor) = &mut s.anchor {
                    anchor.advance(dl, dr);
                }
                for h in &mut s.modes {
                    h.pose.advance(dl, dr);
                }
                if let Some(p) = &mut s.pose {
                    p.advance(dl, dr);
                }
            }
        }
        s.previous = Some((w, stamp));
        let odom = s.odom;
        if s.history.back().is_none_or(|(t, _)| *t != stamp) {
            s.history.push_back((stamp, odom));
        }
        while s.history.len() > 100 {
            s.history.pop_front();
        }
        if !scan.age_ms.is_some_and(|a| a < 750) {
            s.message = "Waiting for fresh LiDAR".into();
            return;
        }
        // A completed search is tied to both map generation and scan odometry.
        if s.search.as_ref().is_some_and(|t| t.is_finished()) {
            let task = s.search.take().unwrap();
            if let Ok((generation, at, observed, modes)) = task.await {
                accept_match(&mut s, generation, at, observed, modes);
            }
        }
        if s.search.is_some() || scan.sequence == s.sequence {
            return;
        }
        let Some(at) = interpolate(&s.history, scan.source_stamp) else {
            s.message = "Waiting for time-aligned scan odometry".into();
            return;
        };
        s.sequence = scan.sequence;
        let period = s
            .last_scan_stamp
            .map(|t| (scan.source_stamp - t).clamp(0.1, 0.3))
            .unwrap_or(0.2);
        s.last_scan_stamp = Some(scan.source_stamp);
        let Some(scan) = deskew(&scan, &s.history, period) else {
            return;
        };
        let points = scan_points(&scan);
        if points.len() < 100 {
            s.message = "Waiting for LiDAR coverage".into();
            return;
        }
        let seed = s
            .pose
            .filter(|_| s.confirm >= CONFIRM_SCANS)
            .map(|p| advance(p, s.odom, at));
        let priors: Vec<_> = s
            .modes
            .iter()
            .map(|h| Hypothesis {
                pose: advance(h.pose, s.odom, at),
                ..*h
            })
            .collect();
        let observed = scan.received_at.unwrap_or_else(Instant::now);
        let priors = if let Some(seed) = seed {
            vec![Hypothesis {
                pose: seed,
                likelihood: 0.,
                agreement: 0.,
            }]
        } else {
            priors
        };
        let priors = if priors.is_empty() {
            s.anchor
                .map(|anchor| {
                    vec![Hypothesis {
                        pose: advance(anchor.pose, s.odom, at),
                        likelihood: 0.,
                        agreement: 0.,
                    }]
                })
                .unwrap_or_default()
        } else {
            priors
        };
        let generation = s.generation;
        if priors.is_empty() && s.last_search.elapsed() < Duration::from_secs(1) {
            return;
        }
        let global = priors.is_empty()
            || (seed.is_none() && s.last_global.elapsed() > Duration::from_secs(5));
        if global {
            s.last_global = Instant::now();
        }
        s.last_search = Instant::now();
        let recovery_window = seed.is_none() && s.anchor.is_some();
        let reflections = self.reflectance.load(&map.config.map_id).await.ok();
        s.search = Some(tokio::task::spawn_blocking(move || {
            let mut modes = if global {
                map.matcher.global(&points, &map.evidence)
            } else {
                // Reflection removal is hypothesis-specific. Never erase a beam
                // merely because it disagrees with one candidate location.
                let mut modes = Vec::new();
                for prior in &priors {
                    let filtered: Vec<_> = points
                        .iter()
                        .copied()
                        .filter(|p| {
                            reflections
                                .as_ref()
                                .is_none_or(|r| !r.reflected(prior.pose, *p))
                        })
                        .collect();
                    if filtered.len() >= 100 && filtered.len() * 3 >= points.len() {
                        modes.extend(map.matcher.track_window(
                            &[*prior],
                            &filtered,
                            &map.evidence,
                            recovery_window,
                        ));
                    }
                }
                consolidate(modes)
            };
            if let Some(seed) = seed {
                if map.config.station.is_some() && map.config.enclosure.len() >= 30 {
                    let near: Vec<_> = scan
                        .points
                        .iter()
                        .filter(|p| p.power > 0. && (p.x as f64).hypot(p.y as f64) > 60.)
                        .map(|p| [p.x as f64 / 1000., p.y as f64 / 1000.])
                        .collect();
                    if let Some(p) = map.geometry.refine_dock(seed, &near) {
                        modes = vec![Hypothesis {
                            pose: p,
                            likelihood: 1.,
                            agreement: 1.,
                        }];
                    }
                }
            }
            (generation, at, observed, modes)
        }));
    }
}
fn interpolate(h: &VecDeque<(f64, Pose)>, stamp: f64) -> Option<Pose> {
    if !stamp.is_finite() {
        return None;
    }
    let (first, _) = h.front()?;
    let (last, p) = h.back()?;
    if stamp < *first || stamp > *last + 0.03 {
        return None;
    }
    if stamp >= *last {
        return Some(*p);
    }
    for i in 1..h.len() {
        let (a, p) = h[i - 1];
        let (b, q) = h[i];
        if a <= stamp && stamp <= b {
            let f = (stamp - a) / (b - a);
            return Some(Pose {
                x: p.x + f * (q.x - p.x),
                y: p.y + f * (q.y - p.y),
                theta: wrap(p.theta + f * wrap(q.theta - p.theta)),
            });
        }
    }
    None
}
fn scan_points(scan: &LidarScan) -> Vec<[f64; 2]> {
    let mut bins = [f64::INFINITY; 720];
    for p in &scan.points {
        let x = p.x as f64 / 1000.;
        let y = p.y as f64 / 1000.;
        let d = x.hypot(y);
        if p.power > 0. && d > 0.195 && d < 12. {
            let i = (((y.atan2(x) + std::f64::consts::PI) / std::f64::consts::TAU * 720.).round()
                as usize)
                % 720;
            bins[i] = bins[i].min(d);
        }
    }
    bins.iter()
        .enumerate()
        .filter(|(i, d)| {
            d.is_finite()
                && (-2isize..=2)
                    .filter(|k| {
                        (bins[(*i as isize + k).rem_euclid(720) as usize] - **d).abs() < 0.06
                    })
                    .count()
                    >= 3
        })
        .map(|(i, d)| {
            let a = -std::f64::consts::PI + i as f64 * std::f64::consts::TAU / 720.;
            [d * a.cos(), d * a.sin()]
        })
        .collect()
}

fn deskew(scan: &LidarScan, history: &VecDeque<(f64, Pose)>, period: f64) -> Option<LidarScan> {
    let end = interpolate(history, scan.source_stamp)?;
    interpolate(history, scan.source_stamp - period)?;
    let mut corrected = scan.clone();
    let count = scan.points.len();
    for (i, p) in corrected.points.iter_mut().enumerate() {
        let at = interpolate(
            history,
            scan.source_stamp - period + (i + 1) as f64 / count as f64 * period,
        )?;
        let relative = end.relative(at);
        let (s, c) = relative.theta.sin_cos();
        let x = p.x as f64 / 1000.;
        let y = p.y as f64 / 1000.;
        p.x = ((relative.x + c * x - s * y) * 1000.) as f32;
        p.y = ((relative.y + s * x + c * y) * 1000.) as f32;
    }
    Some(corrected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_match_moves_with_odometry_in_map_frame() {
        let p = Pose {
            x: 5.,
            y: 2.,
            theta: std::f64::consts::FRAC_PI_2,
        };
        let result = advance(
            p,
            Pose::default(),
            Pose {
                x: 0.4,
                y: 0.,
                theta: 0.2,
            },
        );
        assert!((result.x - 5.).abs() < 1e-6);
        assert!((result.y - 2.4).abs() < 1e-6);
        assert!((result.theta - p.theta - 0.2).abs() < 1e-6);
    }
    #[test]
    fn interpolation_rejects_missing_history_and_wraps_heading() {
        let h = VecDeque::from([
            (
                1.,
                Pose {
                    x: 0.,
                    y: 0.,
                    theta: 3.1,
                },
            ),
            (
                2.,
                Pose {
                    x: 1.,
                    y: 0.,
                    theta: -3.1,
                },
            ),
        ]);
        assert!(interpolate(&h, 0.9).is_none());
        assert!(interpolate(&h, 2.1).is_none());
        let p = interpolate(&h, 1.5).unwrap();
        assert!((p.x - 0.5).abs() < 1e-6);
        assert!((p.theta.abs() - std::f64::consts::PI).abs() < 1e-6);
    }
    #[tokio::test]
    async fn reset_invalidates_authority_but_keeps_single_worker_until_completion() {
        let mut s = State::default();
        s.pose = Some(Pose::default());
        s.confirm = 2;
        s.matched = Some(Instant::now());
        s.search = Some(tokio::spawn(async {
            (0, Pose::default(), Instant::now(), vec![])
        }));
        invalidate(&mut s, "reset");
        assert!(s.pose.is_none());
        assert!(s.matched.is_none());
        assert_eq!(s.confirm, 0);
        assert!(s.search.is_some());
        let (generation, _, _, _) = s.search.take().unwrap().await.unwrap();
        assert_ne!(generation, s.generation);
        assert!(State::default().pose.is_none());
    }
    #[test]
    fn deskew_accounts_for_motion_during_sweep() {
        use super::super::lidar::LidarPoint;
        let h = VecDeque::from([
            (1., Pose::default()),
            (
                1.2,
                Pose {
                    x: 0.2,
                    y: 0.,
                    theta: 0.,
                },
            ),
        ]);
        let scan = LidarScan {
            source_stamp: 1.2,
            points: vec![
                LidarPoint {
                    x: 1000.,
                    y: 0.,
                    power: 1.,
                },
                LidarPoint {
                    x: 1000.,
                    y: 0.,
                    power: 1.,
                },
            ],
            ..Default::default()
        };
        let corrected = deskew(&scan, &h, 0.2).unwrap();
        assert!((corrected.points[0].x - 900.).abs() < 0.01);
        assert!((corrected.points[1].x - 1000.).abs() < 0.01);
    }
}

#[cfg(test)]
mod continuity_tests {
    use super::*;
    fn candidate(x: f64, score: f64) -> Hypothesis {
        Hypothesis {
            pose: Pose {
                x,
                y: 1.,
                theta: 0.,
            },
            likelihood: score,
            agreement: 0.9,
        }
    }
    fn update(s: &mut State, modes: Vec<Hypothesis>) {
        accept_match(s, s.generation, s.odom, Instant::now(), modes);
    }
    #[test]
    fn one_promising_scan_does_not_eliminate_the_competing_location() {
        let mut s = State::default();
        update(&mut s, vec![candidate(1., 0.9), candidate(8., 0.84)]);
        assert_eq!(s.confirm, 0);
        assert_eq!(s.modes.len(), 2);
        assert!(s.anchor.is_none());
        update(&mut s, vec![candidate(8., 0.9), candidate(1., 0.87)]);
        assert_eq!(s.confirm, 0);
        assert!(s.pose.is_none());
        assert!(s.anchor.is_none());
    }
    #[test]
    fn lost_scan_cannot_teleport_verified_position_to_another_room() {
        let mut s = State::default();
        for _ in 0..CONFIRM_SCANS {
            update(&mut s, vec![candidate(1., 0.9), candidate(8., 0.8)]);
        }
        assert!(s.anchor.is_some());
        update(&mut s, vec![]);
        assert!(s.pose.is_none());
        assert!(s.anchor.is_some());
        for _ in 0..10 {
            update(&mut s, vec![candidate(8., 0.99)]);
        }
        assert!(s.pose.is_none());
        assert_eq!(s.confirm, 0);
        for _ in 0..CONFIRM_SCANS {
            update(&mut s, vec![candidate(1.1, 0.85)]);
        }
        assert_eq!(s.confirm, CONFIRM_SCANS);
        assert!((s.pose.unwrap().x - 1.1).abs() < 1e-6);
    }
    #[test]
    fn recovery_prior_moves_with_wheels_and_explicit_locate_can_reset_it() {
        let mut s = State::default();
        s.anchor = Some(MotionPrior::new(candidate(1., 0.9).pose));
        s.anchor.as_mut().unwrap().advance(1., 1.);
        assert!(s.anchor.unwrap().accepts(candidate(2.1, 0.8).pose));
        assert!(!s.anchor.unwrap().accepts(candidate(8., 0.99).pose));
        invalidate(&mut s, "explicit Locate");
        assert!(s.anchor.is_none());
        for _ in 0..CONFIRM_SCANS {
            update(&mut s, vec![candidate(8., 0.99)]);
        }
        assert_eq!(s.confirm, CONFIRM_SCANS);
    }
}

#[cfg(test)]
mod consensus_tests {
    use super::*;
    fn hypotheses(x: f64, gap: f64) -> Vec<Hypothesis> {
        vec![
            Hypothesis {
                pose: Pose {
                    x,
                    y: 0.,
                    theta: 0.,
                },
                likelihood: 0.7,
                agreement: 0.85,
            },
            Hypothesis {
                pose: Pose {
                    x: 10. - x,
                    y: 0.,
                    theta: 0.,
                },
                likelihood: 0.7 - gap,
                agreement: 0.86,
            },
        ]
    }
    #[test]
    fn persistent_lead_exceeding_scan_noise_can_resolve_without_fixed_large_margin() {
        let mut c = Consensus::default();
        let mut result = None;
        for gap in [0.028, 0.032, 0.030, 0.029] {
            result = c.observe(&hypotheses(1., gap));
        }
        assert!(result.is_some());
    }
    #[test]
    fn equal_or_alternating_rooms_remain_unresolved() {
        let mut equal = Consensus::default();
        let mut alternating = Consensus::default();
        for i in 0..20 {
            assert!(equal.observe(&hypotheses(1., 0.)).is_none());
            assert!(
                alternating
                    .observe(&hypotheses(if i % 2 == 0 { 1. } else { 9. }, 0.06))
                    .is_none()
            );
        }
    }
}

#[cfg(test)]
mod recorded_consensus_test {
    use super::*;
    #[test]
    fn recorded_stationary_mirror_candidates_resolve_without_room_switching() {
        let rows: serde_json::Value = serde_json::from_str(include_str!(
            "../../fixtures/mirror-candidate-sequence.json"
        ))
        .unwrap();
        let mut s = State::default();
        let mut accepted = 0;
        for row in rows.as_array().unwrap() {
            let modes = row["hypotheses"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| Hypothesis {
                    pose: serde_json::from_value(h["pose"].clone()).unwrap(),
                    likelihood: h["likelihood"].as_f64().unwrap(),
                    agreement: h["agreement"].as_f64().unwrap(),
                })
                .collect();
            accept_match(&mut s, 0, Pose::default(), Instant::now(), modes);
            if s.confirm >= CONFIRM_SCANS {
                let p = s.pose.unwrap();
                assert!((p.x - 8.77).hypot(p.y + 0.37) < 0.15);
                accepted += 1;
            }
        }
        assert!(accepted > 5, "recorded persistent winner should resolve");
    }
}
