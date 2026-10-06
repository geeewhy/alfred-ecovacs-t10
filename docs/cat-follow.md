# Onboard cat follow

Maps → Robot → **Find cat** starts an engine-owned operation. **Stop cat mode**, the normal movement stop, or a voice stop cancels it. HQ only installs the saved map and sends the start request; camera processing, search, tracking and motion continue on Alfred without HQ. Engine restarts leave it inactive.

The tracker detects dark moving connected regions in reduced-resolution JPEG frames, with two-frame motion confirmation while encoder readings show the robot stationary. It rejects broad image changes such as exposure shifts. Once acquired it associates the dark region between frames. This is deliberately a dark-object tracker, not semantic cat identification; other dark moving objects and reflections can fool it.

Search selects a traversable viewpoint in each world-aligned 1 × 1 m tile of the known map, nearest first. At each viewpoint it looks in four directions, pausing 2.5 seconds per direction. Navigation uses the existing obstacle planner. Search wheel speeds are capped at 50 mm/s; tracking at 200 mm/s. Turns preserve the wheel-speed cap. No cleaning task or voice announcement is started. Mechanical drive/LiDAR noise still exists.

Pursuit stops advancing when the target appears close or leaves the camera, when the camera is older than 700 ms, or when the mapped footprint/raw LiDAR corridor is blocked. Target loss gets a stationary reacquisition pause before search resumes. Cliff/lift interlocks remain active; bumper contact stops cat mode. Localization must be valid. A cell gets at most 90 seconds; blocked cells are reported as skipped, never checked. A search run is bounded to one hour or one pass through the eligible cells.

The map shows a purple last-seen marker and uncertainty circle. Range is **approximate**, derived from a nominal 30 cm apparent target width and 110° camera field of view, not calibrated depth. The marker is not a destination or clearance measurement. Sightings are map-scoped, timestamped and saved onboard at most once per second in `/data/alfred/state/last-cat.json`. It survives stopping/restarting and stays labelled last-seen, not live ground truth.

Authenticated engine API:
- `POST /v1/cat-follow` with `{"map_id":"…"}`
- `GET /v1/cat-follow` (shared navigation status, nested `cat`)
- `POST /v1/cat-follow/stop`

The live camera has been inspected. Synthetic motion, static-background, exposure-change, loss, close-target and search-cell tests cover the algorithm; real-cat detection/following still requires an observed trial. Low light, occlusion, black furniture and the camera's uncalibrated optics limit reliability.
