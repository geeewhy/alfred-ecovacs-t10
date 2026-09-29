# Native point navigation and obstacle recovery

Return-to-station and arbitrary map goals share the Rust Navigator and the existing motor ownership gate. HQ prepares the map and starts an operation; it does not stream navigation commands.

The planner overlays measured LiDAR endpoints on the saved grid, inflates obstacles for the robot footprint, replans A* routes, and scores differential-drive trajectories over a 1.5 second horizon. Scan points are deskewed and transformed using the acquisition pose. Measured free rays clear remembered endpoints; elapsed time or turning away does not. Observed free floor can fill unknown cells, but cannot erase saved occupied cells or installed reflection boundaries.

When the destination is disconnected, the engine tries up to four distinct reachable approach points, checking the route again with subsequent scans. When no further checked approach exists it waits for changed observations, within the existing 300 second operation deadline. It cannot promise passage through a physically closed route. Sensor and contact safety guards remain active. The calibrated final docking controller and charging confirmation remain unchanged.

## Interfaces

- Native `POST /v1/navigation`: `{ "map_id": "...", "pose": { "x": 1, "y": 2, "theta": 0 } }`.
- Native `GET /v1/navigation`, `POST /v1/navigation/stop`.
- HQ `POST /api/maps/{id}/navigate`: `{ "x": 1, "y": 2, "theta": 0 }` prepares the map then hands off.
- Existing onboard-return interface uses the same planner before dock entry.

Coordinates and heading are metres/radians in the installed map. Generic goals require traversable saved floor. No new map click-to-go UI is included. New statuses include `navigating`, `checking-approach`, `replanning`, `goal-alignment`, and `arrived`.

## Validation and limits

61 Rust tests and 77 HQ tests pass. Navigation simulations cover complete chair and U-obstacle detours, an obstacle appearing after planning, measured clearing, unknown-floor evidence, and bounded recovery for a fully blocked goal. HQ checks map handoff, cancellation and invalid destinations.

`alfred-engine --navigation-replay MAP_JSON INPUT_JSON` runs the planner without constructing motor services. Recorded Primary scan replay artifacts are under `artifacts/hq/navigation-replanning/` (local, untracked). This scan disconnects the saved route; the planner produces a reachable alternate approach. This is not a completed physical return trial.

Trajectory sampling is inspired by the [dynamic-window approach](https://publications.ri.cmu.edu/the-dynamic-window-approach-to-collision-avoidance); measured marking and clearing follow the established [obstacle-layer pattern](https://docs.nav2.org/jazzy/configuration_and_development/configuration_guide/core_servers/costmap_2d/costmap_plugins/obstacle/). This implementation does not yet model calibrated acceleration/braking limits. Maximum planned forward speed is 0.22 m/s. Physical validation remains user-triggered; mirror-model repair is a separate unfinished task.

Deployed binary MD5: `cf979783bf30e1595cef44b37fba029a`. On-device recorded replay took 87 ms for initial scan processing and planning, producing a 27-point alternate approach. This exceeds one 50 ms controller period; it is an initial planning measurement, not a sustained-loop timing guarantee. Authenticated health and navigation status passed after deployment, with navigation idle. Station coordinates were verified unchanged. Recovery binary: `/data/alfred/alfred-engine.before-navigation-replanning`.
