# Engine-owned return to station

The working HQ-guided return remains available as **HQ-guided return (backup)**.
**Return onboard** installs the selected saved map/station on Alfred, pauses the
companion, and starts a Rust-owned operation. HQ and the mapping companion are
not part of that operation's control loop and may disconnect afterward.

The robot stores `/data/alfred/state/return-map.json`. Rust reads local ROS wheel,
LiDAR and safety telemetry; local charging queries use monotonic freshness.
It localizes against the saved occupancy map, routes through known free space
with the robot footprint inflated, positions in front of the station, turns its
rear toward the wall, and reverses at 100 mm/s through ramp entry. Charging
contact stops motion and must persist for one second to confirm completion.
The distant approach allows 150 mm/s. Fine enclosure recognition is not a gate.

The ordinary 350 ms motor deadman stays enabled. The onboard control loop renews
it; HQ does not. Explicit Stop cancels the operation and any pending localization.
Manual and companion wheel requests are rejected while onboard return owns motion.
An engine restart starts idle rather than resuming a previous motor operation.

Authenticated direct API (same bearer token as other engine routes):

- `PUT /v1/return/config`: map ID, grid dimensions/resolution/origin, sparse
  cells (`127` free, `129` occupied), verified station pose, enclosure points.
- `POST /v1/return`: start; repeated start while active returns the existing run.
- `GET /v1/return`: operation state, message, map ID, onboard pose, match score,
  contact retries and elapsed time.
- `POST /v1/return/stop` or `POST /v1/drive/stop`: cancel and stop wheels.

After initial map installation, direct start needs no HQ, Docker, or ADB.
The current version stops on ambiguous localization, persistent obstruction,
unsafe telemetry, lost tracking, or lack of progress. It does not rebuild the map
or explore unknown routes. Three hundred seconds bounds an attempt. Map changes
in HQ take effect on the robot when Return onboard installs that map again.

Validation includes the recorded oblique dock scan against the real Primary map,
collision-free route generation, a complete synthetic rear-facing return,
expected dock-side versus unexpected obstacle checks, cancellation, and HQ setup
cancellation. An offline target-processor replay can be run with:

```
/data/alfred/alfred-engine --return-replay MAP_JSON SCAN_JSON
```

That mode creates no ROS publishers, motor service, or HTTP server. Replay and
simulation do not substitute for a complete physical onboard return trial.

2026-09-27 first user attempt reached the engine and localized (score .962),
then failed before movement: station approach outside traversable map. HQ Locate
had overwritten the established station with a measured-departure inference
(x6.555,y-2.023,theta2.476 instead of x4.657,y-1.731,theta1.638). Grid cells and
coordinates were otherwise unchanged. Restored the successful-docking station in
HQ and engine config. HQ now retains existing landmarks through ordinary Locate,
charging observations, display and checkpoint writes; only explicit Locate station
can replace one. Regression reproduces the exact engine failure with the corrupt
station and verifies routing with the preserved landmark from the reported robot
pose. 36 HQ / 20 Rust tests pass. User triggers the next physical onboard run.

Ramp oscillation revision: the Rust port had stateless entrance clearance: it
switched from 25 mm/s forward to staging as soon as outward distance crossed
30 cm, then headed back into the entrance. DockController now latches clearance
until 42 cm and uses 100 mm/s for clearance/reseating/near staging. Reverse entry
remains continuous at the successful 100 mm/s. Rear alignment also has explicit
state and a compatible 5 cm entry tolerance while aligning, eliminating a
threshold stall found by the full-sequence simulation. 22 Rust tests pass,
including noisy 30 cm boundary replay and complete entry. Phase transitions and
holds now log local geometry/velocity/pose for whole-run diagnosis. The reported
attempt ended on a rear obstruction; a later scan contains unmatched close rear
points but is not synchronized evidence of the failure. Collision checks remain
in place. Physical improvement requires the user's next complete attempt.

### Near-enclosure position and false obstruction (2026-09-27)

Two recorded failures exposed missing near-dock behavior in the Rust port. The first stopped before motion because a roughly 4 cm map registration error made the dock side appear to be an independent rear obstacle. The next reached the enclosure but failed with room-map score 0.53125 and `Waiting for a verified map position`.

The engine now fits the saved enclosure near the known station, bounded to 6 cm / 0.15 rad from its tracked pose. A supported three-surface match independently maintains position when the room becomes occluded; it does not move the saved station. If no local fit is supported, normal room-map tracking remains available. The same refined pose feeds steering and dock-surface collision classification. Charging contact, sustained for one second, remains the success condition. Recorded-scan tests check false-obstruction removal, independent rear-obstacle rejection, and continued reverse entry despite room occlusion.

The fit uses exact nearest-neighbor x-axis pruning to reduce CPU time; offline replay constructs no motor publishers. Physical docking remains to be retried by the user.

### Reverse ramp drive (2026-09-30)
Reverse entry now stays at 150 mm/s through the ramp. Final seating previously dropped to 25 mm/s based solely on estimated contact proximity; it now uses 100 mm/s reverse pulses (600 ms on, 400 ms dwell), retaining gentle yaw correction, brief release, 8 cm / 0.12 rad / 12 s bounds and immediate stop on charging. Obstacle checks remain active. All 74 engine tests pass; physical ramp performance still requires a return trial. The observed run also had contact-seating obstacle holds and ultimately failed localization recovery, so the velocity change does not establish those separate failures are resolved.

### Docked navigation departure (2026-09-30)
Fresh charging contact plus the same map’s saved station establishes the initial localization pose before a point-navigation departure. This invalidates older asynchronous search results and seeds the existing wheel/lidar tracker; it does not change station coordinates. The controller exits straight through the dock mouth to 42 cm before room route planning, retaining forward obstacle and safety checks. Live kitchen retry cleared the dock and transitioned to navigating, with scan agreement approximately0.96.

### Continuous scan handoff (2026-09-30)
The kitchen departure trace contained repeated scan-motion-alignment holds while position remained located. Navigation previously required the newest scan to fit wheel history immediately; asynchronous arrivals exceeding the 30ms interpolation allowance stopped wheels. It now retains the previous coherent deskewed scan up to500ms of original receipt age while newer odometry catches up. Reused frames retain their actual sequence (no repeated obstacle evidence); current raw scan collision checks remain independent. Map/localization invalidation clears the cache. A regression exercises ahead-of-history arrival, catch-up, expiration and invalidation. The kitchen trial successfully departed but later failed localization recovery before reaching its goal; that later failure is not established as fixed by this handoff change.

### Shared bumper escape (2026-09-30)
Both map-goal navigation and return use the same bounded contact-recovery state machine. Fresh front-bumper contact interrupts normal planning, reverses straight for40mm to unload contact, then applies a shallow0.25rad/s turn away from the pressed side at100mm/s reverse. Both-side contact alternates turn direction. Each attempt ends on release after60mm clearance,120mm travel,0.35rad rotation or2s; at most three attempts per operation. After escape the route is invalidated and replanned toward the original goal. Rear lidar coverage/clearance is required on every tick; unknown/stale sensors hold, cliff and wheel-lift signals stop with distinct reasons. Recovery needs no map localization and does not overwrite position.78engine tests pass including travel/time/yaw limits and blocked/unknown rear rejection.

Live recovery trial: the previously pressed right bumper cleared and route planning resumed. Return subsequently stopped on localization recovery failure after45.6s; successful docking was not verified.
