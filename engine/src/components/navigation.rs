//! Shared native point-to-point navigation: live obstacle memory, A* rerouting,
//! and footprint-checked differential-drive trajectory rollout. No HQ heartbeat.
use super::return_geometry::{Geometry, Pose};
use std::collections::HashSet;

#[derive(Default)]
pub struct Navigator {
    obstacles: HashSet<usize>,
    observed_free: HashSet<usize>,
    walk: Vec<bool>,
    pub route: Vec<Pose>,
    pub replans: u32,
    planned_at: f64,
    last_scan: Option<u32>,
    goal: Option<Pose>,
    last_w: f64,
    recovery_target: Option<Pose>,
    visited: Vec<Pose>,
}
pub enum Command {
    Moving(f64, f64),
    Arrived,
    Waiting,
}
impl Navigator {
    pub fn recovering(&self) -> bool {
        self.recovery_target.is_some()
    }
    pub fn invalidate(&mut self) {
        self.route.clear();
        self.planned_at = -1.;
    }
    pub fn observe(&mut self, g: &Geometry, pose: Pose, sequence: u32, points: &[[f64; 2]]) {
        if self.last_scan == Some(sequence) {
            return;
        }
        self.last_scan = Some(sequence);
        let (s, c) = pose.theta.sin_cos();
        let mut hits = HashSet::new();
        let mut clear = HashSet::new();
        for p in points {
            let d = p[0].hypot(p[1]);
            if !(0.19..=12.).contains(&d) {
                continue;
            }
            let dx = c * p[0] - s * p[1];
            let dy = s * p[0] + c * p[1];
            // Only measured free rays clear remembered obstacles; turning away
            // or an elapsed timer is not evidence that a chair disappeared.
            let end = d.min(4.);
            let steps = (end / (g.map.resolution * 0.5)).ceil() as usize;
            for j in 0..steps {
                let t = j as f64 * (g.map.resolution * 0.5);
                if t >= d - 0.10 {
                    break;
                }
                if let Some(i) = g.index(pose.x + dx * t / d, pose.y + dy * t / d) {
                    clear.insert(i);
                }
            }
            if d <= 4. {
                if let Some(i) = g.index(pose.x + dx, pose.y + dy) {
                    hits.insert(i);
                }
            }
        }
        self.obstacles.retain(|i| !clear.contains(i));
        self.observed_free.extend(&clear);
        for i in &hits {
            self.observed_free.remove(i);
        }
        self.obstacles.extend(hits);
        self.walk = g.navigation_space(&self.observed_free);
    }
    fn center(g: &Geometry, i: usize) -> Pose {
        Pose {
            x: g.map.origin[0]
                + (i % g.map.width) as f64 * g.map.resolution
                + g.map.resolution / 2.,
            y: g.map.origin[1]
                + (i / g.map.width) as f64 * g.map.resolution
                + g.map.resolution / 2.,
            theta: 0.,
        }
    }
    fn inflated(&self, g: &Geometry) -> HashSet<usize> {
        let mut blocked = HashSet::new();
        let radius = 0.23; // body + measurement/grid uncertainty
        let n = (radius / g.map.resolution).ceil() as i32;
        for &i in &self.obstacles {
            let p = Self::center(g, i);
            for dx in -n..=n {
                for dy in -n..=n {
                    if ((dx * dx + dy * dy) as f64) * g.map.resolution.powi(2) <= radius * radius {
                        if let Some(j) = g.index(
                            p.x + dx as f64 * g.map.resolution,
                            p.y + dy as f64 * g.map.resolution,
                        ) {
                            blocked.insert(j);
                        }
                    }
                }
            }
        }
        blocked
    }
    pub fn diagnostics(&self, g: &Geometry, pose: Pose, goal: Pose) -> serde_json::Value {
        let blocked = self.inflated(g);
        let route = g
            .route_with_obstacles(pose, goal, &HashSet::new())
            .unwrap_or_default();
        let conflicts: Vec<_> = route
            .iter()
            .filter(|p| g.index(p.x, p.y).is_some_and(|i| blocked.contains(&i)))
            .collect();
        serde_json::json!({"obstacles":self.obstacles.iter().map(|&i|Self::center(g,i)).collect::<Vec<_>>(),
            "conflicts":conflicts,"recovery_target":self.recovery_target,"viewpoints_checked":self.visited.len(),"route_error":g.route_in_space(pose,goal,&self.walk,&blocked).err()})
    }
    pub fn command(&mut self, g: &Geometry, pose: Pose, goal: Pose, now: f64) -> Command {
        if pose.distance(goal) < 0.10 {
            self.route.clear();
            return Command::Arrived;
        }
        if self.goal.is_none_or(|old| old.distance(goal) > 0.01) {
            self.invalidate();
            self.goal = Some(goal);
        }
        if self.walk.is_empty() {
            self.walk = g.navigation_space(&self.observed_free);
        }
        let blocked = self.inflated(g);
        let invalid = self
            .route
            .iter()
            .any(|p| g.index(p.x, p.y).is_none_or(|i| blocked.contains(&i)));
        if now - self.planned_at >= 0.5
            || self.planned_at < 0.
            || (invalid && now - self.planned_at >= 0.1)
        {
            self.planned_at = now;
            self.replans += 1;
            self.route = g
                .route_in_space(pose, goal, &self.walk, &blocked)
                .unwrap_or_default();
            if self.route.is_empty() {
                if self
                    .recovery_target
                    .is_some_and(|p| p.distance(pose) < 0.13)
                {
                    self.visited.push(self.recovery_target.take().unwrap());
                }
                if let Some(target) = self.recovery_target {
                    self.route = g
                        .route_in_space(pose, target, &self.walk, &blocked)
                        .unwrap_or_default();
                    if self.route.is_empty() {
                        self.visited.push(target);
                        self.recovery_target = None;
                    }
                }
                if self.route.is_empty() && self.visited.len() < 4 {
                    self.route = g
                        .observation_route(pose, goal, &self.walk, &blocked, &self.visited)
                        .unwrap_or_default();
                    self.recovery_target = self.route.last().copied();
                }
            } else {
                self.recovery_target = None;
                self.visited.clear();
            }
        }
        while self.route.first().is_some_and(|p| p.distance(pose) < 0.10) {
            self.route.remove(0);
        }
        let effective_goal = self.recovery_target.unwrap_or(goal);
        let Some(target) = self
            .route
            .iter()
            .find(|p| p.distance(pose) >= 0.30)
            .or(self.route.last())
            .copied()
            .or_else(|| (pose.distance(effective_goal) < 0.20).then_some(effective_goal))
        else {
            return Command::Waiting;
        };
        let obstacles: Vec<_> = self
            .obstacles
            .iter()
            .map(|&i| Self::center(g, i))
            .filter(|p| p.distance(pose) < 1.)
            .collect();
        let a = pose.relative(target);
        let heading = a.y.atan2(a.x);
        let mut candidates = vec![(
            if heading.abs() < 0.5 { 0.18 } else { 0. },
            (heading * 1.5).clamp(-0.65, 0.65),
        )];
        for v in [-0.10, 0., 0.10, 0.18, 0.22] {
            for w in [-0.65, -0.35, 0., 0.35, 0.65] {
                if v != 0. || w != 0. {
                    candidates.push((v, w));
                }
            }
        }
        let mut best = None;
        for (v, w) in candidates {
            let Some(end) = rollout_in_space(g, pose, v, w, &obstacles, Some(&self.walk)) else {
                continue;
            };
            let rel = end.relative(target);
            let score = -end.distance(target)
                - (if pose.distance(target) > 0.25 {
                    0.08
                } else {
                    0.
                }) * rel.y.atan2(rel.x).abs()
                + 0.10 * v
                - 0.025 * (w - self.last_w).abs()
                - if v < 0. { 0.08 } else { 0. };
            if best.is_none_or(|(_, _, s)| score > s) {
                best = Some((v, w, score));
            }
        }
        match best {
            Some((v, w, _)) => {
                self.last_w = w;
                Command::Moving(v, w)
            }
            None => {
                self.route.clear();
                Command::Waiting
            }
        }
    }
}
#[cfg(test)]
fn rollout(g: &Geometry, start: Pose, v: f64, w: f64, obstacles: &[Pose]) -> Option<Pose> {
    rollout_in_space(g, start, v, w, obstacles, None)
}
fn rollout_in_space(
    g: &Geometry,
    start: Pose,
    v: f64,
    w: f64,
    obstacles: &[Pose],
    space: Option<&[bool]>,
) -> Option<Pose> {
    let initial = obstacles
        .iter()
        .map(|p| p.distance(start))
        .fold(f64::INFINITY, f64::min);
    let mut pose = start;
    for _ in 0..30 {
        pose.advance((v - w * 0.243 / 2.) * 0.05, (v + w * 0.243 / 2.) * 0.05);
        if !space.map_or_else(
            || g.traversable(pose),
            |w| g.index(pose.x, pose.y).is_some_and(|i| w[i]),
        ) {
            return None;
        }
        let clearance = obstacles
            .iter()
            .map(|p| p.distance(pose))
            .fold(f64::INFINITY, f64::min);
        if clearance < 0.23 && (initial >= 0.23 || clearance < initial + 0.002 || v == 0.) {
            return None;
        }
    }
    Some(pose)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::return_geometry::ReturnMap;
    fn room() -> Geometry {
        let mut cells = Vec::new();
        for y in 0..100 {
            for x in 0..160 {
                cells.push([
                    x,
                    y,
                    if x == 0 || y == 0 || x == 159 || y == 99 {
                        129
                    } else {
                        127
                    },
                ]);
            }
        }
        Geometry::localization(ReturnMap {
            map_id: "test".into(),
            resolution: 0.05,
            width: 160,
            height: 100,
            origin: [0., 0.],
            cells,
            station: Pose::default(),
            enclosure: vec![],
        })
        .unwrap()
    }
    fn chair(pose: Pose) -> Vec<[f64; 2]> {
        (0..60)
            .map(|i| {
                let a = i as f64 * std::f64::consts::TAU / 60.;
                let p = pose.relative(Pose {
                    x: 3. + 0.3 * a.cos(),
                    y: 2.5 + 0.3 * a.sin(),
                    theta: 0.,
                });
                [p.x, p.y]
            })
            .collect()
    }
    #[test]
    fn complete_trip_detours_around_unsaved_chair() {
        let g = room();
        let mut nav = Navigator::default();
        let mut p = Pose {
            x: 1.,
            y: 2.5,
            theta: 0.,
        };
        let goal = Pose {
            x: 6.,
            y: 2.5,
            theta: 0.,
        };
        let mut detour: f64 = 0.;
        let mut arrived = false;
        for i in 0..1800 {
            nav.observe(&g, p, i, &chair(p));
            match nav.command(&g, p, goal, i as f64 * 0.1) {
                Command::Moving(v, w) => {
                    p.advance((v - w * 0.243 / 2.) * 0.1, (v + w * 0.243 / 2.) * 0.1)
                }
                Command::Arrived => {
                    arrived = true;
                    break;
                }
                Command::Waiting => {}
            }
            detour = detour.max((p.y - 2.5).abs());
            assert!(
                p.distance(Pose {
                    x: 3.,
                    y: 2.5,
                    theta: 0.
                }) > 0.50,
                "collided {p:?}"
            );
        }
        assert!(arrived, "failed to arrive {p:?}, replans {}", nav.replans);
        assert!(detour > 0.5);
        assert!(nav.replans > 1);
    }
    #[test]
    fn exits_a_u_shaped_obstacle_before_heading_toward_goal() {
        let g = room();
        let mut n = Navigator::default();
        let mut p = Pose {
            x: 4.,
            y: 2.5,
            theta: std::f64::consts::PI,
        };
        let goal = Pose {
            x: 1.5,
            y: 2.5,
            theta: 0.,
        };
        let mut walls = Vec::new();
        for i in 0..=60 {
            walls.push(Pose {
                x: 3.,
                y: 1. + i as f64 * 0.05,
                theta: 0.,
            });
        }
        for i in 0..=40 {
            for y in [1., 4.] {
                walls.push(Pose {
                    x: 3. + i as f64 * 0.05,
                    y,
                    theta: 0.,
                });
            }
        }
        let mut arrived = false;
        let mut furthest: f64 = p.x;
        for i in 0..2400 {
            let points: Vec<_> = walls
                .iter()
                .map(|q| {
                    let r = p.relative(*q);
                    [r.x, r.y]
                })
                .collect();
            n.observe(&g, p, i, &points);
            match n.command(&g, p, goal, i as f64 * 0.1) {
                Command::Moving(v, w) => {
                    p.advance((v - w * 0.243 / 2.) * 0.1, (v + w * 0.243 / 2.) * 0.1)
                }
                Command::Arrived => {
                    arrived = true;
                    break;
                }
                Command::Waiting => {}
            }
            furthest = furthest.max(p.x);
            assert!(
                walls.iter().all(|q| p.distance(*q) > 0.20),
                "collision {p:?}"
            );
        }
        assert!(arrived, "U-shaped dead end {p:?}");
        assert!(furthest > 5.2);
    }
    #[test]
    fn obstacle_appearing_after_initial_plan_changes_route() {
        let g = room();
        let mut n = Navigator::default();
        let p = Pose {
            x: 1.,
            y: 2.5,
            theta: 0.,
        };
        let goal = Pose {
            x: 6.,
            y: 2.5,
            theta: 0.,
        };
        assert!(matches!(n.command(&g, p, goal, 1.), Command::Moving(..)));
        let before = n.route.clone();
        n.observe(&g, p, 1, &chair(p));
        assert!(matches!(n.command(&g, p, goal, 1.2), Command::Moving(..)));
        assert!(n.replans >= 2);
        assert!(before.iter().any(|q| q.distance(Pose {
            x: 3.,
            y: 2.5,
            theta: 0.
        }) < 0.3));
        assert!(n.route.iter().all(|q| q.distance(Pose {
            x: 3.,
            y: 2.5,
            theta: 0.
        }) > 0.5));
    }
    #[test]
    fn remembered_obstacles_need_clear_rays_not_time_to_disappear() {
        let g = room();
        let mut n = Navigator::default();
        let p = Pose {
            x: 1.,
            y: 2.5,
            theta: 0.,
        };
        n.observe(&g, p, 1, &[[2., 0.]]);
        let old = n.obstacles.clone();
        assert!(!old.is_empty());
        n.observe(&g, p, 2, &[[0., 1.]]);
        assert!(old.is_subset(&n.obstacles));
        n.observe(&g, p, 3, &[[3., 0.]]);
        assert!(old.is_disjoint(&n.obstacles));
    }
    #[test]
    fn blocked_route_recovers_when_obstacle_moves() {
        let g = room();
        let mut n = Navigator::default();
        let p = Pose {
            x: 1.,
            y: 2.5,
            theta: 0.,
        };
        let goal = Pose {
            x: 6.,
            y: 2.5,
            theta: 0.,
        };
        let wall: Vec<_> = (0..100).map(|y| [2., y as f64 * 0.05 - 2.5]).collect();
        n.observe(&g, p, 1, &wall);
        assert!(matches!(n.command(&g, p, goal, 1.), Command::Moving(..)));
        assert!(n.recovering());
        let clearing: Vec<_> = wall.iter().map(|q| [q[0] * 2.2, q[1] * 2.2]).collect();
        n.observe(&g, p, 2, &clearing);
        assert!(matches!(n.command(&g, p, goal, 2.), Command::Moving(..)));
    }
    #[test]
    fn measured_floor_fills_unknown_gaps_without_erasing_static_walls() {
        let mut map = room().map;
        map.cells
            .retain(|p| !(p[0] >= 35 && p[0] <= 45 && p[1] > 0 && p[1] < 99));
        let g = Geometry::localization(map).unwrap();
        let p = Pose {
            x: 2.,
            y: 2.5,
            theta: 0.,
        };
        assert!(!g.traversable(p));
        let observed: HashSet<_> = (0..g.map.width * g.map.height).collect();
        let live = g.navigation_space(&observed);
        assert!(live[g.index(p.x, p.y).unwrap()]);
        assert!(
            !live[g.index(0.025, 2.5).unwrap()],
            "free rays must not remove a saved wall"
        );
    }
    #[test]
    fn fully_blocked_goal_checks_bounded_approaches_then_waits() {
        let g = room();
        let mut n = Navigator::default();
        let mut p = Pose {
            x: 1.,
            y: 2.5,
            theta: 0.,
        };
        let goal = Pose {
            x: 6.,
            y: 2.5,
            theta: 0.,
        };
        let wall: Vec<_> = (0..100)
            .map(|y| Pose {
                x: 3.,
                y: y as f64 * 0.05,
                theta: 0.,
            })
            .collect();
        let mut moved = false;
        let mut waiting = false;
        for i in 0..1800 {
            let points: Vec<_> = wall
                .iter()
                .map(|q| {
                    let r = p.relative(*q);
                    [r.x, r.y]
                })
                .collect();
            n.observe(&g, p, i, &points);
            match n.command(&g, p, goal, i as f64 * 0.1) {
                Command::Moving(v, w) => {
                    p.advance((v - w * 0.243 / 2.) * 0.1, (v + w * 0.243 / 2.) * 0.1);
                    moved |= v.abs() > 0.;
                }
                Command::Waiting => {
                    if n.visited.len() >= 4 {
                        waiting = true;
                        break;
                    }
                }
                Command::Arrived => panic!("crossed an impassable wall"),
            }
            assert!(p.x < 2.80);
        }
        assert!(moved);
        assert!(
            waiting,
            "unbounded approach cycling {} {p:?}",
            n.visited.len()
        );
    }
    #[test]
    fn curved_trajectory_cannot_cut_through_an_obstacle() {
        let g = room();
        let p = Pose {
            x: 1.,
            y: 2.,
            theta: 0.,
        };
        let obstacle = Pose {
            x: 1.23,
            y: 2.15,
            theta: 0.,
        };
        assert!(rollout(&g, p, 0.22, 0.65, &[obstacle]).is_none());
        assert!(rollout(&g, p, -0.1, 0., &[obstacle]).is_some());
    }
}
