# Map evidence and recovery — 2026-09-28

The reported duplicate section was appended after tracking diverged. Shared historical graph poses were unchanged. Scans through graph ID 2610 agreed consistently with the earlier map; later scans lost agreement while insertion continued. The initiating physical cause is not established: mirror reflections, scan matching and odometry must not be conflated with a proven root cause.

Primary was restored to graph-recovered-1790635250474585000, retaining 1306 exported frames through ID 2610. Archive save/reload preserved retained poses. Station coordinates remain (4.656772977429757, -1.7314394155166462, 1.6378575563211577). Backups and replay evidence are in artifacts/hq/pose-jump-1790634624738185000/.

The native Rust map_evidence component checks scan endpoints and independent wall crossings against a frozen map reference. Distributed disagreement suspends scan insertion before the offending scan reaches SLAM. HQ owns graph restoration and stationary relocalization, with two recovery attempts; unresolved location keeps map writes blocked. Unknown space is neutral. The adapter now associates matched poses with odometry at the exact scan acquisition timestamp, rather than callback arrival time. HQ displays recovery as locating and clears the unverified marker.

The reference is installed through authenticated /v1/mapping/reference and evaluated through /v1/mapping/evidence. It is ephemeral; the adapter reinstalls it after engine restart. Native reflection models have separate persisted, map-specific storage. Reflection inference currently produces proposals only: Primary has no automatically installed inferred boundaries. The inferred floor plan and mirror classification are not validated as ground truth. A new map without a frozen reference does not yet receive the same protection as resumed maps.

Validation: 36 Rust tests, 69 mapping tests, 71 HQ tests; six recorded scans also replayed through the deployed robot HTTP API, accepting three aligned scans and rejecting three divergent scans. This demonstrates the recorded regression, not universal localization accuracy. A stationary post-deployment location attempt failed because no fresh LiDAR arrived; map writes remained held. No physical drive trial was initiated.

Deployed engine MD5: 03bb802cf8a2ac4980f1fa940e8d59e5. Device backup: /data/alfred/alfred-engine.before-map-evidence. Mapping container recreated. Full Docker rebuild encountered apt disk-space exhaustion; the exporter was compiled in the existing image and installed through a small image overlay without pruning unrelated data.

## Research direction for floor reconstruction

Directional reflectance uses repeated observations from different angles to identify transparent or reflective boundary candidates; density alone does not establish a mirror. Our implementation adapts this idea, not the paper's benchmark results: https://web.eecs.umich.edu/~kuipers/papers/Foster-icra-23.pdf

ROSE² directly addresses cluttered 2D occupancy grids using dominant structural orientations, supported line segments and room segmentation: https://arxiv.org/abs/2203.03519 . This is a relevant HQ reconstruction direction, not an implemented feature. Inferred occluded walls must remain separate from measured collision evidence.

## Known-position localization regression (same day)

Saved evidence: artifacts/hq/localization-failure-20260928/. A fresh 630-point scan produced a 95.83% global fit, but two optimizer starts converged to the same basin (22cm apart), incorrectly consuming the distinct-location ambiguity margin. Post-refinement basin consolidation restores a .0909 margin against genuinely distinct alternatives. The search budget is now 8 seconds to accommodate all four distinct fits rather than discarding completed work at the previous 3.5-second limit. Acceptance thresholds are unchanged.

Also removed scan starvation when TF/display pose is unavailable: wheel projection of the last matched pose supplies an admission hypothesis, still checked by native map evidence before insertion. Missing projection starts recovery instead of silently withholding all future scans.

73 mapping tests pass, including the recorded scan, genuinely repeated rooms, absent-TF recovery and rejection of contradictory projected scans. Mapping container restarted. Live stationary localization succeeded at x4.5562,y1.1600,theta-.14759 with .96044 scan agreement; saved graph confirmed the pose. Capture paused afterward, no wheel movement commanded. Pause HTTP response exceeded the client timeout during checkpointing, but subsequent status confirmed capture=false and location=located. This deployment changes HQ/ROS mapping logic, not the onboard binary.
