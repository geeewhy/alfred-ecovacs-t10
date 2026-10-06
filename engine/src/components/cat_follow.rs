//! Lightweight dark-motion tracking and map-cell search. No semantic cat model.
use super::return_geometry::{Geometry, Pose, wrap};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};

#[derive(Clone)]
pub struct Frame {
    pub stamp: u64,
    pub width: usize,
    pub height: usize,
    pub gray: Vec<u8>,
}
pub fn decode(jpeg: &[u8], stamp: u64) -> Result<Frame, String> {
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(jpeg));
    decoder.scale(216, 120).map_err(|e| e.to_string())?;
    let pixels = decoder.decode().map_err(|e| e.to_string())?;
    let info = decoder.info().ok_or("Missing JPEG metadata")?;
    let gray = match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 => pixels,
        jpeg_decoder::PixelFormat::RGB24 => pixels
            .chunks_exact(3)
            .map(|p| ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8)
            .collect(),
        _ => return Err("Unsupported camera pixel format".into()),
    };
    Ok(Frame {
        stamp,
        width: info.width as usize,
        height: info.height as usize,
        gray,
    })
}
#[derive(Clone, Copy, Serialize, Debug)]
pub struct Blob {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Blob {
    fn distance(self, b: Self) -> f64 {
        (self.x - b.x).hypot(self.y - b.y)
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Sighting {
    pub map_id: String,
    pub pose: Pose,
    pub observed_at_unix_ms: u64,
    pub estimated: bool,
    pub uncertainty_m: f64,
}
#[derive(Clone, Serialize, Default)]
pub struct Status {
    pub active: bool,
    pub phase: String,
    pub cells_total: usize,
    pub cells_checked: usize,
    pub cells_skipped: usize,
    pub target: Option<Blob>,
    pub last_seen: Option<Sighting>,
    pub camera_age_ms: Option<u64>,
}
#[derive(Default)]
pub struct Tracker {
    previous: Option<Frame>,
    candidate: Option<Blob>,
    hits: u8,
    pub target: Option<Blob>,
    pub stamp: u64,
}
impl Tracker {
    pub fn reset(&mut self) {
        self.previous = None;
        self.candidate = None;
        self.hits = 0;
        self.target = None;
    }
    pub fn update(&mut self, frame: Frame, stationary: bool) -> Option<Blob> {
        if frame.stamp <= self.stamp {
            return self.target;
        }
        self.stamp = frame.stamp;
        let blobs = blobs(&frame);
        let previous = self.previous.as_ref().filter(|p| {
            p.width == frame.width
                && p.height == frame.height
                && frame.stamp.saturating_sub(p.stamp) < 1200
        });
        let global_motion = previous
            .map(|p| {
                p.gray
                    .iter()
                    .zip(&frame.gray)
                    .filter(|(a, b)| a.abs_diff(**b) > 24)
                    .count() as f64
                    / frame.gray.len() as f64
            })
            .unwrap_or(1.);
        let found = if let Some(target) = self.target {
            blobs
                .iter()
                .copied()
                .filter(|b| {
                    b.distance(target) < 0.16
                        && (b.width / target.width).max(target.width / b.width) < 2.
                        && (b.height / target.height).max(target.height / b.height) < 2.
                })
                .min_by(|a, b| a.distance(target).total_cmp(&b.distance(target)))
        } else if stationary && global_motion < 0.20 {
            blobs
                .iter()
                .copied()
                .filter(|b| {
                    previous.is_some_and(|p| {
                        let cx = (b.x * frame.width as f64) as usize;
                        let cy = (b.y * frame.height as f64) as usize;
                        let rx = (b.width * frame.width as f64 / 2.) as usize;
                        let ry = (b.height * frame.height as f64 / 2.) as usize;
                        let mut changed = 0;
                        let mut dark = 0;
                        for y in cy.saturating_sub(ry)..=(cy + ry).min(frame.height - 1) {
                            for x in cx.saturating_sub(rx)..=(cx + rx).min(frame.width - 1) {
                                let i = y * frame.width + x;
                                if frame.gray[i] < 65 {
                                    dark += 1;
                                    if frame.gray[i].abs_diff(p.gray[i]) > 18 {
                                        changed += 1;
                                    }
                                }
                            }
                        }
                        dark > 0 && changed as f64 / dark as f64 > 0.06
                    })
                })
                .max_by(|a, b| (a.width * a.height).total_cmp(&(b.width * b.height)))
        } else {
            None
        };
        if self.target.is_some() {
            self.target = found;
        } else if let Some(b) = found {
            self.hits = if self.candidate.is_some_and(|c| c.distance(b) < 0.18) {
                self.hits + 1
            } else {
                1
            };
            self.candidate = Some(b);
            if self.hits >= 2 {
                self.target = Some(b);
            }
        } else {
            self.candidate = None;
            self.hits = 0;
        }
        self.previous = if stationary || self.target.is_some() {
            Some(frame)
        } else {
            None
        };
        self.target
    }
}
fn blobs(f: &Frame) -> Vec<Blob> {
    let (w, h) = (f.width, f.height);
    let mut seen = vec![false; w * h];
    let mut result = Vec::new();
    if w < 8 || h < 8 || f.gray.len() != w * h {
        return result;
    }
    for sy in h / 4..h {
        for sx in 0..w {
            let start = sy * w + sx;
            if seen[start] || f.gray[start] >= 65 {
                continue;
            }
            let mut q = VecDeque::from([(sx, sy)]);
            seen[start] = true;
            let (mut minx, mut maxx, mut miny, mut maxy, mut count) = (sx, sx, sy, sy, 0);
            while let Some((x, y)) = q.pop_front() {
                count += 1;
                minx = minx.min(x);
                maxx = maxx.max(x);
                miny = miny.min(y);
                maxy = maxy.max(y);
                for (nx, ny) in [
                    (x.wrapping_sub(1), y),
                    (x + 1, y),
                    (x, y.wrapping_sub(1)),
                    (x, y + 1),
                ] {
                    if nx < w && ny >= h / 4 && ny < h {
                        let i = ny * w + nx;
                        if !seen[i] && f.gray[i] < 65 {
                            seen[i] = true;
                            q.push_back((nx, ny));
                        }
                    }
                }
            }
            let bw = (maxx - minx + 1) as f64 / w as f64;
            let bh = (maxy - miny + 1) as f64 / h as f64;
            if count < 18 || bw < 0.025 || bh < 0.035 || bw > 0.60 || bh > 0.72 {
                continue;
            }
            result.push(Blob {
                x: (minx + maxx) as f64 / 2. / w as f64,
                y: (miny + maxy) as f64 / 2. / h as f64,
                width: bw,
                height: bh,
            });
        }
    }
    result
}
/// Candidate viewpoints in 1m map tiles; never claim unknown/blocked tiles covered.
pub fn cells(g: &Geometry) -> Vec<Pose> {
    let mut tiles: HashMap<(i32, i32), Pose> = HashMap::new();
    for c in &g.map.cells {
        let p = Pose {
            x: g.map.origin[0] + (c[0] as f64 + 0.5) * g.map.resolution,
            y: g.map.origin[1] + (c[1] as f64 + 0.5) * g.map.resolution,
            theta: 0.,
        };
        if !g.traversable(p) {
            continue;
        }
        let key = (p.x.floor() as i32, p.y.floor() as i32);
        let center = Pose {
            x: key.0 as f64 + 0.5,
            y: key.1 as f64 + 0.5,
            theta: 0.,
        };
        if tiles
            .get(&key)
            .is_none_or(|old| p.distance(center) < old.distance(center))
        {
            tiles.insert(key, p);
        }
    }
    let mut v: Vec<_> = tiles.into_values().collect();
    v.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    v
}
pub struct Search {
    pub status: Status,
    pub tracker: Tracker,
    pub pending: Vec<Pose>,
    pub goal: Option<Pose>,
    pub view: usize,
    pub settled: Option<f64>,
    pub cell_started: f64,
    pub last_motion: f64,
    pub last_wheels: Option<[f32; 2]>,
    pub last_follow: f64,
}
impl Search {
    pub fn new(g: &Geometry) -> Self {
        let pending = cells(g);
        Self {
            status: Status {
                active: true,
                phase: "searching".into(),
                cells_total: pending.len(),
                ..Default::default()
            },
            tracker: Tracker::default(),
            pending,
            goal: None,
            view: 0,
            settled: None,
            cell_started: 0.,
            last_motion: 0.,
            last_wheels: None,
            last_follow: 0.,
        }
    }
    pub fn next(&mut self, pose: Pose, now: f64) -> bool {
        self.pending
            .sort_by(|a, b| b.distance(pose).total_cmp(&a.distance(pose)));
        self.goal = self.pending.pop();
        self.view = 0;
        self.settled = None;
        self.cell_started = now;
        self.goal.is_some()
    }
    pub fn sighting(&mut self, map: &str, pose: Pose, b: Blob, stamp: u64) {
        // Apparent-width estimate, deliberately approximate: dark object may not be a cat.
        let range = (0.30 / (2. * (55f64.to_radians()).tan() * b.width)).clamp(0.35, 3.);
        let bearing = ((0.5 - b.x) * 2. * 55f64.to_radians().tan()).atan();
        self.status.last_seen = Some(Sighting {
            map_id: map.into(),
            pose: Pose {
                x: pose.x + range * (pose.theta + bearing).cos(),
                y: pose.y + range * (pose.theta + bearing).sin(),
                theta: 0.,
            },
            observed_at_unix_ms: stamp,
            estimated: true,
            uncertainty_m: (range * 0.6).max(0.4),
        });
        self.status.target = Some(b);
    }
}
pub fn follow(b: Blob) -> (f64, f64) {
    let bearing = ((0.5 - b.x) * 2. * 55f64.to_radians().tan()).atan();
    let w = (bearing * 1.5).clamp(-0.5, 0.5);
    // Stop at a generous apparent size; no blind advance when feet are out of frame.
    let v = if b.width >= 0.18
        || b.height >= 0.48
        || b.y + b.height / 2. >= 0.94
        || bearing.abs() > 0.30
    {
        0.
    } else {
        0.20
    };
    (v, w)
}
pub fn limit(v: f64, w: f64, max: f64) -> (f64, f64) {
    let peak = v.abs() + w.abs() * 0.243 / 2.;
    let scale = if peak > max { max / peak } else { 1. };
    (v * scale, w * scale)
}
pub fn view_heading(view: usize) -> f64 {
    wrap(view as f64 * std::f64::consts::FRAC_PI_2)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn frame(t: u64, x: usize) -> Frame {
        let mut f = Frame {
            stamp: t,
            width: 100,
            height: 80,
            gray: vec![180; 8000],
        };
        for y in 40..55 {
            for xx in x..x + 10 {
                f.gray[y * 100 + xx] = 20;
            }
        }
        f
    }
    #[test]
    fn static_dark_object_does_not_acquire() {
        let mut t = Tracker::default();
        for n in 1..10 {
            assert!(t.update(frame(n * 200, 30), true).is_none());
        }
    }
    #[test]
    fn moving_dark_object_acquires_then_loss_stops() {
        let mut t = Tracker::default();
        t.update(frame(200, 30), true);
        assert!(t.update(frame(400, 33), true).is_none());
        assert!(t.update(frame(600, 36), true).is_some());
        let mut blank = frame(800, 36);
        blank.gray.fill(180);
        assert!(t.update(blank, true).is_none());
    }
    #[test]
    fn ego_motion_never_acquires() {
        let mut t = Tracker::default();
        for n in 1..8 {
            assert!(
                t.update(frame(n * 200, 20 + n as usize * 3), false)
                    .is_none()
            );
        }
    }
    #[test]
    fn close_target_stops_and_search_wheels_are_capped() {
        let b = Blob {
            x: 0.5,
            y: 0.7,
            width: 0.25,
            height: 0.3,
        };
        assert_eq!(follow(b).0, 0.);
        let (v, w) = limit(0.2, 0.5, 0.05);
        assert!(v.abs() + w.abs() * 0.243 / 2. <= 0.050001);
    }
}

#[cfg(test)]
mod search_tests {
    use super::*;
    #[test]
    fn search_visits_each_traversable_tile_once() {
        let g=Geometry::new(serde_json::from_str(include_str!("../../fixtures/return-map.json")).unwrap()).unwrap();
        let mut search=Search::new(&g);let total=search.pending.len();assert!(total>5);
        let mut seen=std::collections::HashSet::new();let mut pose=g.map.station;
        while search.next(pose,0.) {let goal=search.goal.unwrap();assert!(g.traversable(goal));assert!(seen.insert((goal.x.floor() as i32,goal.y.floor() as i32)));pose=goal;}
        assert_eq!(seen.len(),total);
    }
    #[test]
    fn exposure_change_does_not_acquire_a_target() {
        let mut tracker=Tracker::default();
        for n in 1..7 {let mut gray=vec![if n%2==0{100}else{190};8000];for y in 40..55 {for x in 30..40 {gray[y*100+x]=20;}}
            assert!(tracker.update(Frame{stamp:n*200,width:100,height:80,gray},true).is_none());}
    }
    #[test]
    fn reset_invalidates_target_and_old_frames_do_not_confirm_motion() {
        let mut t=Tracker::default();let f=Frame{stamp:100,width:100,height:80,gray:vec![180;8000]};t.update(f.clone(),true);for _ in 0..5 {assert!(t.update(f.clone(),true).is_none());}t.reset();assert!(t.target.is_none());
    }
    #[test]
    fn live_jpeg_decodes_when_supplied() {
        let Ok(path)=std::env::var("ALFRED_TEST_JPEG")else{return;};
        let f=decode(&std::fs::read(path).unwrap(),1).unwrap();assert_eq!(f.gray.len(),f.width*f.height);assert!(f.width<=432&&f.width>=100);
    }
}
