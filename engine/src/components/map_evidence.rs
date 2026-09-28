//! Checks observations against a frozen map, before they can reinforce a bad pose.
use super::reflectance::{FilterRequest, Grid, Model};
use super::return_geometry::Pose;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct Reference {
    pub map_id: String,
    pub revision: String,
    pub grid: Grid,
}
pub struct EvidenceMap {
    pub map_id: String,
    pub revision: String,
    grid: Grid,
    cells: Vec<u8>,
    supported: Vec<bool>,
}
#[derive(Debug, Serialize)]
pub struct Agreement {
    pub rays: usize,
    pub known_fraction: f64,
    pub agreement: f64,
    pub contradiction: f64,
    pub conflicting_sectors: usize,
    pub tracking_lost: bool,
    pub revision: String,
}
impl EvidenceMap {
    pub fn new(input: Reference) -> Result<Self, String> {
        Model {
            map_id: input.map_id.clone(),
            revision: input.revision.clone(),
            ..Default::default()
        }
        .validate()?;
        let g = input.grid;
        let n = g
            .width
            .checked_mul(g.height)
            .filter(|&n| n > 0 && n <= 1_000_000)
            .ok_or("Invalid reference dimensions")?;
        if !g.resolution.is_finite()
            || (g.resolution - 0.05).abs() > 1e-6
            || !g.origin.iter().all(|v| v.is_finite())
            || g.cells.len() > n
            || g.cells
                .iter()
                .any(|p| p[0] as usize >= g.width || p[1] as usize >= g.height)
        {
            return Err("Invalid reference grid".into());
        }
        let mut cells = vec![0; n];
        let mut supported = vec![false; n];
        for &[x, y, v] in &g.cells {
            cells[y as usize * g.width + x as usize] = if v > 127 { 2 } else { 1 };
        }
        for &[x, y, v] in &g.cells {
            if v <= 127 {
                continue;
            }
            for dy in -3i32..=3 {
                for dx in -3i32..=3 {
                    if dx * dx + dy * dy > 9 {
                        continue;
                    }
                    let xx = x as i32 + dx;
                    let yy = y as i32 + dy;
                    if xx >= 0 && yy >= 0 && xx < g.width as i32 && yy < g.height as i32 {
                        supported[yy as usize * g.width + xx as usize] = true;
                    }
                }
            }
        }
        Ok(Self {
            map_id: input.map_id,
            revision: input.revision,
            grid: g,
            cells,
            supported,
        })
    }
    fn index(&self, p: [f64; 2]) -> Option<usize> {
        let x = ((p[0] - self.grid.origin[0]) / self.grid.resolution).floor() as isize;
        let y = ((p[1] - self.grid.origin[1]) / self.grid.resolution).floor() as isize;
        if x < 0 || y < 0 || x >= self.grid.width as isize || y >= self.grid.height as isize {
            None
        } else {
            Some(y as usize * self.grid.width + x as usize)
        }
    }
    pub fn evaluate(&self, pose: Pose, points: &[[f64; 2]]) -> Agreement {
        let (s, c) = pose.theta.sin_cos();
        let mut rays = 0;
        let mut known = 0;
        let mut hits = 0;
        let mut conflicts = 0;
        let mut sectors = [false; 36];
        for &p in points {
            let length = p[0].hypot(p[1]);
            if !(0.2..=12.).contains(&length) {
                continue;
            }
            rays += 1;
            let d = [c * p[0] - s * p[1], s * p[0] + c * p[1]];
            let end = [pose.x + d[0], pose.y + d[1]];
            let mut contradiction = false;
            if let Some(i) = self.index(end) {
                if self.supported[i] {
                    known += 1;
                    hits += 1;
                } else if self.cells[i] != 0 {
                    known += 1;
                    contradiction = true;
                }
            }
            // A wall followed by >=15cm of mapped free space before the actual
            // return is contradictory. Unknown space and thick endpoint bands
            // are not evidence of a pass-through.
            let mut occupied_run = 0;
            let mut wall = false;
            let mut clear_run = 0;
            let mut distance = 0.2;
            while distance < length - 0.15 {
                let k = self.index([
                    pose.x + d[0] * distance / length,
                    pose.y + d[1] * distance / length,
                ]);
                match k.map(|i| self.cells[i]).unwrap_or(0) {
                    2 => {
                        occupied_run += 1;
                        clear_run = 0;
                        if occupied_run >= 2 {
                            wall = true;
                        }
                    }
                    1 => {
                        occupied_run = 0;
                        if wall {
                            clear_run += 1;
                            if clear_run >= 3 {
                                contradiction = true;
                                break;
                            }
                        }
                    }
                    _ => {
                        occupied_run = 0;
                        clear_run = 0;
                    }
                }
                distance += self.grid.resolution;
            }
            if contradiction {
                conflicts += 1;
                let b = ((p[1].atan2(p[0]).rem_euclid(std::f64::consts::TAU)
                    / std::f64::consts::TAU
                    * 36.) as usize)
                    .min(35);
                sectors[b] = true;
            }
        }
        let agreement = if known > 0 {
            hits as f64 / known as f64
        } else {
            0.
        };
        let known_fraction = known as f64 / rays.max(1) as f64;
        let contradiction = conflicts as f64 / rays.max(1) as f64;
        let conflicting_sectors = sectors.iter().filter(|&&v| v).count();
        // Permit exploration into unknown cells and local furniture changes.
        // Require distributed contradictions, not one reflective panel.
        let tracking_lost = rays >= 100
            && known >= 80
            && ((agreement < 0.65 && contradiction > 0.25)
                || (contradiction > 0.4 && conflicting_sectors >= 12))
            && conflicting_sectors >= 6;
        Agreement {
            rays,
            known_fraction,
            agreement,
            contradiction,
            conflicting_sectors,
            tracking_lost,
            revision: self.revision.clone(),
        }
    }
    pub fn check(&self, input: &FilterRequest) -> Result<Agreement, String> {
        input.validate()?;
        if input.map_id != self.map_id {
            return Err("Reference map mismatch".into());
        }
        Ok(self.evaluate(input.pose, &input.points))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn room() -> EvidenceMap {
        let cells = (0..101)
            .flat_map(|x| {
                (0..101).map(move |y| {
                    [
                        x,
                        y,
                        if x == 0 || y == 0 || x == 100 || y == 100 {
                            129
                        } else {
                            127
                        },
                    ]
                })
            })
            .collect();
        EvidenceMap::new(Reference {
            map_id: "48831c8a-3910-4c10-b560-e4a21f8a3bca".into(),
            revision: "test".into(),
            grid: Grid {
                resolution: 0.05,
                width: 101,
                height: 101,
                origin: [-2.525, -2.525],
                cells,
            },
        })
        .unwrap()
    }
    #[test]
    fn dense_wrong_pose_cannot_validate_itself() {
        let m = room();
        let points: Vec<_> = (0..360)
            .map(|i| {
                let a = i as f64 * std::f64::consts::TAU / 360.;
                let (s, c) = a.sin_cos();
                let r = 2.5 / s.abs().max(c.abs());
                [r * c, r * s]
            })
            .collect();
        assert!(!m.evaluate(Pose::default(), &points).tracking_lost);
        assert!(
            m.evaluate(
                Pose {
                    x: 1.,
                    y: 1.,
                    theta: 0.4
                },
                &points
            )
            .tracking_lost
        );
    }
    #[test]
    fn recorded_divergence_is_rejected_without_rejecting_earlier_drive() {
        let sample: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/tracking-divergence.json")).unwrap();
        let map =
            EvidenceMap::new(serde_json::from_value(sample["reference"].clone()).unwrap()).unwrap();
        for value in sample["frames"].as_array().unwrap() {
            let frame: super::super::reflectance::Keyframe =
                serde_json::from_value(value.clone()).unwrap();
            let (s, c) = frame.pose.theta.sin_cos();
            let points: Vec<_> = frame
                .points
                .iter()
                .map(|p| {
                    let x = p[0] - frame.pose.x;
                    let y = p[1] - frame.pose.y;
                    [c * x + s * y, -s * x + c * y]
                })
                .collect();
            let result = map.evaluate(frame.pose, &points);
            assert_eq!(
                result.tracking_lost,
                value["lost"].as_bool().unwrap(),
                "frame {}: {:?}",
                frame.id,
                result
            );
        }
    }
    #[test]
    fn unknown_space_is_not_a_wall_or_localization_failure() {
        let m = room();
        let a = m.evaluate(
            Pose {
                x: 20.,
                y: 20.,
                theta: 0.,
            },
            &vec![[1., 0.]; 200],
        );
        assert!(!a.tracking_lost);
        assert_eq!(a.known_fraction, 0.);
    }
}
