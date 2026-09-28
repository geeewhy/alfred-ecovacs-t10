//! Directional reflectance evidence and bounded ray filtering.
//! Based on Foster/Johnson/Kuipers ICRA 2023 algorithms 1–3; thresholds below
//! are an Alfred adaptation, not a reproduction of the paper's benchmark.
//! The same code runs offline on HQ and online in the robot engine.
use super::return_geometry::Pose;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::f64::consts::TAU;

pub const RESOLUTION: f64 = 0.05;
const BINS: usize = 180; // two degrees
const MAX_CELLS: usize = 150_000;
type CellKey = (i32, i32);
fn key(p: [f64; 2]) -> CellKey {
    (
        (p[0] / RESOLUTION).floor() as i32,
        (p[1] / RESOLUTION).floor() as i32,
    )
}
fn center(k: CellKey) -> [f64; 2] {
    [
        (k.0 as f64 + 0.5) * RESOLUTION,
        (k.1 as f64 + 0.5) * RESOLUTION,
    ]
}
fn finite(p: [f64; 2]) -> bool {
    p.iter().all(|x| x.is_finite() && x.abs() < 1000.)
}
fn valid_pose(p: Pose) -> bool {
    finite([p.x, p.y]) && p.theta.is_finite()
}

/// Exact grid traversal, including the endpoint, with distance at cell entry.
/// A diagonal corner does not fabricate a hit in either neighboring cell.
fn ray(origin: [f64; 2], end: [f64; 2], mut visit: impl FnMut(CellKey, f64) -> bool) {
    let mut k = key(origin);
    let target = key(end);
    let dx = end[0] - origin[0];
    let dy = end[1] - origin[1];
    let length = dx.hypot(dy);
    if length < 1e-9 {
        return;
    }
    let sx = if dx > 0. { 1 } else { -1 };
    let sy = if dy > 0. { 1 } else { -1 };
    let tx = if dx.abs() > 1e-12 {
        RESOLUTION / dx.abs()
    } else {
        f64::INFINITY
    };
    let ty = if dy.abs() > 1e-12 {
        RESOLUTION / dy.abs()
    } else {
        f64::INFINITY
    };
    let mut x = if dx.abs() > 1e-12 {
        ((k.0 + if sx > 0 { 1 } else { 0 }) as f64 * RESOLUTION - origin[0]) / dx
    } else {
        f64::INFINITY
    };
    let mut y = if dy.abs() > 1e-12 {
        ((k.1 + if sy > 0 { 1 } else { 0 }) as f64 * RESOLUTION - origin[1]) / dy
    } else {
        f64::INFINITY
    };
    let mut t = 0.;
    for _ in 0..1000 {
        if !visit(k, t * length) || k == target {
            break;
        }
        if (x - y).abs() < 1e-10 {
            t = x;
            k.0 += sx;
            k.1 += sy;
            x += tx;
            y += ty;
        } else if x < y {
            t = x;
            k.0 += sx;
            x += tx;
        } else {
            t = y;
            k.1 += sy;
            y += ty;
        }
        if t > 1. + 1e-9 {
            break;
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Model {
    pub map_id: String,
    pub revision: String,
    pub cells: Vec<[i32; 2]>,
    /// Directions with repeated pass-through evidence and no nearby hit support.
    pub blocked_bins: Vec<Vec<u8>>,
}
impl Model {
    pub fn validate(&self) -> Result<(), String> {
        if self.map_id.len() != 36
            || !self
                .map_id
                .bytes()
                .all(|c| c.is_ascii_hexdigit() || c == b'-')
            || self.revision.is_empty()
            || self.revision.len() > 160
            || self.cells.len() > 30_000
            || self.blocked_bins.len() != self.cells.len()
            || self
                .blocked_bins
                .iter()
                .any(|v| v.len() > BINS || v.iter().any(|&b| b as usize >= BINS))
            || self
                .cells
                .iter()
                .flatten()
                .any(|v| v.unsigned_abs() > 20_000)
        {
            return Err("Invalid reflectance model".into());
        }
        Ok(())
    }
}
#[derive(Clone, Default)]
pub struct Boundaries {
    pub model: Model,
    cells: HashMap<CellKey, Vec<u8>>,
}
impl Boundaries {
    pub fn new(model: Model) -> Result<Self, String> {
        model.validate()?;
        let cells = model
            .cells
            .iter()
            .zip(&model.blocked_bins)
            .map(|(p, b)| ((p[0], p[1]), b.clone()))
            .collect();
        Ok(Self { model, cells })
    }
    pub fn crossing(&self, origin: [f64; 2], end: [f64; 2]) -> Option<[f64; 2]> {
        if self.cells.is_empty() {
            return None;
        }
        let length = (end[0] - origin[0]).hypot(end[1] - origin[1]);
        let mut hit = None;
        let direction = bin(origin, end) as u8;
        ray(origin, end, |k, d| {
            // Leave measured endpoint bands alone; only truncate genuinely
            // longer rays. Never turn a near return into a longer synthetic ray.
            if d > 0.18
                && d < length - 0.25
                && self
                    .cells
                    .get(&k)
                    .is_some_and(|bins| bins.contains(&direction))
            {
                let t = (d + 0.001) / length;
                hit = Some([
                    origin[0] + t * (end[0] - origin[0]),
                    origin[1] + t * (end[1] - origin[1]),
                ]);
                false
            } else {
                true
            }
        });
        hit
    }
    pub fn reflected(&self, pose: Pose, p: [f64; 2]) -> bool {
        let (s, c) = pose.theta.sin_cos();
        self.crossing(
            [pose.x, pose.y],
            [pose.x + c * p[0] - s * p[1], pose.y + s * p[0] + c * p[1]],
        )
        .is_some()
    }
    pub fn filter(&self, pose: Pose, points: &[[f64; 2]]) -> Filtered {
        let (s, c) = pose.theta.sin_cos();
        let mut out = Filtered {
            points: Vec::new(),
            obstacles: Vec::new(),
            reflected: 0,
            revision: self.model.revision.clone(),
        };
        for &p in points {
            let end = [pose.x + c * p[0] - s * p[1], pose.y + s * p[0] + c * p[1]];
            if let Some(hit) = self.crossing([pose.x, pose.y], end) {
                out.reflected += 1;
                let dx = hit[0] - pose.x;
                let dy = hit[1] - pose.y;
                out.obstacles.push([c * dx + s * dy, -s * dx + c * dy]);
            } else {
                out.points.push(p);
            }
        }
        out
    }
}
#[derive(Deserialize)]
pub struct FilterRequest {
    pub map_id: String,
    pub pose: Pose,
    pub points: Vec<[f64; 2]>,
}
impl FilterRequest {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_pose(self.pose)
            || self.points.len() > 4096
            || self
                .points
                .iter()
                .any(|p| !finite(*p) || p[0].hypot(p[1]) > 13.)
        {
            Err("Invalid reflectance scan (metres required)".into())
        } else {
            Ok(())
        }
    }
}
#[derive(Serialize)]
pub struct Filtered {
    /// Actual returns only, for localization. Rejected rays are absent, NOT infinity.
    pub points: Vec<[f64; 2]>,
    /// Boundary intersections, for obstacle marking only, never pose matching.
    pub obstacles: Vec<[f64; 2]>,
    pub reflected: usize,
    pub revision: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Keyframe {
    pub id: u64,
    pub pose: Pose,
    pub points: Vec<[f64; 2]>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Grid {
    pub resolution: f64,
    pub width: usize,
    pub height: usize,
    pub origin: [f64; 2],
    pub cells: Vec<[u32; 3]>,
}
#[derive(Deserialize)]
pub struct History {
    pub map_id: String,
    pub sequence: String,
    pub keyframes: Vec<Keyframe>,
    pub grid: Grid,
}
#[derive(Serialize)]
pub struct Rebuilt {
    pub map_id: String,
    pub sequence: String,
    pub keyframes: Vec<Keyframe>,
    pub grid: Grid,
    pub reflectance: Model,
    pub metrics: Metrics,
}
#[derive(Default, Serialize)]
pub struct Metrics {
    pub frames: usize,
    pub rays: usize,
    pub reflected_rays: usize,
    pub candidate_cells: usize,
    pub boundary_cells: usize,
    pub elapsed_ms: u128,
}
struct Evidence {
    scores: Vec<i8>,
    last: Vec<u32>,
}
impl Evidence {
    fn new() -> Self {
        Self {
            scores: vec![0; BINS],
            last: vec![0; BINS],
        }
    }
}

pub fn rebuild(history: History) -> Result<Rebuilt, String> {
    let started = std::time::Instant::now();
    let History {
        map_id,
        sequence,
        keyframes,
        grid,
    } = history;
    Model {
        map_id: map_id.clone(),
        revision: sequence.clone(),
        cells: vec![],
        blocked_bins: vec![],
    }
    .validate()?;
    if keyframes.len() > 5000
        || grid
            .width
            .checked_mul(grid.height)
            .is_none_or(|n| n == 0 || n > 1_000_000)
        || (grid.resolution - RESOLUTION).abs() > 1e-6
        || !finite(grid.origin)
    {
        return Err("Invalid reflection history geometry".into());
    }
    let mut field = HashMap::<CellKey, Evidence>::new();
    let mut seen = HashSet::new();
    let frames: Vec<_> = keyframes
        .into_iter()
        .filter(|f| seen.insert(f.id))
        .collect();
    let mut metrics = Metrics {
        frames: frames.len(),
        ..Default::default()
    };
    // Allocate only cells with a real endpoint in history. Free-only cells
    // cannot become reflective and do not need 180 angular counters.
    for frame in &frames {
        if !valid_pose(frame.pose)
            || frame.points.len() > 4096
            || frame.points.iter().any(|p| !finite(*p))
        {
            return Err("Invalid corrected keyframe".into());
        }
        for &p in &frame.points {
            if (p[0] - frame.pose.x).hypot(p[1] - frame.pose.y) > 12. {
                continue;
            }
            field.entry(key(p)).or_insert_with(Evidence::new);
            if field.len() > MAX_CELLS {
                return Err("Reflectance history exceeds native memory budget".into());
            }
        }
    }
    for (index, frame) in frames.iter().enumerate() {
        let origin = [frame.pose.x, frame.pose.y];
        let serial = index as u32 + 1;
        // One vote per cell/direction/keyframe. Endpoints take precedence over
        // adjacent rays that graze the same cell; scan density is not confidence.
        for &p in &frame.points {
            let distance = (p[0] - origin[0]).hypot(p[1] - origin[1]);
            if !(0.18..=12.).contains(&distance) {
                continue;
            }
            let b = bin(origin, p);
            let e = field.get_mut(&key(p)).unwrap();
            if e.last[b] != serial {
                e.scores[b] = (e.scores[b] + 2).min(12);
                e.last[b] = serial;
            }
        }
        for &p in &frame.points {
            let distance = (p[0] - origin[0]).hypot(p[1] - origin[1]);
            if !(0.18..=12.).contains(&distance) {
                continue;
            }
            metrics.rays += 1;
            let b = bin(origin, p);
            ray(origin, p, |k, d| {
                if d < distance - 0.25 {
                    if let Some(e) = field.get_mut(&k) {
                        if e.last[b] != serial {
                            e.scores[b] = (e.scores[b] - 1).max(-12);
                            e.last[b] = serial;
                        }
                    }
                }
                true
            });
        }
    }
    // Evaluate a 15 cm support neighborhood to avoid treating registration
    // noise across adjacent 5 cm cells as angular transparency. A nearby real
    // return overrides a pass-through vote in that direction.
    let supported: HashMap<CellKey, Vec<i8>> = field
        .iter()
        .map(|(&k, e)| {
            let mut scores = e.scores.clone();
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(other) = field.get(&(k.0 + dx, k.1 + dy)) {
                        for (value, &near) in scores.iter_mut().zip(&other.scores) {
                            if near > 0 {
                                *value = (*value).max(near);
                            }
                        }
                    }
                }
            }
            (k, scores)
        })
        .collect();
    metrics.candidate_cells = field.len();
    // Connected components in (x,y,view direction). A narrow lobe must attach
    // to widely visible structure: the paper's non-local motion discriminator.
    let broad: HashSet<_> = supported
        .iter()
        .filter(|(_, e)| e.iter().filter(|&&s| s >= 3).count() >= 10)
        .map(|(&k, _)| k)
        .collect();
    let mut nodes = HashSet::new();
    for (&k, e) in &field {
        for (b, &s) in e.scores.iter().enumerate() {
            if s >= 3 {
                nodes.insert((k, b));
            }
        }
    }
    let mut glass = HashSet::new();
    while let Some(&first) = nodes.iter().next() {
        nodes.remove(&first);
        let mut queue = VecDeque::from([first]);
        let mut component = HashSet::new();
        let mut anchored = false;
        while let Some((k, b)) = queue.pop_front() {
            component.insert(k);
            anchored |= broad.contains(&k);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for db in [BINS - 1, 0, 1] {
                        let next = ((k.0 + dx, k.1 + dy), (b + db) % BINS);
                        if nodes.remove(&next) {
                            queue.push_back(next);
                        }
                    }
                }
            }
        }
        if anchored && component.len() >= 6 {
            for k in component {
                let e = &supported[&k];
                let positives = e.iter().filter(|&&s| s >= 3).count();
                let misses = e.iter().filter(|&&s| s <= -3).count();
                if !broad.contains(&k) && positives >= 1 && misses >= 3 {
                    glass.insert(k);
                }
            }
        }
    }
    // Actual robot traversal contradicts a persistent surface at that location.
    // This also protects real entrances against isolated registration artifacts.
    glass.retain(|&k| {
        let p = center(k);
        !frames
            .iter()
            .any(|f| (p[0] - f.pose.x).hypot(p[1] - f.pose.y) < 0.22)
    });
    // No interpolation across unmeasured spans. Require a measured spatial
    // neighbor, avoiding isolated ghosts becoming barriers.
    let cells: Vec<_> = glass
        .iter()
        .filter(|&&(x, y)| {
            (-1..=1).any(|dx| {
                (-1..=1).any(|dy| (dx != 0 || dy != 0) && glass.contains(&(x + dx, y + dy)))
            })
        })
        .map(|&(x, y)| [x, y])
        .collect();
    let mut model = Model {
        map_id: map_id.clone(),
        revision: sequence.clone(),
        cells,
        blocked_bins: vec![],
    };
    model.cells.sort_unstable();
    model.blocked_bins = model
        .cells
        .iter()
        .map(|p| {
            supported[&(p[0], p[1])]
                .iter()
                .enumerate()
                .filter(|(_, s)| **s <= -3)
                .map(|(b, _)| b as u8)
                .collect()
        })
        .collect();
    let boundaries = Boundaries::new(model.clone())?;
    metrics.boundary_cells = model.cells.len();
    let (clean_frames, clean_grid) = repair_grid(frames, grid, &boundaries, &mut metrics);
    metrics.elapsed_ms = started.elapsed().as_millis();
    Ok(Rebuilt {
        map_id,
        sequence,
        keyframes: clean_frames,
        grid: clean_grid,
        reflectance: model,
        metrics,
    })
}
fn repair_grid(
    frames: Vec<Keyframe>,
    grid: Grid,
    boundaries: &Boundaries,
    metrics: &mut Metrics,
) -> (Vec<Keyframe>, Grid) {
    // Rebuild from evidence, discarding BOTH hit and free-space claims behind a
    // reflector. Preserve independently measured geometry behind it.
    let mut votes = HashMap::<CellKey, (u32, u32)>::new();
    let mut removed_hits = HashSet::new();
    let mut removed_free = HashSet::new();
    let mut barrier_hits = HashSet::new();
    let grid_point = |p: [f64; 2]| [p[0] - grid.origin[0], p[1] - grid.origin[1]];
    let mut clean_frames = Vec::new();
    for frame in frames {
        let origin = [frame.pose.x, frame.pose.y];
        let mut hits = HashSet::new();
        let mut misses = HashSet::new();
        let mut points = Vec::new();
        for p in frame.points {
            let length = (p[0] - origin[0]).hypot(p[1] - origin[1]);
            if !(0.18..=12.).contains(&length) {
                continue;
            }
            let crossing = boundaries.crossing(origin, p);
            let end = crossing.unwrap_or(p);
            if crossing.is_some() {
                metrics.reflected_rays += 1;
                removed_hits.insert(key(grid_point(p)));
                barrier_hits.insert(key(grid_point(end)));
                let after = (end[0] - origin[0]).hypot(end[1] - origin[1]) + 0.05;
                ray(grid_point(origin), grid_point(p), |k, d| {
                    if d > after {
                        removed_free.insert(k);
                    }
                    true
                });
            } else {
                points.push(p);
            }
            let target = key(grid_point(end));
            ray(grid_point(origin), grid_point(end), |k, _| {
                if k == target {
                    hits.insert(k);
                } else {
                    misses.insert(k);
                }
                true
            });
        }
        for &k in &hits {
            votes.entry(k).or_default().0 += 1;
        }
        for k in misses {
            if !hits.contains(&k) {
                votes.entry(k).or_default().1 += 1;
            }
        }
        clean_frames.push(Keyframe {
            id: frame.id,
            pose: frame.pose,
            points,
        });
    }
    // Preserve Karto's occupancy decisions except cells whose only evidence
    // was rejected. Do not change its thresholds or erase independently seen
    // furniture/walls while repairing reflected geometry.
    let mut cells = Vec::new();
    let mut present = HashSet::new();
    for &[x, y, value] in &grid.cells {
        let k = (x as i32, y as i32);
        let (hits, misses) = votes.get(&k).copied().unwrap_or_default();
        let value = if barrier_hits.contains(&k) {
            Some(129)
        } else if value > 127 && removed_hits.contains(&k) && hits == 0 {
            if misses >= 2 { Some(127) } else { None }
        } else if value <= 127 && removed_free.contains(&k) && misses == 0 && hits == 0 {
            None
        } else {
            Some(value)
        };
        if let Some(value) = value {
            cells.push([x, y, value]);
            present.insert(k);
        }
    }
    for (x, y) in barrier_hits {
        if x >= 0
            && y >= 0
            && x < grid.width as i32
            && y < grid.height as i32
            && !present.contains(&(x, y))
        {
            cells.push([x as u32, y as u32, 129]);
        }
    }
    cells.sort_unstable();
    // Without a detected boundary don't substitute a different occupancy model
    // for the existing SLAM grid just because this code ran.
    let clean_grid = if boundaries.model.cells.is_empty() {
        grid
    } else {
        Grid { cells, ..grid }
    };
    (clean_frames, clean_grid)
}

