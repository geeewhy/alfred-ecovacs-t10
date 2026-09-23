# Native mapping investigation

Production mapping now uses SLAM Toolbox; see [Maps](maps.md). Native SLAM supplied useful maps/poses but its loop-closure scan relay emitted no frames, and global relocation was not verified within the bounded audit. Keep these probes for diagnosis, not as the production navigation path.

- Native map arrays are column-major (`x * height + y`): signed positive = free, negative = occupied, zero = unknown. Snapshot/load preserves the paired main and close-range maps.
- Wheel counters are cumulative, consistent with millimetres in short comparisons. Effective wheel separation is approximately 243 mm. Independent distance/angle and LiDAR extrinsic calibration remain open.
- Full ordered LiDAR and wheel timestamps use device uptime. The bridge deskews using wheel history and estimated sweep timing; the end-of-sweep timestamp assumption still needs physical verification.
- Native backend subscribed to `/lds/LdsWidthPose`; the apparent upstream topic `/lds/LdsWidthPose0` produced no relay frames even during movement. Production disables this experimental relay.
- Explorer source is pinned to `326cf8a0b487c34246bb8f3326afbcd69576dc60`. Its patch selects boundary targets and holds accepted goals until completion or a progress timeout.

Read-only recorder: `python3 tools/mapping_record.py --seconds 8 --label stationary`. Summarize with `python3 tools/mapping_record_summary.py <recording.jsonl>`. Native firmware schemas and probe artifacts remain under `artifacts/firmware/`; recordings under `artifacts/hq/mapping-runs/`.

### Resume and small-threshold recovery

SLAM Toolbox must set `check_min_dist_and_heading_precisely: true`: its default distance-only prefilter can reject turns in place even when `minimum_travel_heading` is configured. `restamp_tf: true` keeps the map transform available between accepted scans; independent wheel/LiDAR freshness and unmatched-motion limits still gate driving. See the [upstream scan and transform implementation](https://github.com/SteveMacenski/slam_toolbox/blob/ros2/src/slam_toolbox_common.cpp).

HQ stops on a telemetry fault and allows at most five seconds for fresh data, then pauses with the actual cause. Localization/navigation preparation is bounded to fifteen seconds. A converging warm localization estimate keeps its remaining budget instead of being reset to global search at four seconds; confidence thresholds are unchanged.

`mapping/motion_recovery.py` detects forward commands without scan-matched progress. It reverses about 10 cm at 60 mm/s, then makes one 160–200 mm/s approach, bounded to two seconds / 32 cm, only without bumper contact or a supported wall ahead. Rear blockage, cliff/lift, stale sensors or inability to retreat stops recovery. A failed retry turns away and adds temporary obstacle evidence. Tests: `python3 -m unittest discover -s mapping -p 'test_*.py'`. Real threshold clearance still needs observation; successful ordinary travel does not prove it.

### Speed and coverage verification

Jazzy DWB caches the squared XY speed limit incorrectly during a dynamic `max_speed_xy` update ([upstream callback](https://github.com/ros-navigation/navigation2/blob/jazzy/nav2_dwb_controller/dwb_plugins/src/kinematic_parameters.cpp)). Send `min_speed_theta=0.0` after the speed parameters to refresh it. `tools/nav2_refresh_speed.py` repairs a running controller without interrupting SLAM; `tools/nav2_speed_probe.py` verifies actual candidate speeds. The live fix raised the fastest usable candidate from 106.7 to 160 mm/s, with median measured cruise 160.5 mm/s.

Continuous verification on Test 1 grew observed occupancy from 35.56 to 50.99 m² (1,229 recorded scans, ~28.3 m estimated travel). Bounded Nav2 planning/control retries recovered previously rejected routes. The end-state audit found eight frontier boundaries in disconnected free-space components; HQ now preserves them as unresolved instead of falsely completing the entire map. `tools/nav2_frontier_probe.py` independently audits this. Remaining routes and physical geometry accuracy are still unverified.

### Corner inspection and consolidated structure (2026-09-23)

When frontier exploration exhausts its current routes, the bridge now tries up to four reachable observation positions around occluded boundaries/corners. Positions come from the robot's connected component of the live inflated costmap; each is separated from previous attempts. Nav2 owns the approach, then a bounded turn gathers another view before a fresh explorer retries its goals. Stop, bumper/stall recovery, cliff/lift, stale telemetry and the HQ lease still cancel movement. This does not make blocked cells traversable.

Cruise is persisted at 200 mm/s. The extra approach limiter now needs a coherent nearby surface within 360 mm of the LiDAR, instead of any single return within 500 mm. Approach remains 80 mm/s; Nav2 still checks the robot footprint.

Structural plan version 2 rebuilds geometry from each current corrected snapshot, merges overlapping supported collinear edges and joins supported nearby corners. Old unmatched fits no longer accumulate forever. Doorway gaps and free-space contradictions remain constraints. This is presentation geometry, not navigation occupancy. Existing maps can be rebuilt without losing areas/edits using `node tools/mapping_rebuild_structure.mjs <map-id>` while capture is paused; it backs up the map first.

Live Test 1 validation: `artifacts/hq/mapping-runs/1790195502567-explore.json` contains 542 sensor samples. Cruise median was 199.7 mm/s (190 samples commanded at ≥190); estimated travel excluding large SLAM corrections was 14.81 m. Corner inspections escaped the initial small component, bumper contact triggered back/turn recovery, observed occupancy grew 50.99→56.37 m², and remaining disconnected boundaries fell 8→2. The map is paused, not complete. Rebuilt current geometry has 31 segments versus the original 127 accumulated fits. Continuous-surface RANSAC scoring also fixes lost perpendicular walls caused by combining scattered collinear points across rooms. Complete architectural coverage/accuracy remains unverified.

Connected floor presentation now derives closed polygons from observed free space, preserves holes and disconnected regions, simplifies/regularizes boundaries, and renders likely walls, obstacles and unscanned edges separately. Only long near-axis multi-view structural edges promote a boundary to likely wall; this is a heuristic, not furniture recognition. Current LiDAR API exposes x/y/power, no height. Navigation still uses occupancy, never the simplified floor geometry.

Locate now uses the saved-pose hint too (it previously forced a global particle search). A bounded local scan fit seeds AMCL without bypassing covariance/particle/overlap validation. On Test 1 it improved the initial scan fit from ~67% to ~95%; SLAM then disagreed with AMCL by ~26 cm. Stationary confirmation now waits for agreement rather than requiring three accepted SLAM poses, which its motion filter suppresses. Correlation search is bounded to .2 m with .15 rad coarse angular search and response expansion disabled. These final changes need a robot-connected Locate validation; the robot link dropped before that check.

Verified after the next robot reboot: ADB shell was online and engine PID existed, but `adb forward --list` was empty. Mapping wake now calls EngineClient.connect() before any mutation to restore the port forward. HQ Locate then completed with 0.96494 scan agreement, paused/located state and no error; wheels remained stopped. This also validates the saved-pose seed and stationary SLAM confirmation changes above on Test 1.
