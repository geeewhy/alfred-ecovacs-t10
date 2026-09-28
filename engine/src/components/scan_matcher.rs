//! Likelihood-field correlative localization. Coarse search + multi-resolution
//! refinement, with distinct modes retained across observations. This is not AMCL.
use super::{
    map_evidence::EvidenceMap,
    reflectance::{Boundaries, Grid},
    return_geometry::{Pose, wrap},
};
use serde::Serialize;
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Hypothesis {
    pub pose: Pose,
    pub likelihood: f64,
    pub agreement: f64,
}
pub struct ScanMatcher {
    grid: Grid,
    field: Vec<f64>,
    distance: Vec<f64>,
    free: Vec<usize>,
}
impl ScanMatcher {
    pub fn new(grid: Grid) -> Self {
        let n = grid.width * grid.height;
        let mut d = vec![1000f64; n];
        let mut free = Vec::new();
        for &[x, y, v] in &grid.cells {
            let i = y as usize * grid.width + x as usize;
            if v > 127 { d[i] = 0. } else { free.push(i) }
        }
        // Eight-connected chamfer distance; metric is bounded and precomputed once.
        let w = grid.width;
        let h = grid.height;
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if x > 0 {
                    d[i] = d[i].min(d[i - 1] + 1.)
                }
                if y > 0 {
                    d[i] = d[i].min(d[i - w] + 1.);
                    if x > 0 {
                        d[i] = d[i].min(d[i - w - 1] + 2f64.sqrt())
                    }
                    if x + 1 < w {
                        d[i] = d[i].min(d[i - w + 1] + 2f64.sqrt())
                    }
                }
            }
        }
        for y in (0..h).rev() {
            for x in (0..w).rev() {
                let i = y * w + x;
                if x + 1 < w {
                    d[i] = d[i].min(d[i + 1] + 1.)
                }
                if y + 1 < h {
                    d[i] = d[i].min(d[i + w] + 1.);
                    if x > 0 {
                        d[i] = d[i].min(d[i + w - 1] + 2f64.sqrt())
                    }
                    if x + 1 < w {
                        d[i] = d[i].min(d[i + w + 1] + 2f64.sqrt())
                    }
                }
            }
        }
        for v in &mut d {
            *v *= grid.resolution;
        }
        let field = d
            .iter()
            .map(|v| 0.1 + 0.9 * (-v * v / (2. * 0.10f64.powi(2))).exp())
            .collect();
        Self {
            grid,
            field,
            distance: d,
            free,
        }
    }
    fn index(&self, x: f64, y: f64) -> Option<usize> {
        let x = ((x - self.grid.origin[0]) / self.grid.resolution).floor() as isize;
        let y = ((y - self.grid.origin[1]) / self.grid.resolution).floor() as isize;
        if x < 0 || y < 0 || x >= self.grid.width as isize || y >= self.grid.height as isize {
            None
        } else {
            Some(y as usize * self.grid.width + x as usize)
        }
    }
    fn score(&self, p: Pose, points: &[[f64; 2]]) -> Hypothesis {
        let (s, c) = p.theta.sin_cos();
        let mut likelihood = 0.;
        let mut hits = 0;
        for q in points {
            if let Some(i) = self.index(p.x + c * q[0] - s * q[1], p.y + s * q[0] + c * q[1]) {
                likelihood += self.field[i];
                if self.distance[i] <= 0.15 {
                    hits += 1
                }
            } else {
                likelihood += 0.1
            }
        }
        let n = points.len().max(1) as f64;
        Hypothesis {
            pose: p,
            likelihood: likelihood / n,
            agreement: hits as f64 / n,
        }
    }
    pub fn refine(&self, p: Pose, points: &[[f64; 2]], wide: bool) -> Hypothesis {
        self.refine_with_prior(p, points, wide, false)
    }
    fn refine_with_prior(
        &self,
        p: Pose,
        points: &[[f64; 2]],
        wide: bool,
        motion: bool,
    ) -> Hypothesis {
        let origin = p;
        let objective = |h: Hypothesis| {
            h.likelihood
                - if motion {
                    0.05 * ((h.pose.distance(origin) / 0.15).powi(2)
                        + (wrap(h.pose.theta - origin.theta) / 0.15).powi(2))
                } else {
                    0.
                }
        };
        let mut best = self.score(p, points);
        let scales = if wide {
            vec![(0.10, 0.05, 3), (0.025, 0.0125, 3), (0.0125, 0.00625, 1)]
        } else {
            vec![(0.025, 0.0125, 3), (0.0125, 0.00625, 1)]
        };
        for (xy, a, r) in scales {
            let base = best.pose;
            for da in -r..=r {
                for dy in -r..=r {
                    for dx in -r..=r {
                        let p = Pose {
                            x: base.x + dx as f64 * xy,
                            y: base.y + dy as f64 * xy,
                            theta: wrap(base.theta + da as f64 * a),
                        };
                        let v = self.score(p, points);
                        if objective(v) > objective(best) {
                            best = v
                        }
                    }
                }
            }
        }
        best
    }
    #[cfg(test)]
    pub fn global(&self, points: &[[f64; 2]], evidence: &EvidenceMap) -> Vec<Hypothesis> {
        self.global_with_reflections(points, evidence, None)
    }
    pub fn global_with_reflections(
        &self,
        points: &[[f64; 2]],
        evidence: &EvidenceMap,
        reflections: Option<&Boundaries>,
    ) -> Vec<Hypothesis> {
        if points.len() < 100 {
            return vec![];
        }
        let sparse: Vec<_> = points
            .iter()
            .step_by((points.len() / 120).max(1))
            .copied()
            .collect();
        let stride = (0.25 / self.grid.resolution).round() as usize;
        let mut candidates = Vec::new();
        for a in 0..72 {
            let mut angle_candidates = Vec::new();
            for &i in &self.free {
                let x = i % self.grid.width;
                let y = i / self.grid.width;
                if x % stride != 0 || y % stride != 0 {
                    continue;
                }
                let p = Pose {
                    x: self.grid.origin[0] + (x as f64 + 0.5) * self.grid.resolution,
                    y: self.grid.origin[1] + (y as f64 + 0.5) * self.grid.resolution,
                    theta: a as f64 * std::f64::consts::TAU / 72.,
                };
                angle_candidates.push(self.score(p, &sparse));
            }
            angle_candidates.sort_by(|a, b| b.likelihood.total_cmp(&a.likelihood));
            candidates.extend(angle_candidates.into_iter().take(4));
        }
        candidates.sort_by(|a, b| b.likelihood.total_cmp(&a.likelihood));
        let mut modes: Vec<Hypothesis> = Vec::new();
        let mut explored = Vec::new();
        for c in candidates {
            if explored.iter().any(|p| same_mode(*p, c.pose)) {
                continue;
            }
            explored.push(c.pose);
            let fit = self.refine(c.pose, &sparse, true);
            // Apply each hypothesis's mask BEFORE full-scan fitting and the
            // visibility rejection. Otherwise the valid location can already
            // have been thrown out because of its reflected returns.
            let filtered: Vec<_> = points
                .iter()
                .copied()
                .filter(|p| reflections.is_none_or(|r| !r.reflected(fit.pose, *p)))
                .collect();
            if filtered.len() < 100 || filtered.len() * 3 < points.len() {
                if explored.len() >= 32 {
                    break;
                }
                continue;
            }
            let mut fit = self.refine(fit.pose, &filtered, false);
            let visibility = evidence.evaluate(fit.pose, &filtered);
            // Endpoint proximity alone rewards dense clutter and mirror ghosts.
            // Rank with free-space consistency as well, before selecting a mode.
            fit.likelihood -= 0.5 * visibility.contradiction;
            if fit.agreement >= 0.65 && !visibility.tracking_lost {
                merge(&mut modes, fit);
            }
            if explored.len() >= 32 {
                break;
            }
        }
        modes.sort_by(|a, b| b.likelihood.total_cmp(&a.likelihood));
        modes.truncate(8);
        modes
    }
    #[cfg(test)]
    pub fn track(
        &self,
        priors: &[Hypothesis],
        points: &[[f64; 2]],
        evidence: &EvidenceMap,
    ) -> Vec<Hypothesis> {
        self.track_window(priors, points, evidence, false)
    }
    pub fn track_window(
        &self,
        priors: &[Hypothesis],
        points: &[[f64; 2]],
        evidence: &EvidenceMap,
        wide: bool,
    ) -> Vec<Hypothesis> {
        let mut modes = Vec::new();
        for h in priors {
            let mut fit = self.refine_with_prior(h.pose, points, wide, true);
            let visibility = evidence.evaluate(fit.pose, points);
            fit.likelihood -= 0.5 * visibility.contradiction;
            if fit.agreement >= 0.65 && !visibility.tracking_lost {
                merge(&mut modes, fit);
            }
        }
        modes.sort_by(|a, b| b.likelihood.total_cmp(&a.likelihood));
        modes
    }
}
pub fn same_mode(a: Pose, b: Pose) -> bool {
    a.distance(b) < 0.4 && wrap(a.theta - b.theta).abs() < 0.35
}
fn merge(modes: &mut Vec<Hypothesis>, h: Hypothesis) {
    if let Some(old) = modes.iter_mut().find(|v| same_mode(v.pose, h.pose)) {
        if h.likelihood > old.likelihood {
            *old = h
        }
    } else {
        modes.push(h)
    }
}
pub fn consolidate(hypotheses: Vec<Hypothesis>) -> Vec<Hypothesis> {
    let mut modes = Vec::new();
    for h in hypotheses {
        merge(&mut modes, h);
    }
    modes.sort_by(|a, b| b.likelihood.total_cmp(&a.likelihood));
    modes.truncate(8);
    modes
}
pub fn unique(modes: &[Hypothesis]) -> Option<Hypothesis> {
    let best = *modes.first()?;
    if best.agreement < 0.75
        || modes
            .get(1)
            .is_some_and(|next| best.likelihood - next.likelihood < 0.04)
    {
        None
    } else {
        Some(best)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::map_evidence::Reference;
    fn replay(raw: &str) -> Vec<Hypothesis> {
        let v: serde_json::Value = serde_json::from_str(raw).unwrap();
        let g: Grid = serde_json::from_value(v["grid"].clone()).unwrap();
        let points: Vec<[f64; 2]> = serde_json::from_value(v["points"].clone()).unwrap();
        let evidence = EvidenceMap::new(Reference {
            map_id: "00000000-0000-0000-0000-000000000000".into(),
            revision: "fixture".into(),
            grid: g.clone(),
        })
        .unwrap();
        let matcher = ScanMatcher::new(g);
        let modes = matcher.global(&points, &evidence);
        modes
    }
    #[test]
    fn first_recorded_failure() {
        let m = replay(include_str!(
            "../../../mapping/fixtures/known-position-duplicate-seeds.json"
        ));
        let p = unique(&m).expect("unique known position");
        assert!(
            p.pose.distance(Pose {
                x: 4.5562,
                y: 1.1600,
                theta: 0.
            }) < 0.2
        );
    }
    #[test]
    fn second_recorded_failure() {
        let m = replay(include_str!(
            "../../fixtures/localization-second-failure.json"
        ));
        assert!(
            unique(&m).is_some(),
            "visibility should distinguish the recorded candidates"
        );
    }
    #[test]
    fn identical_modes_are_merged_but_repeated_rooms_are_not() {
        let mut modes = vec![];
        for x in [1., 1.15, 5.] {
            merge(
                &mut modes,
                Hypothesis {
                    pose: Pose {
                        x,
                        y: 1.,
                        theta: 0.,
                    },
                    likelihood: 0.9,
                    agreement: 0.95,
                },
            );
        }
        assert_eq!(modes.len(), 2);
        assert!(unique(&modes).is_none());
    }
}

#[cfg(test)]
mod robustness_tests {
    use super::*;
    use crate::components::map_evidence::Reference;
    #[test]
    fn global_localization_masks_reflections_before_visibility_rejection() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../mapping/fixtures/known-position-duplicate-seeds.json"
        ))
        .unwrap();
        let grid: Grid = serde_json::from_value(v["grid"].clone()).unwrap();
        let points: Vec<[f64; 2]> = serde_json::from_value(v["points"].clone()).unwrap();
        let evidence = EvidenceMap::new(Reference {
            map_id: "00000000-0000-0000-0000-000000000000".into(),
            revision: "mirror-test".into(),
            grid: grid.clone(),
        })
        .unwrap();
        let matcher = ScanMatcher::new(grid);
        let expected = unique(&matcher.global(&points, &evidence)).unwrap();
        let (s, c) = expected.pose.theta.sin_cos();
        let mut corrupted = points.clone();
        let mut changed = 0;
        for p in &mut corrupted {
            let dx = p[0] * c - p[1] * s;
            let dy = p[0] * s + p[1] * c;
            if dx > 0.8 && dy.abs() < dx * 0.7 {
                p[0] *= 2.5;
                p[1] *= 2.5;
                changed += 1;
            }
        }
        assert!(changed > 50);
        let x = ((expected.pose.x + 0.6) / 0.05).floor() as i32;
        let y = (expected.pose.y / 0.05).floor() as i32;
        let cells: Vec<_> = (-12..=12).map(|dy| [x, y + dy]).collect();
        let mask = Boundaries::new(crate::components::reflectance::Model {
            map_id: evidence_id(),
            revision: "test".into(),
            blocked_bins: vec![(0..180).collect(); cells.len()],
            cells,
        })
        .unwrap();
        let modes = matcher.global_with_reflections(&corrupted, &evidence, Some(&mask));
        let found = modes
            .iter()
            .find(|h| h.pose.distance(expected.pose) < 0.15)
            .expect("known location survives reflected returns");
        assert!(found.agreement > 0.9, "{}", found.agreement);
    }
    fn evidence_id() -> String {
        "00000000-0000-0000-0000-000000000000".into()
    }
    #[test]
    fn duplicated_map_requires_more_information_than_one_scan() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../mapping/fixtures/known-position-duplicate-seeds.json"
        ))
        .unwrap();
        let mut grid: Grid = serde_json::from_value(v["grid"].clone()).unwrap();
        let points: Vec<[f64; 2]> = serde_json::from_value(v["points"].clone()).unwrap();
        let offset = grid.width as u32;
        let duplicate: Vec<_> = grid
            .cells
            .iter()
            .map(|p| [p[0] + offset, p[1], p[2]])
            .collect();
        grid.cells.extend(duplicate);
        grid.width *= 2;
        let evidence = EvidenceMap::new(Reference {
            map_id: "00000000-0000-0000-0000-000000000000".into(),
            revision: "repeated".into(),
            grid: grid.clone(),
        })
        .unwrap();
        let modes = ScanMatcher::new(grid).global(&points, &evidence);
        assert!(modes.len() >= 2);
        assert!(
            unique(&modes).is_none(),
            "repeated geometry must not create a confident wrong room"
        );
    }
    #[test]
    fn known_pose_tracks_with_partial_occlusion_without_a_global_reset() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../mapping/fixtures/known-position-duplicate-seeds.json"
        ))
        .unwrap();
        let grid: Grid = serde_json::from_value(v["grid"].clone()).unwrap();
        let points: Vec<[f64; 2]> = serde_json::from_value(v["points"].clone()).unwrap();
        let evidence = EvidenceMap::new(Reference {
            map_id: "00000000-0000-0000-0000-000000000000".into(),
            revision: "test".into(),
            grid: grid.clone(),
        })
        .unwrap();
        let matcher = ScanMatcher::new(grid);
        let original = unique(&matcher.global(&points, &evidence)).unwrap();
        let occluded: Vec<_> = points
            .iter()
            .enumerate()
            .map(|(i, p)| {
                if i % 5 == 0 {
                    [p[0] * 0.6, p[1] * 0.6]
                } else {
                    *p
                }
            })
            .collect();
        let mut prior = original;
        prior.pose.x += 0.05;
        prior.pose.theta += 0.025;
        let tracked = unique(&matcher.track(&[prior], &occluded, &evidence))
            .expect("partial moving clutter still tracks");
        assert!(tracked.pose.distance(original.pose) < 0.12);
    }
}
