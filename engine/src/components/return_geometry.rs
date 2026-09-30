//! Saved-map localization and routing. Coordinates are metres in the exported map frame.
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub theta: f64,
}
pub fn wrap(a: f64) -> f64 {
    a.sin().atan2(a.cos())
}
impl Pose {
    pub fn distance(self, b: Self) -> f64 {
        (self.x - b.x).hypot(self.y - b.y)
    }
    pub fn relative(self, b: Self) -> Self {
        let (s, c) = self.theta.sin_cos();
        let x = b.x - self.x;
        let y = b.y - self.y;
        Self {
            x: c * x + s * y,
            y: -s * x + c * y,
            theta: wrap(b.theta - self.theta),
        }
    }
    pub fn advance(&mut self, left: f64, right: f64) {
        let yaw = (right - left) / 0.243;
        let d = (left + right) / 2.;
        self.x += d * (self.theta + yaw / 2.).cos();
        self.y += d * (self.theta + yaw / 2.).sin();
        self.theta = wrap(self.theta + yaw);
    }
}
#[derive(Clone, Deserialize, Serialize)]
pub struct ReturnMap {
    pub map_id: String,
    pub resolution: f64,
    pub width: usize,
    pub height: usize,
    pub origin: [f64; 2],
    pub cells: Vec<[u32; 3]>,
    pub station: Pose,
    pub enclosure: Vec<[f64; 2]>,
}
pub struct Geometry {
    reflections: super::reflectance::Boundaries,
    pub map: ReturnMap,
    free: Vec<bool>,
    protected: std::collections::HashSet<usize>,
    distance: Vec<u16>,
    walk: Vec<bool>,
}
impl Geometry {
    pub fn new(map: ReturnMap) -> Result<Self, String> {
        Self::build(map, true)
    }
    pub fn localization(map: ReturnMap) -> Result<Self, String> {
        Self::build(map, false)
    }
    fn build(map: ReturnMap, docking: bool) -> Result<Self, String> {
        let n = map
            .width
            .checked_mul(map.height)
            .ok_or("Map dimensions overflow")?;
        if n == 0
            || n > 1_000_000
            || map.width < 3
            || map.height < 3
            || !(0.02..=0.10).contains(&map.resolution)
            || map.map_id.is_empty()
            || map.origin.iter().any(|x| !x.is_finite())
            || [map.station.x, map.station.y, map.station.theta]
                .iter()
                .any(|x| !x.is_finite())
            || (docking && map.enclosure.len() < 30)
            || map.enclosure.len() > 5000
            || map
                .enclosure
                .iter()
                .flatten()
                .any(|x| !x.is_finite() || x.abs() > 1.)
        {
            return Err("Invalid return map or station".into());
        }
        let mut free = vec![false; n];
        let mut distance = vec![u16::MAX; n];
        let mut queue = VecDeque::new();
        for &[x, y, v] in &map.cells {
            if x as usize >= map.width || y as usize >= map.height || ![127, 129].contains(&v) {
                return Err("Map cells must be explicit free=127 / occupied=129".into());
            }
            let i = y as usize * map.width + x as usize;
            if v == 127 {
                free[i] = true
            } else {
                distance[i] = 0;
                queue.push_back(i);
            }
        }
        if queue.len() < 30 {
            return Err("Map lacks occupied evidence".into());
        }
        while let Some(i) = queue.pop_front() {
            for j in neighbors(i, map.width, map.height) {
                if distance[j] > distance[i].saturating_add(1) {
                    distance[j] = distance[i] + 1;
                    queue.push_back(j)
                }
            }
        }
        let radius = (0.18 / map.resolution).ceil() as isize;
        let mut walk = free.clone();
        for (i, allowed) in walk.iter_mut().enumerate() {
            if !*allowed {
                continue;
            }
            let x = (i % map.width) as isize;
            let y = (i / map.width) as isize;
            'footprint: for dy in -radius..=radius {
                for dx in -radius..=radius {
                    if (dx * dx + dy * dy) as f64 * map.resolution.powi(2) > 0.18f64.powi(2) {
                        continue;
                    }
                    let xx = x + dx;
                    let yy = y + dy;
                    if xx < 0
                        || yy < 0
                        || xx >= map.width as isize
                        || yy >= map.height as isize
                        || !free[yy as usize * map.width + xx as usize]
                    {
                        *allowed = false;
                        break 'footprint;
                    }
                }
            }
        }
        Ok(Self {
            reflections: Default::default(),
            map,
            free,
            protected: Default::default(),
            distance,
            walk,
        })
    }
    pub fn with_reflections(
        map: ReturnMap,
        reflections: super::reflectance::Boundaries,
    ) -> Result<Self, String> {
        Self::build_with_reflections(map, reflections, true)
    }
    pub fn with_navigation_reflections(
        map: ReturnMap,
        reflections: super::reflectance::Boundaries,
    ) -> Result<Self, String> {
        Self::build_with_reflections(map, reflections, false)
    }
    fn build_with_reflections(
        map: ReturnMap,
        reflections: super::reflectance::Boundaries,
        docking: bool,
    ) -> Result<Self, String> {
        if !reflections.model.map_id.is_empty() && reflections.model.map_id != map.map_id {
            return Err("Reflection/return map mismatch".into());
        }
        let mut value = Self::build(map, docking)?;
        // The compact mask is retained independently of HQ. Add its measured
        // surfaces to routing without changing station coordinates or disk map.
        for p in &reflections.model.cells {
            if let Some(i) = value.index((p[0] as f64 + 0.5) * 0.05, (p[1] as f64 + 0.5) * 0.05) {
                value.protected.insert(i);
                value.free[i] = false;
                value.distance[i] = 0;
                let x = i % value.map.width;
                let y = i / value.map.width;
                let radius = (0.18 / value.map.resolution).ceil() as isize;
                for dx in -radius..=radius {
                    for dy in -radius..=radius {
                        let xx = x as isize + dx;
                        let yy = y as isize + dy;
                        if xx >= 0
                            && yy >= 0
                            && xx < value.map.width as isize
                            && yy < value.map.height as isize
                        {
                            value.walk[yy as usize * value.map.width + xx as usize] = false;
                        }
                    }
                }
            }
        }
        value.reflections = reflections;
        Ok(value)
    }
    pub fn index(&self, x: f64, y: f64) -> Option<usize> {
        let xx = ((x - self.map.origin[0]) / self.map.resolution).floor() as isize;
        let yy = ((y - self.map.origin[1]) / self.map.resolution).floor() as isize;
        if xx < 0 || yy < 0 || xx >= self.map.width as isize || yy >= self.map.height as isize {
            None
        } else {
            Some(yy as usize * self.map.width + xx as usize)
        }
    }
    fn center(&self, i: usize) -> Pose {
        Pose {
            x: self.map.origin[0]
                + (i % self.map.width) as f64 * self.map.resolution
                + self.map.resolution / 2.,
            y: self.map.origin[1]
                + (i / self.map.width) as f64 * self.map.resolution
                + self.map.resolution / 2.,
            theta: 0.,
        }
    }
    pub fn score(&self, pose: Pose, points: &[[f64; 2]]) -> f64 {
        if points.len() < 25 {
            return 0.;
        }
        let (s, c) = pose.theta.sin_cos();
        let hits = points
            .iter()
            .filter(|p| {
                self.index(pose.x + c * p[0] - s * p[1], pose.y + s * p[0] + c * p[1])
                    .is_some_and(|i| self.distance[i] as f64 * self.map.resolution <= 0.10)
            })
            .count();
        hits as f64 / points.len() as f64
    }
    pub fn refine(&self, seed: Pose, points: &[[f64; 2]], wide: bool) -> (Pose, f64) {
        let filtered: Vec<_> = points
            .iter()
            .copied()
            .filter(|p| !self.reflections.reflected(seed, *p))
            .collect();
        // A candidate cannot win by explaining away nearly all measurements.
        if filtered.len() < 25 || filtered.len() * 3 < points.len() {
            return (seed, 0.);
        }
        let points = &filtered;
        let mut best = seed;
        let mut score = self.score(seed, points);
        let scales = if wide {
            vec![(0.1, 0.10, 2), (0.025, 0.025, 2)]
        } else {
            vec![(0.025, 0.025, 2)]
        };
        for (xy, angle, range) in scales {
            let base = best;
            for a in -range..=range {
                for y in -range..=range {
                    for x in -range..=range {
                        let p = Pose {
                            x: base.x + x as f64 * xy,
                            y: base.y + y as f64 * xy,
                            theta: wrap(base.theta + a as f64 * angle),
                        };
                        let v = self.score(p, points);
                        if v > score + 1e-9 {
                            best = p;
                            score = v
                        }
                    }
                }
            }
        }
        (best, score)
    }
    pub fn locate(&self, points: &[[f64; 2]]) -> Option<(Pose, f64)> {
        let stride = (0.25 / self.map.resolution).round().max(1.) as usize;
        let mut candidates = Vec::new();
        for y in (0..self.map.height).step_by(stride) {
            for x in (0..self.map.width).step_by(stride) {
                let i = y * self.map.width + x;
                if !self.walk[i] {
                    continue;
                }
                let mut p = self.center(i);
                for a in 0..24 {
                    p.theta = a as f64 * std::f64::consts::TAU / 24.;
                    let s = self.score(p, points);
                    if s > 0.45 {
                        candidates.push((p, s));
                    }
                }
            }
        }
        candidates.sort_by(|a, b| b.1.total_cmp(&a.1));
        let mut distinct = Vec::<(Pose, f64)>::new();
        for (p, _) in candidates {
            if distinct
                .iter()
                .any(|(q, _)| p.distance(*q) < 0.4 && wrap(p.theta - q.theta).abs() < 0.4)
            {
                continue;
            }
            distinct.push(self.refine(p, points, true));
            if distinct.len() >= 20 {
                break;
            }
        }
        distinct.sort_by(|a, b| b.1.total_cmp(&a.1));
        let best = *distinct.first()?;
        if best.1 < 0.78
            || distinct.iter().skip(1).any(|(p, s)| {
                *s > best.1 - 0.06
                    && (p.distance(best.0) > 0.4 || wrap(p.theta - best.0.theta).abs() > 0.4)
            })
        {
            None
        } else {
            Some(best)
        }
    }
    /// Optional close-range dock refinement. Require independently supported
    /// left/right/rear surfaces; never replace the saved station or admit a
    /// distant enclosure. Uses observed points against the calibrated model.
    pub fn refine_dock(&self, pose: Pose, points: &[[f64; 2]]) -> Option<Pose> {
        let local = self.map.station.relative(pose);
        if local.x < -0.05 || local.x > 0.35 || local.y.abs() > 0.15 {
            return None;
        }
        let prior = pose.relative(self.map.station);
        let mut bounds = [
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ];
        for q in &self.map.enclosure {
            bounds[0] = bounds[0].min(q[0]);
            bounds[1] = bounds[1].max(q[0]);
            bounds[2] = bounds[2].min(q[1]);
            bounds[3] = bounds[3].max(q[1]);
        }
        let mut seen = std::collections::HashSet::new();
        let scan: Vec<Pose> = points
            .iter()
            .map(|q| Pose {
                x: q[0],
                y: q[1],
                theta: 0.,
            })
            .filter(|q| {
                let l = prior.relative(*q);
                l.x > bounds[0] - 0.08
                    && l.x < bounds[1] + 0.08
                    && l.y > bounds[2] - 0.08
                    && l.y < bounds[3] + 0.08
                    && seen.insert(((q.x / 0.005).round() as i32, (q.y / 0.005).round() as i32))
            })
            .collect();
        if scan.len() < 40 {
            return None;
        }
        // Exact nearest neighbor with x-axis pruning keeps this fit within
        // the control loop budget on the robot's CPU.
        let mut model = self.map.enclosure.clone();
        model.sort_unstable_by(|a, b| a[0].total_cmp(&b[0]));
        let distance = |l: Pose| {
            let split = model.partition_point(|q| q[0] < l.x);
            let mut best = f64::INFINITY;
            for q in model[split..].iter() {
                let dx = (l.x - q[0]).powi(2);
                if dx >= best {
                    break;
                }
                best = best.min(dx + (l.y - q[1]).powi(2));
            }
            for q in model[..split].iter().rev() {
                let dx = (l.x - q[0]).powi(2);
                if dx >= best {
                    break;
                }
                best = best.min(dx + (l.y - q[1]).powi(2));
            }
            best.sqrt()
        };
        let loss = |target: Pose| {
            scan.iter()
                .map(|q| {
                    let d = distance(target.relative(*q));
                    0.025f64.powi(2) * ((1. + (d / 0.025).powi(2)).sqrt() - 1.)
                })
                .sum::<f64>()
        };
        let mut best = prior;
        let mut cost = loss(best);
        for (xy, angle, range) in [(0.02, 0.05, 3), (0.005, 0.0125, 1), (0.0025, 0.00625, 1)] {
            let base = best;
            for a in -range..=range {
                for y in -range..=range {
                    for x in -range..=range {
                        let candidate = Pose {
                            x: base.x + x as f64 * xy,
                            y: base.y + y as f64 * xy,
                            theta: wrap(base.theta + a as f64 * angle),
                        };
                        if candidate.distance(prior) > 0.06
                            || wrap(candidate.theta - prior.theta).abs() > 0.15
                        {
                            continue;
                        }
                        let v = loss(candidate);
                        if v < cost {
                            best = candidate;
                            cost = v;
                        }
                    }
                }
            }
        }
        let mut counts = [0usize; 3];
        let mut hits = [0usize; 3];
        let mut total = 0;
        let mut rms = 0.;
        for q in &scan {
            let l = best.relative(*q);
            let d = distance(l);
            rms += d.min(0.06).powi(2);
            if d < 0.04 {
                total += 1;
            }
            let sector = if l.y > 0.09 && l.x > -0.14 {
                Some(0)
            } else if l.y < -0.09 && l.x > -0.14 {
                Some(1)
            } else if l.x < -0.10 && l.y.abs() < 0.09 {
                Some(2)
            } else {
                None
            };
            if let Some(i) = sector {
                counts[i] += 1;
                if d < 0.04 {
                    hits[i] += 1;
                }
            }
        }
        if total as f64 / scan.len() as f64 <= 0.82
            || (rms / scan.len() as f64).sqrt() >= 0.03
            || (0..3).any(|i| counts[i] < 6 || hits[i] as f64 / counts[i] as f64 <= 0.70)
        {
            return None;
        }
        let theta = wrap(self.map.station.theta - best.theta);
        let (sn, cs) = theta.sin_cos();
        Some(Pose {
            x: self.map.station.x - cs * best.x + sn * best.y,
            y: self.map.station.y - sn * best.x - cs * best.y,
            theta,
        })
    }
    #[cfg(test)]
    pub fn route(&self, start: Pose, goal: Pose) -> Result<Vec<Pose>, String> {
        self.route_with_obstacles(start, goal, &std::collections::HashSet::new())
    }
    pub fn obstacle_points(&self, pose: Pose, points: &[[f64; 2]]) -> Vec<[f64; 2]> {
        let mut filtered = self.reflections.filter(pose, points);
        filtered.points.extend(filtered.obstacles);
        filtered.points
    }
    pub fn traversable(&self, p: Pose) -> bool {
        self.index(p.x, p.y).is_some_and(|i| self.walk[i])
    }
    pub fn navigation_space(&self, observed: &std::collections::HashSet<usize>) -> Vec<bool> {
        self.navigation_space_with_clearing(observed, &Default::default())
    }
    pub fn navigation_space_with_clearing(
        &self,
        observed: &std::collections::HashSet<usize>,
        cleared: &std::collections::HashSet<usize>,
    ) -> Vec<bool> {
        let mut walk = self.walk.clone();
        let r = (0.18 / self.map.resolution).ceil() as isize;
        // Live rays establish unknown floor; confirmed clearing changes only this
        // temporary navigation layer, never the stored localization map.
        let candidates: std::collections::HashSet<_> = observed
            .iter()
            .flat_map(|&i| {
                neighbors(i, self.map.width, self.map.height)
                    .into_iter()
                    .chain(std::iter::once(i))
            })
            .collect();
        for i in candidates {
            if walk[i]
                || (self.distance[i] == 0 && !cleared.contains(&i))
                || self.protected.contains(&i)
            {
                continue;
            }
            let x = (i % self.map.width) as isize;
            let y = (i / self.map.width) as isize;
            let mut clear = true;
            'footprint: for dy in -r..=r {
                for dx in -r..=r {
                    if ((dx * dx + dy * dy) as f64) * self.map.resolution.powi(2) > 0.18f64.powi(2)
                    {
                        continue;
                    }
                    let (xx, yy) = (x + dx, y + dy);
                    if xx < 0
                        || yy < 0
                        || xx >= self.map.width as isize
                        || yy >= self.map.height as isize
                    {
                        clear = false;
                        break 'footprint;
                    }
                    let j = yy as usize * self.map.width + xx as usize;
                    if self.protected.contains(&j)
                        || (self.distance[j] == 0 && !cleared.contains(&j))
                        || (!self.free[j] && !observed.contains(&j))
                    {
                        clear = false;
                        break 'footprint;
                    }
                }
            }
            walk[i] = clear;
        }
        walk
    }
    /// Recover a robot already inside the planning margin. Open only a short
    /// outward corridor to normal clearance, never occupied/unknown body space.
    pub fn margin_escape(
        &self,
        start: Pose,
        space: &mut [bool],
        blocked: &std::collections::HashSet<usize>,
    ) -> bool {
        let Some(begin) = self.index(start.x, start.y) else {
            return false;
        };
        if space[begin] {
            return true;
        }
        let clearance = |i: usize| {
            let p = self.center(i);
            let mut closest = f64::INFINITY;
            let n = (0.5 / self.map.resolution).ceil() as isize;
            let x = (i % self.map.width) as isize;
            let y = (i / self.map.width) as isize;
            for dy in -n..=n {
                for dx in -n..=n {
                    let (xx, yy) = (x + dx, y + dy);
                    let d = (dx as f64).hypot(dy as f64) * self.map.resolution;
                    if xx < 0
                        || yy < 0
                        || xx >= self.map.width as isize
                        || yy >= self.map.height as isize
                    {
                        closest = closest.min(d);
                        continue;
                    }
                    let j = yy as usize * self.map.width + xx as usize;
                    if !self.free[j] || self.distance[j] == 0 {
                        closest = closest.min(p.distance(self.center(j)));
                    }
                }
            }
            closest
        };
        let initial = clearance(begin);
        if initial < 0.19 || blocked.contains(&begin) {
            return false;
        }
        let mut queue = VecDeque::from([(begin, initial)]);
        let mut parent = vec![usize::MAX; space.len()];
        parent[begin] = begin;
        while let Some((i, previous)) = queue.pop_front() {
            if space[i] {
                let mut at = i;
                space[at] = true;
                while at != begin {
                    at = parent[at];
                    space[at] = true;
                }
                return true;
            }
            for j in neighbors(i, self.map.width, self.map.height) {
                if parent[j] != usize::MAX
                    || blocked.contains(&j)
                    || self.center(j).distance(start) > 0.4
                {
                    continue;
                }
                let next = clearance(j);
                if next + 1e-9 < previous || next < 0.19 {
                    continue;
                }
                parent[j] = i;
                queue.push_back((j, next));
            }
        }
        false
    }
    pub fn route_with_obstacles(
        &self,
        start: Pose,
        goal: Pose,
        blocked: &std::collections::HashSet<usize>,
    ) -> Result<Vec<Pose>, String> {
        self.route_in_space(start, goal, &self.walk, blocked)
    }
    /// Reach a different observed approach when the destination is temporarily
    /// disconnected. All cells still obey the same footprint and obstacle mask.
    pub fn observation_route(
        &self,
        start: Pose,
        goal: Pose,
        space: &[bool],
        blocked: &std::collections::HashSet<usize>,
        visited: &[Pose],
        observed: &std::collections::HashSet<usize>,
    ) -> Option<Vec<Pose>> {
        let allowed = |i: usize| space[i] && !blocked.contains(&i);
        let begin = self.index(start.x, start.y)?;
        if !allowed(begin) {
            return None;
        }
        let mut costs = vec![usize::MAX; space.len()];
        let mut parent = vec![usize::MAX; space.len()];
        let mut queue = VecDeque::from([begin]);
        costs[begin] = 0;
        let mut best = None;
        while let Some(i) = queue.pop_front() {
            let p = self.center(i);
            if i % self.map.width % 4 == 0
                && i / self.map.width % 4 == 0
                && p.distance(start) > 0.40
                && visited.iter().all(|v| v.distance(p) > 0.50)
            {
                // Expected new visibility, not just proximity to a blocked goal.
                // Ray casting respects saved/current obstacles and reflection masks.
                let mut gain = std::collections::HashSet::new();
                for beam in 0..48 {
                    let angle = beam as f64 * std::f64::consts::TAU / 48.;
                    for step in 1..=20 {
                        let d = step as f64 * 0.075;
                        let Some(j) = self.index(p.x + d * angle.cos(), p.y + d * angle.sin())
                        else {
                            break;
                        };
                        if self.protected.contains(&j)
                            || (self.distance[j] == 0 && !observed.contains(&j))
                            || blocked.contains(&j)
                        {
                            break;
                        }
                        if !observed.contains(&j) {
                            gain.insert(j);
                        }
                    }
                }
                if gain.len() >= 12 {
                    let score = 0.4 * p.distance(goal)
                        + 0.2 * costs[i] as f64 * self.map.resolution
                        - 0.012 * gain.len() as f64;
                    if best.is_none_or(|(_, s)| score < s) {
                        best = Some((i, score));
                    }
                }
            }
            for j in neighbors(i, self.map.width, self.map.height) {
                if allowed(j) && costs[j] == usize::MAX {
                    costs[j] = costs[i] + 1;
                    parent[j] = i;
                    queue.push_back(j);
                }
            }
        }
        let (mut i, _) = best?;
        let mut path = vec![self.center(i)];
        while i != begin {
            i = parent[i];
            path.push(self.center(i));
        }
        path.reverse();
        Some(path)
    }
    pub fn route_in_space(
        &self,
        start: Pose,
        goal: Pose,
        space: &[bool],
        blocked: &std::collections::HashSet<usize>,
    ) -> Result<Vec<Pose>, String> {
        self.route_with_costs(start, goal, space, blocked, &[])
    }
    pub fn route_with_costs(
        &self,
        start: Pose,
        goal: Pose,
        space: &[bool],
        blocked: &std::collections::HashSet<usize>,
        extra: &[u16],
    ) -> Result<Vec<Pose>, String> {
        let walk: Vec<_> = space
            .iter()
            .enumerate()
            .map(|(i, v)| *v && !blocked.contains(&i))
            .collect();
        let nearest = |p: Pose| -> Option<usize> {
            let i = self.index(p.x, p.y)?;
            if walk[i] {
                return Some(i);
            }
            walk.iter()
                .enumerate()
                .filter(|(_, v)| **v)
                .map(|(j, _)| (j, self.center(j).distance(p)))
                .filter(|(_, d)| *d < 0.15)
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .map(|x| x.0)
        };
        let start = nearest(start).ok_or("Robot is outside traversable saved map")?;
        let goal = nearest(goal).ok_or("Station approach is outside traversable map")?;
        let n = self.free.len();
        let mut cost = vec![usize::MAX; n];
        let mut parent = vec![usize::MAX; n];
        let mut open = BinaryHeap::new();
        cost[start] = 0;
        open.push(Reverse((0, start)));
        while let Some(Reverse((_, i))) = open.pop() {
            if i == goal {
                let mut path = vec![self.center(i)];
                let mut at = i;
                while at != start {
                    at = parent[at];
                    path.push(self.center(at));
                }
                path.reverse();
                return Ok(path);
            }
            for j in neighbors(i, self.map.width, self.map.height) {
                let next = cost[i]
                    + 10
                    + extra.get(j).copied().unwrap_or(0) as usize
                    + if self.distance[j] < 6 {
                        (6 - self.distance[j]) as usize * 4
                    } else {
                        0
                    };
                if !walk[j] || cost[j] <= next {
                    continue;
                }
                cost[j] = next;
                parent[j] = i;
                let h = (j % self.map.width).abs_diff(goal % self.map.width)
                    + (j / self.map.width).abs_diff(goal / self.map.width);
                open.push(Reverse((cost[j] + 10 * h, j)))
            }
        }
        Err("No collision-free route to station in saved map".into())
    }
}
fn neighbors(i: usize, w: usize, h: usize) -> Vec<usize> {
    let mut v = Vec::with_capacity(4);
    if i % w > 0 {
        v.push(i - 1)
    }
    if i % w + 1 < w {
        v.push(i + 1)
    }
    if i >= w {
        v.push(i - w)
    }
    if i + w < w * h {
        v.push(i + w)
    }
    v
}