fn bin(origin: [f64; 2], end: [f64; 2]) -> usize {
    (((end[1] - origin[1])
        .atan2(end[0] - origin[0])
        .rem_euclid(TAU)
        / TAU
        * BINS as f64)
        .floor() as usize)
        % BINS
}

/// Only the compact boundary model lives in the robot runtime. Historical
/// inference is run by this binary's offline mode on HQ; no script algorithm.
pub struct ReflectanceService {
    root: std::path::PathBuf,
    models: tokio::sync::RwLock<HashMap<String, std::sync::Arc<Boundaries>>>,
    writer: tokio::sync::Mutex<()>,
}
impl ReflectanceService {
    pub fn new(root: impl Into<std::path::PathBuf>) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            root: root.into(),
            models: Default::default(),
            writer: Default::default(),
        })
    }
    pub async fn load(&self, map_id: &str) -> Result<std::sync::Arc<Boundaries>, String> {
        Model {
            map_id: map_id.into(),
            revision: "empty".into(),
            cells: vec![],
            blocked_bins: vec![],
        }
        .validate()?;
        if let Some(v) = self.models.read().await.get(map_id) {
            return Ok(v.clone());
        }
        let data = tokio::fs::read(self.root.join(format!("{map_id}.json"))).await;
        let model = match data {
            Ok(bytes) => serde_json::from_slice::<Model>(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Model {
                map_id: map_id.into(),
                revision: "empty".into(),
                cells: vec![],
                blocked_bins: vec![],
            },
            Err(e) => return Err(e.to_string()),
        };
        if model.map_id != map_id {
            return Err("Reflection model map mismatch".into());
        }
        let value = std::sync::Arc::new(Boundaries::new(model)?);
        let mut models = self.models.write().await;
        // Recheck after disk read so an old read cannot overwrite an install.
        if let Some(v) = models.get(map_id) {
            return Ok(v.clone());
        }
        if models.len() >= 4 {
            models.clear();
        }
        models.insert(map_id.into(), value.clone());
        Ok(value)
    }
    pub async fn install(&self, model: Model) -> Result<(), String> {
        let value = std::sync::Arc::new(Boundaries::new(model)?);
        let _writer = self.writer.lock().await;
        tokio::fs::create_dir_all(&self.root)
            .await
            .map_err(|e| e.to_string())?;
        let path = self.root.join(format!("{}.json", value.model.map_id));
        let tmp = path.with_extension("new");
        tokio::fs::write(
            &tmp,
            serde_json::to_vec(&value.model).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
        tokio::fs::rename(tmp, path)
            .await
            .map_err(|e| e.to_string())?;
        let mut models = self.models.write().await;
        if models.len() >= 4 {
            models.clear();
        }
        models.insert(value.model.map_id.clone(), value);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "48831c8a-3910-4c10-b560-e4a21f8a3bca";
    fn model() -> Boundaries {
        Boundaries::new(Model {
            map_id: ID.into(),
            revision: "test".into(),
            cells: (-10..=10).map(|y| [20, y]).collect(),
            blocked_bins: vec![(0..180).collect(); 21],
        })
        .unwrap()
    }
    #[test]
    fn filtered_rays_are_unknown_for_localization_and_bounded_for_obstacles() {
        let b = model();
        let r = b.filter(
            Pose::default(),
            &[[3., 0.], [0.5, 0.], [3., 3.], [1.025, 0.]],
        );
        assert_eq!(r.reflected, 1);
        assert_eq!(r.points.len(), 3);
        assert_eq!(r.obstacles.len(), 1);
        assert!((r.obstacles[0][0] - 1.).abs() < 0.01);
        assert!(
            b.crossing([0., 0.], [3., 3.]).is_none(),
            "real doorway beside panel remains open"
        );
    }
    #[test]
    fn crossing_works_from_both_sides_and_with_rotated_robot() {
        let b = model();
        assert!(b.crossing([3., 0.], [0., 0.]).is_some());
        assert!(b.reflected(
            Pose {
                x: 0.,
                y: 0.,
                theta: std::f64::consts::FRAC_PI_2
            },
            [0., -3.]
        ));
        assert!(b.crossing([0., 0.], [0.4, 0.]).is_none());
    }
    #[test]
    fn reject_wrong_units_paths_and_nonfinite() {
        assert!(
            Model {
                map_id: "../bad".into(),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            FilterRequest {
                map_id: ID.into(),
                pose: Pose::default(),
                points: vec![[1000., 0.]]
            }
            .validate()
            .is_err()
        );
        assert!(
            FilterRequest {
                map_id: ID.into(),
                pose: Pose::default(),
                points: vec![[f64::NAN, 0.]]
            }
            .validate()
            .is_err()
        );
    }
    fn history() -> History {
        History {
            map_id: ID.into(),
            sequence: "synthetic".into(),
            keyframes: vec![],
            grid: Grid {
                width: 160,
                height: 160,
                resolution: RESOLUTION,
                origin: [-4., -4.],
                cells: vec![],
            },
        }
    }
    #[test]
    fn open_space_and_repeated_same_frame_do_not_invent_mirrors() {
        let mut h = history();
        for id in 0..30 {
            h.keyframes.push(Keyframe {
                id,
                pose: Pose {
                    x: 0.,
                    y: id as f64 * 0.02,
                    theta: 0.,
                },
                points: (-20..20).map(|y| [3., y as f64 * 0.05]).collect(),
            });
        }
        let r = rebuild(h).unwrap();
        assert!(r.reflectance.cells.is_empty());
        assert_eq!(r.metrics.reflected_rays, 0);
        let mut h = history();
        h.keyframes = vec![
            Keyframe {
                id: 1,
                pose: Pose::default(),
                points: vec![[1., 0.]; 500]
            };
            100
        ];
        let r = rebuild(h).unwrap();
        assert_eq!(r.metrics.frames, 1);
        assert!(r.reflectance.cells.is_empty());
    }
    #[test]
    fn directional_panel_removes_coherent_ghosts_but_not_adjacent_doorway() {
        let mut h = history();
        for i in 0..81 {
            for repeat in 0..3 {
                let origin = [0., -2. + i as f64 * 0.05];
                let mut points = Vec::new();
                for j in -12..=12 {
                    let y = j as f64 * 0.05 + 0.025;
                    let direct = y.abs() > 0.45 || (y - origin[1]).abs() < 0.07;
                    points.push(if direct {
                        [1.025, y]
                    } else {
                        [3.075, origin[1] + 3. * (y - origin[1])]
                    });
                }
                // A genuine opening beside the panel has no surface returns.
                points.push([3.075, origin[1] + 3. * (1. - origin[1])]);
                h.keyframes.push(Keyframe {
                    id: i * 3 + repeat,
                    pose: Pose {
                        x: origin[0],
                        y: origin[1],
                        theta: 0.,
                    },
                    points,
                });
            }
        }
        // Original ghost hit, independently seen object, and unrelated cell.
        h.grid.cells = vec![[141, 40, 129], [141, 20, 129], [10, 10, 129]];
        h.keyframes.push(Keyframe {
            id: 10_000,
            pose: Pose {
                x: 3.8,
                y: -3.,
                theta: 0.,
            },
            points: vec![[3.075, -3.]],
        });
        let r = rebuild(h).unwrap();
        assert!(r.grid.cells.contains(&[141, 20, 129]));
        assert!(r.grid.cells.contains(&[10, 10, 129]));

        assert!(
            r.metrics.boundary_cells >= 8,
            "{}",
            serde_json::to_string(&r.metrics).unwrap()
        );
        assert!(r.metrics.reflected_rays > 100);
        let b = Boundaries::new(r.reflectance).unwrap();
        assert!(b.crossing([0., -0.3], [3., 0.6]).is_some());
        assert!(b.crossing([0., 0.], [3., 3.]).is_none());
        assert!(
            r.keyframes
                .iter()
                .flat_map(|f| &f.points)
                .any(|p| p[0] > 3. && p[1] > 2.)
        );
    }
    #[test]
    fn grid_repair_removes_only_exclusively_reflected_evidence() {
        let b = Boundaries::new(Model {
            map_id: ID.into(),
            revision: "known-panel".into(),
            cells: vec![[20, 0]],
            blocked_bins: vec![vec![0]],
        })
        .unwrap();
        let mut grid = history().grid;
        grid.cells = vec![[140, 80, 129], [130, 80, 127], [10, 10, 129]];
        let ghost = Keyframe {
            id: 1,
            pose: Pose {
                x: 0.,
                y: 0.025,
                theta: 0.,
            },
            points: vec![[3.025, 0.025]],
        };
        let (_, cleaned) = repair_grid(
            vec![ghost.clone()],
            grid.clone(),
            &b,
            &mut Metrics::default(),
        );
        assert!(!cleaned.cells.contains(&[140, 80, 129]));
        assert!(!cleaned.cells.contains(&[130, 80, 127]));
        assert!(cleaned.cells.contains(&[10, 10, 129]));
        let independent = Keyframe {
            id: 2,
            pose: Pose {
                x: 3.8,
                y: 0.025,
                theta: 0.,
            },
            points: vec![[3.025, 0.025]],
        };
        let (_, cleaned) = repair_grid(vec![ghost, independent], grid, &b, &mut Metrics::default());
        assert!(
            cleaned.cells.contains(&[140, 80, 129]),
            "independent hit must survive reflected ray rejection"
        );
    }
    #[test]
    fn registration_noise_does_not_turn_diffuse_wall_into_reflector() {
        let mut h = history();
        for i in 0..120 {
            let y = -2. + i as f64 * 0.035;
            let noise = if i % 3 == 0 {
                -0.05
            } else if i % 3 == 1 {
                0.05
            } else {
                0.
            };
            let points = (-20..=20)
                .map(|j| [1.025 + noise, j as f64 * 0.05 + 0.025])
                .collect();
            h.keyframes.push(Keyframe {
                id: i,
                pose: Pose {
                    x: 0.,
                    y,
                    theta: 0.,
                },
                points,
            });
        }
        let r = rebuild(h).unwrap();
        assert_eq!(r.metrics.reflected_rays, 0);
        assert!(r.reflectance.cells.is_empty());
    }
    #[test]
    fn moving_isolated_object_does_not_become_a_static_boundary() {
        let mut h = history();
        for i in 0..60 {
            let x = 0.5 + i as f64 * 0.025;
            let points = (-3..=3).map(|j| [x, j as f64 * 0.05]).collect();
            h.keyframes.push(Keyframe {
                id: i,
                pose: Pose::default(),
                points,
            });
        }
        let r = rebuild(h).unwrap();
        assert!(r.reflectance.cells.is_empty());
    }
    #[tokio::test]
    async fn persisted_models_are_map_scoped_and_survive_restart() {
        let dir = std::env::temp_dir().join(format!("alfred-reflection-{}", std::process::id()));
        let service = ReflectanceService::new(&dir);
        service.install(model().model).await.unwrap();
        drop(service);
        let service = ReflectanceService::new(&dir);
        assert_eq!(service.load(ID).await.unwrap().model.cells.len(), 21);
        assert!(
            service
                .load("00000000-0000-0000-0000-000000000000")
                .await
                .unwrap()
                .model
                .cells
                .is_empty()
        );
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
