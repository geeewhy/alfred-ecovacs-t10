# Shared native localization

Saved-map localization, continuous wheel-seeded scan matching and automatic global recovery now belong to `engine/src/components/localization.rs`. The authenticated `/v1/localization` status and locate operation, and `/v1/localization/map` installation, are independent of HQ heartbeats and the mapping container. Map configuration persists across engine restarts; a pose does not survive a restart as trusted truth.

HQ still runs SLAM Toolbox for initial unknown-map construction, graph optimization and scan stitching. On saved maps its ROS adapter consumes the engine pose, publishes map-to-odometry, seeds the graph builder, and holds map writes when the builder disagrees. Ordinary Locate does not start the graph builder. Onboard return consumes the same engine position service. The pre-existing HQ-guided return remains available.

## Research and implementation choices

- Olson, *Real-Time Correlative Scan Matching* (2009): https://april.eecs.umich.edu/media/media/media/pdfs/olson2009icra.pdf — supports using a spatial correlation search with an odometry prior, and broader search when that prior is unavailable. Our implementation uses bounded coarse-to-fine search; it is not the paper's exact implementation or a guaranteed global optimizer.
- Nav2 AMCL configuration: https://docs.nav2.org/rolling/configuration_and_development/configuration_guide/others/configuring_amcl/ and its likelihood-field source https://github.com/ros-navigation/navigation2/blob/jazzy/nav2_amcl/src/sensors/laser/likelihood_field_model_prob.cpp — motivate distance-field observation scores, handling partial disagreement, and recovery rather than rejecting a location from a single failed scan. This implementation retains distinct deterministic hypotheses; it is not a particle filter and its score is not a calibrated probability.
- Cartographer's correlative matcher: https://github.com/cartographer-project/cartographer/blob/master/cartographer/mapping/internal/2d/scan_matching/real_time_correlative_scan_matcher_2d.cc and frame terminology https://google-cartographer.readthedocs.io/en/latest/terminology.html — inform separating local tracking, global correction and odometry frames.

The matcher evaluates coherent endpoints against a precomputed distance field. It additionally penalizes rays crossing occupied map cells: a dense endpoint match alone can select a wrong room. Local tracking searches around wheel-propagated poses; recovery keeps separated candidate locations and periodically repeats global search. Converged optimizer starts are merged into one hypothesis. Competing locations remain unresolved until observations distinguish them. Hypothesis-specific reflection filtering does not erase a beam merely because it disagrees with another candidate.

Each scan is deskewed using robot-source wheel timestamps. Completed matches are transformed from acquisition odometry into current odometry. Freshness uses local monotonic receive times, not HQ-to-robot clock synchronization. Four distinct, consistent scans establish initial authority while retaining competing candidates. Missing/stale sensors withhold the pose without a permanent failed state. A single bounded worker computes matches; map/reset generations discard stale results without creating overlapping blocking workers.

## Validation and limits

Replay fixtures include both reported saved-map localization failures, partial clutter, duplicate candidates, coordinate propagation, sweep deskew, and reset invalidation. The second failure has no independently measured physical ground truth; candidate separation is a regression check, not a measurement of absolute accuracy.

Search spacing, candidate limits, agreement thresholds and visibility weight are engineering parameters, not universal guarantees from the papers. A single planar LiDAR cannot reliably identify every mirror or resolve identical rooms from one stationary view. New views or a trustworthy motion prior are needed in genuinely ambiguous geometry. Floor-plan reconstruction and robust multi-session map optimization remain HQ work. Physical driving and docking regression require a separate user-controlled trial.

## Device verification (2026-09-28)

Deployed engine MD5 `34c61420679c2b74f011ab99218c2173`. 45 native tests, 74 mapping tests and 73 HQ tests passed. Stationary engine recovery produced a pose near (6.30, 1.60, 1.16 rad), about 83–84% endpoint agreement. Tracking continued with the mapping container stopped (observed scan ages 83–244 ms); HQ's position endpoint still returned that engine pose. After an engine restart with the mapping container stopped, the persisted map was reloaded and localization recovered without an HQ initialization request. The graph builder separately accepted the engine pose on resume and cleared its write hold; capture was then paused. Evidence is under `artifacts/hq/engine-localization/`.

No wheel-motion trial was initiated. The first cold search took tens of seconds before establishing a unique estimate. These checks establish stationary integration and independence, not guaranteed moving accuracy or docking success. The saved station coordinates were unchanged.

## Intermittent jumps near mirror (follow-up)

The first live sequence showed tracking loss followed by global reacquisition; wheel counters accounted for most subsequent movement. A later stationary mirror-area capture varied only a few centimetres. Neither capture supplies independent physical ground truth or proves reflection as the cause of every reported jump.

Fixed two recovery defects: a tentative first match no longer collapses the candidate set, and rejected scans no longer erase the last verified wheel-propagated prior. Recovery candidates must remain within a bounded motion-error envelope of that prior; explicit Locate, a different map, or wheel/boot discontinuity can reset it. This assumes wheel-observed motion, so carrying the robot requires Locate. Same-map revisions preserve continuity. Local matching also penalizes corrections away from the wheel prediction to reduce scan-noise drift; displayed coordinates are not merely smoothed.

Sequence regressions cover alternating candidate locations, lost scans followed by a high-scoring wrong room, recovery near the prior, wheel propagation and explicit relocation. 51 native tests passed. Mirror-area raw captures: `artifacts/hq/pose-jumps-1790637846998290000/`.

Recovery consensus now uses up to eight fresh candidate sets: a winner must remain spatially consistent for at least four scans, with mean score lead greater than both 0.01 and twice the observed lead standard deviation. There is deliberately no square-root-of-sample-count confidence multiplier, since stationary sweeps are correlated. This is an empirical stability rule, not a calibrated probability. The recorded 23-frame mirror-area candidate sequence now resolves its persistent winner; equal and alternating room candidates remain unresolved. The expected position in that regression reflects candidate stability, not independent physical ground truth.

Final follow-up deployment MD5 `69f983a9545089f02d933c34da36eacf`. At the current mirror-area view, all 30 stationary checks returned a located pose; maximum pairwise translation difference was 0.01768 m with zero wheel delta. This does not establish moving-past-mirror accuracy. Final evidence: `artifacts/hq/pose-jumps-1790637846998290000/final-verification.json`.