/// Proven return geometry: position in front, rear alignment, continuous ramp entry.
#[derive(Default)]
pub struct DockController {
    clearing: bool,
    aligning: bool,
}
impl DockController {
    pub fn command(&mut self, station: Pose, pose: Pose, reseat: bool) -> (&'static str, f64, f64) {
        let robot = station.relative(pose);
        let heading = wrap(station.theta - pose.theta);
        if reseat {
            return ("reseating", 0.10, 0.);
        }
        if robot.x < 0.30 && (robot.y.abs() > 0.05 || heading.abs() > 0.30) {
            self.clearing = true;
            self.aligning = false;
        }
        if self.clearing {
            if robot.x < 0.42 {
                return ("clearing-entry", 0.10, 0.);
            }
            self.clearing = false;
        }
        if (robot.y.abs() < (if self.aligning { 0.05 } else { 0.04 }) && heading.abs() < 0.20)
            || (robot.x < 0.30 && robot.y.abs() <= 0.05 && heading.abs() <= 0.30)
        {
            return (
                "entering",
                -0.15,
                (1.2 * (heading + (robot.y * 4.).clamp(-0.15, 0.15))).clamp(-0.12, 0.12),
            );
        }
        let staging = Pose {
            x: station.x + 0.45 * station.theta.cos(),
            y: station.y + 0.45 * station.theta.sin(),
            theta: station.theta,
        };
        let target = pose.relative(staging);
        if pose.distance(staging) < 0.09 && robot.y.abs() < 0.04 {
            self.aligning = true;
        }
        if pose.distance(staging) > 0.15 || robot.y.abs() > 0.05 {
            self.aligning = false;
        }
        if self.aligning {
            return (
                "rear-alignment",
                0.,
                heading.signum() * (heading.abs() * 1.2).clamp(0.16, 0.60),
            );
        }
        let angle = target.y.atan2(target.x);
        if angle.abs() > 0.10 {
            (
                "staging",
                0.,
                angle.signum() * (angle.abs() * 1.2).clamp(0.16, 0.60),
            )
        } else {
            (
                "staging",
                if robot.x > 0.60 { 0.15 } else { 0.10 },
                (angle * 0.5).clamp(-0.1, 0.1),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Geometry {
        Geometry::new(serde_json::from_str(include_str!("../../fixtures/return-map.json")).unwrap())
            .unwrap()
    }
    #[test]
    fn saved_map_validation_and_route() {
        let g = fixture();
        let s = g.map.station;
        let goal = Pose {
            x: s.x + 0.55 * s.theta.cos(),
            y: s.y + 0.55 * s.theta.sin(),
            theta: s.theta,
        };
        let route = g
            .route(
                Pose {
                    x: 4.5,
                    y: 0.,
                    theta: 0.,
                },
                goal,
            )
            .unwrap();
        assert!(route.len() > 5);
        assert!(route.iter().all(|p| g.walk[g.index(p.x, p.y).unwrap()]));
        let mut bad = g.map.clone();
        bad.cells.push([999999, 0, 127]);
        assert!(Geometry::new(bad).is_err());
    }
    #[test]
    fn ramp_clearance_does_not_reverse_at_entry_boundary() {
        let mut controller = DockController::default();
        let station = Pose::default();
        for x in [0.28, 0.295, 0.305, 0.32, 0.299, 0.36, 0.40, 0.419] {
            let (phase, v, w) = controller.command(
                station,
                Pose {
                    x,
                    y: 0.055,
                    theta: 0.1,
                },
                false,
            );
            assert_eq!(phase, "clearing-entry");
            assert_eq!(v, 0.10);
            assert_eq!(w, 0.0);
        }
        assert_ne!(
            controller
                .command(
                    station,
                    Pose {
                        x: 0.43,
                        y: 0.055,
                        theta: 0.1
                    },
                    false
                )
                .0,
            "clearing-entry"
        );
    }
    #[test]
    fn ramp_entry_and_reseat_have_usable_drive_speed() {
        let mut controller = DockController::default();
        for x in [0.50, 0.31, 0.29, 0.15, 0.05] {
            assert_eq!(
                controller
                    .command(
                        Pose::default(),
                        Pose {
                            x,
                            y: 0.02,
                            theta: 0.08
                        },
                        false
                    )
                    .1,
                -0.15
            );
        }
        assert_eq!(
            controller.command(Pose::default(), Pose::default(), true).1,
            0.10
        );
    }
    #[test]
    fn reported_onboard_failure_routes_with_preserved_station() {
        let g = fixture();
        let start = Pose {
            x: 4.567463707181301,
            y: 0.6181947558025409,
            theta: 2.7797932657906435,
        };
        let approach = |s: Pose| Pose {
            x: s.x + 0.55 * s.theta.cos(),
            y: s.y + 0.55 * s.theta.sin(),
            theta: s.theta,
        };
        let corrupted = Pose {
            x: 6.554699780939094,
            y: -2.023441095102329,
            theta: 2.476487323574037,
        };
        assert_eq!(
            g.route(start, approach(corrupted)).unwrap_err(),
            "Station approach is outside traversable map"
        );
        let route = g.route(start, approach(g.map.station)).unwrap();
        assert!(!route.is_empty());
        assert!(route.last().unwrap().distance(approach(g.map.station)) < 0.15);
    }
    #[test]
    fn full_return_faces_station_then_enters_with_ramp_speed() {
        let station = Pose::default();
        let mut p = Pose {
            x: 0.8,
            y: -0.08,
            theta: 3.0,
        };
        let mut entered = false;
        let mut controller = DockController::default();
        let mut elapsed = 0.;
        for _ in 0..1800 {
            let (phase, v, w) = controller.command(station, p, false);
            if phase == "entering" {
                entered = true;
                assert!(v <= -0.1)
            }
            p.advance((v - w * 0.243 / 2.) * 0.05, (v + w * 0.243 / 2.) * 0.05);
            elapsed += 0.05;
            if p.x <= 0. && p.y.abs() < 0.025 && p.theta.abs() < 0.10 {
                break;
            }
        }
        assert!(entered);
        assert!(
            p.x <= 0. && p.y.abs() < 0.025 && p.theta.abs() < 0.10,
            "{p:?}, elapsed {elapsed}"
        );
        assert!(elapsed < 90.);
    }
    #[test]
    fn recorded_scan_localizes_in_saved_map() {
        let g = fixture();
        let sample: serde_json::Value = serde_json::from_str(include_str!(
            "../../../mapping/fixtures/dock-oblique-rejection.json"
        ))
        .unwrap();
        let pts: Vec<[f64; 2]> = sample["points"]
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
            .filter(|p| p[0].hypot(p[1]) > 0.25 && p[0].hypot(p[1]) < 6.)
            .step_by(4)
            .collect();
        let result = g.locate(&pts);
        eprintln!("recorded localization {result:?}");
        let (p, score) = result.expect("unique localization");
        assert!(score >= 0.78);
        assert!(
            p.distance(Pose {
                x: 4.69,
                y: -0.97,
                theta: -2.14
            }) < 0.25
        );
        assert!(wrap(p.theta + 2.14).abs() < 0.25);
    }
    #[test]
    fn insufficient_scan_is_not_a_location() {
        assert!(fixture().locate(&[[0., 0.]; 4]).is_none());
    }
}
