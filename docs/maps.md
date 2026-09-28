# Maps

Run Docker, build once with `python3 setup/mapping.py --build`, then start with `python3 setup/mapping.py --start`. Build output: `artifacts/hq/mapping-build.log`. Later builds reuse installed ROS packages; `--build --fresh` rebuilds dependencies. HQ starts the installed companion automatically. Engine forwarding uses localhost:48765; the companion uses localhost:48766.

New map → Start scan explores automatically. Manual capture records while you drive from Cockpit. Pause, Stop movement, Space, or manual driving cancels autonomous motion. Finish saves; Resume extends a saved map. Locate Alfred verifies its position before navigation. Ambiguous matches remain stopped. Battery at 10% or lower prevents exploration.

Production mapping uses SLAM Toolbox, wheel odometry, Nav2 DWB, and explore_lite. AMCL locates against saved occupancy before loading the graph at the accepted pose. Warm restore is device-tested; relocation from arbitrary positions and a complete physical loop remain acceptance work. Legacy native maps remain viewable/editable and support manual capture; create a new map for automatic exploration.

Settings → Mapping controls cruise and approach speeds (defaults 120/60 mm/s), including while the robot is offline. Supported walls guide navigation; bumper contact causes a bounded reverse and turn away. Cliff/lift, stale sensors, missing position, lost HQ heartbeat, and repeated contact stop movement. The engine has a 350 ms deadman; the companion lease expires after three seconds.

Floor plan derives walls from corrected saved-graph scans, with annotations, upright labels and aligned dimensions. Measurements toggles the occupancy/trajectory overlay. Rotation aligns the drawing without changing navigation coordinates. Draw/name areas, split, merge, edit corners, annotate doors/windows, undo/redo and export PNG/SVG. Unknown gaps remain open; annotations do not alter navigation occupancy.

HQ maps/checkpoints: `artifacts/hq/maps/` (every two seconds). SLAM graph pairs and manifests: `mapping/state/maps/` (every 15 seconds and on pause). Settings: `mapping/state/settings.json`. Delete archives HQ files and graphs in each store's `deleted/` directory. Preserve both stores for backup.

Checks: `node --test hq/test/*.test.mjs`, `python3 -m unittest discover -s mapping/test`. Calibration: `node tools/mapping_motion_test.mjs forward --speed=120 --seconds=2` (compare against a physical mark). Bounded device run: `node tools/mapping_explore_test.mjs [map-id] --seconds=15`; it pauses in `finally`. Evidence: `artifacts/hq/mapping-runs/`. See the thread's mapping rebuild plan for remaining physical acceptance gates.

### Deep pass

Choose **Deep pass · verify all walls**, then **Resume** on a saved map. Alfred builds a persistent checklist along walls, obstacle contours and unconfirmed edges, roughly every 1.5 m, merging checks within 1 m. The map shows green checked sections, amber pending sections and blue current targets. The scan duration remains a time budget; Resume keeps completed checks and retries unfinished sections.

Deep pass approaches reachable viewpoints across the entire map, aligns using the actual surface bearing, and uses bounded checks at up to 100 mm/s, slowing to 55 mm/s near the target or a full scan sweep at unknown edges. Bumper contact ends the check and triggers backing away. A checked section records a close observation or contact, not proof that an object is an architectural wall. Unreachable sections remain unfinished; running out of routes does not mark the pass complete.

For a bounded supervised validation: `node tools/mapping_explore_test.mjs MAP_ID --deep --seconds=90`.

Current faster mapping settings: cruise 300 mm/s, approach 140 mm/s; close checks use up to 100 mm/s and slow to 55 mm/s near the target. Deep pass uses 1.5 m spacing and merges nearby checks within 1 m. Old pending checklists are rebuilt on Resume; completed checks are retained.

Stationary localization diagnostics: `python3 tools/localization_model_probe.py MAP_ID`
compares AMCL likelihood-field and beam models without commanding wheels, pauses
on exit, and restores the configured likelihood-field profile. Results are saved
in `artifacts/hq/localization/model-comparison.json`. The docked Primary run did
not converge under either model; switching models is not a validated fix.
`tools/mapping_location_audit.py MAP_ID OUTPUT.json` saves the live scan and map
alongside endpoint/visibility candidate scores. Candidates are diagnostic only.

Global localization now proposes an AMCL seed only when a full-map scan search
has strong endpoint agreement, few rays crossing occupied cells, and a clear
margin over other locations. The proposal does not authorize motion: AMCL's
multi-scan checks and SLAM graph agreement still apply. Search is bounded to
3.5 seconds per proposal, followed by the localization confirmation window.

`python /data/alfred/map_bridge.py stop-return` stops only an independently
verified return-to-station task, checking the live service schema first. It
refuses other task types. This is an explicit operator tool, not automatic
cancellation of native tasks when Locate is clicked.

`python /data/alfred/map_bridge.py start-return` requests explicit docking only
from idle and waits up to three seconds for the native return task. WorkManage's
acknowledgement alone is insufficient: firmware can silently refuse admission
(observed with a missing dustbin and while already charging). Check `started`
and `accepted` in the result.

Manual capture observes charging contacts during verified tracking and stores
a station pose in that map's coordinate frame. Docked LiDAR sleep keeps manual
capture available; the first held drive input wakes sensors without queuing a
stale velocity. The latter departure path still needs a complete device retest.

Charging-contact auto-return is now suppressed with a verified, reversible live
callback patch; the prior bind-mount/restart experiment is superseded. See
[firmware-contact-return.md](firmware-contact-return.md) for evidence, scope,
verification and rollback. The stock library on disk remains unchanged.

Physical measurement reports: after a successful motion recording, run `python3 tools/mapping_calibration_report.py <recording.json> --distance-mm <measured-distance>` or `--angle-deg <measured-angle>` (counterclockwise positive). This writes a sibling `.calibration.json` with errors and the 1 m / 90° gate results. Failed runs, stale wheel readings, reboots and recordings without a confirmed stationary stop are rejected. The recorder samples through deceleration and requires at least 0.4 seconds of fresh stationary wheel evidence. Suggested scale/separation values are reported only; settings are never changed automatically. Short drives do not pass the full-distance gate.

Locate now permits up to two measured 18 cm forward observation moves after an inconclusive stationary match. Each move checks fresh sensors, forward clearance, native idle state, cancellation and the HQ lease, then verifies a stationary stop. Retry proposals first match the fresh view, then combine views using relative wheel odometry if needed. A verified post-departure pose is transformed back to the charging-contact origin to mark the station; reboot or odometry discontinuity invalidates that station transfer. Live validation on Primary passed: leaving the enclosure produced a verified saved-map position; tracked docking saved a visible Station marker. After restarting the companion, Locate again succeeded after a bounded departure and back-projected the station from measured motion. Docked stationary scans remain occluded and may require departure. At that stage native charge-loss auto-return was still present; the later firmware contact-return policy is documented above.

Custom return is available from **Maps → Station → Return to station**, or
`POST /api/maps/{id}/return`. It requires a station saved from verified docking
and a verified map position. It replaces only an existing native return job;
cleaning and other native tasks must end first. Nav2 approaches the station
when needed, then a local controller matches all three enclosure surfaces
against `mapping/calibration/dock-enclosure.json`, recorded while charging.
The final approach uses stopped observations, measured wheel movement, and
20 mm/s reverse pulses. A crooked robot inside the enclosure creeps forward
for clearance before aligning. Charging contact stops movement immediately;
one second of confirmed contact completes return. Stop movement cancels it.

The custom controller stops on unsafe/stale sensors, native task conflicts,
reboot, missing enclosure evidence, lost heartbeat, or bounded retry/time
limits. Small docking wheel increments remain integrated across short delayed
polls; larger odometry gaps invalidate the approach. The saved-map pose is
needed for approach, while final enclosure tracking can use local odometry.
This is experimental: live trials recognized the dock and made gentle alignment
moves, but did not yet achieve charging before telemetry faults and loss of
ADB connectivity. Synthetic complete-approach and safety tests pass; physical
charging success remains unverified. No native firmware policy was changed.

### Return controller revision (2026-09-27)

Custom return runs in the mapping companion; the onboard Rust engine owns motor
leases and sensor transport. Enclosure fitting now matches visible observations
against the dock template, with odometry fusion and staging hysteresis. Charging
freshness uses local monotonic elapsed time, independent of robot wall-clock skew.
Temporary scan-history acquisition, stale wheel reads, transport outages and wake
transitions stop motion while retaining return intent for at most five seconds.
Hard faults and expired ownership still terminate the attempt; uncertain motion
requests are never replayed.

A confident enclosure fit beyond 60 cm permits 150 mm/s approach, with each pulse
limited to 5 cm and a 55 cm boundary margin. At closer distances normal slow
alignment/final reverse remains in force. The margin accounts for uncertainty
around the requested 50 cm slowdown boundary. This revision passed controller
regressions but has not yet demonstrated physical charging success. Subsequent
validation is one user-triggered complete run per revision, then trace review;
no automatic live patch/retry cycle.

The next recorded rejection exposed a prior-dependent crop failure: the same
stationary scan passed with current map tracking and failed with the carried dock
odometry prior. The controller now attempts independent map reacquisition when
that prior fails. Map data must be <500 ms old, within 25 cm / 0.35 rad of the
prediction, and produce three successive fits agreeing within 25 mm / 0.05 rad.
Motion stays stopped until confirmation. Reacquisition replaces the old anchor
rather than smoothing the correction back toward the rejected prediction. Existing
surface/error thresholds and hard odometry discontinuity stops remain. Status
includes acquisition priors, acceptance and confirmation count. The captured scan
is a regression fixture (`dock-prior-drift.json`); it is a post-failure stationary
capture, not a recording of the exact rejected frame. 22 focused tests pass;
physical success remains unverified.

### Alignment throughput and entry revision

Rear alignment previously admitted lateral error up to 35 mm while reverse
required <18 mm: near-zero heading could therefore repeatedly command near-zero
rotation without correcting lateral error. Reverse entry now accepts <40 mm
lateral / 0.20 rad heading error and steers during entry (yaw capped at .12 rad/s).
Only larger interior error (>50 mm / .30 rad) requests forward clearance.
Outside pure turns use .16–.60 rad/s with .30 rad / 50 mm wheel-travel pulses;
observation pauses are .15 s. Reverse is 60 mm/s until 12 cm, then 20 mm/s for
contacts; distant 150 mm/s remains. Pure-turn body clearance and contact/cliff/lift
stops remain. 24 docking/contact tests pass, including the lateral dead zone,
steered interior entry, and two full return simulations each below 90 seconds.
These timing results are simulations, not physical docking verification.

### Map-guided return (supersedes enclosure-acquisition gating)

The saved station and fresh map pose now own approach and rear alignment. Nav2
approach allows 150 mm/s. Local approach does not call the enclosure matcher;
inside 30 cm a matching enclosure may supply a bounded correction but a rejected
match never vetoes the known destination. Odometry bridges at most two seconds
of missing map tracking; without either, motion holds and fails after five seconds.
Reverse clearance checks operate throughout entry, excluding only returns within
5 cm of predicted enclosure surfaces in the final 30 cm. Bumper/cliff/lift stops
and charging confirmation remain. 28 focused tests pass. No physical validation
attempt has been initiated for this revision.

### Ramp entry drive revision

Supersedes 20/60 mm/s entry: reverse entry now requests 100 mm/s throughout the
last 60 cm, retaining 150 mm/s for distant approach. Entry segments renew through
fresh control evaluation without a scheduled zero/settling pause (up to .7 s or
60 mm before reevaluation). Charging and safety telemetry interrupt every update;
no-progress detection, endpoint/reseat bounds, and the Rust deadman remain.
This changes velocity demand, not a direct torque setting. 30 focused tests pass,
including segment continuity, charging stop, cliff interruption, and stalled
entry termination. Ramp climbing still requires physical verification.

### Manual map controls and live position (2026-09-28)
Maps reuses Cockpit's drive pad, throttle/wheel readouts and robot speed settings when Manual capture is selected. Arrow keys and held pointer controls share the same 100ms drive refresh and release/blur stop behavior. Switching out of manual mode stops held movement. Map actions await pending manual stops before starting localization or return; an unordered stop previously raced Locate and invalidated its epoch with `Scan cancelled.`

A separate 150ms-delay position poll reads `/api/maps/:id/position` and only updates the SVG robot transform, preserving map edits and view. The backend selects active onboard-return poses or fresh SLAM map-aligned poses with wheel freshness, map identity and localization checks. Native odometry is never rendered as map position. Old saved, cancelled or pending localization poses are hidden rather than presented as current. 70 HQ tests passed; browser mock-transport checks verified held controls, nonmanual gating and slow-stop-before-Locate ordering without commanding physical movement.

2026-09-28 wall/UI revision: removed browser area drawing/splitting/corner/opening tools and handlers, retained pan/zoom, map naming/rotation/export and robot controls. Repeated wall support now selects independent viewpoints per segment bin (10cm baseline), avoiding global 40cm frame filtering that discarded later visible surfaces. Recorded snapshot: 40/80 candidates supported before, 62/80 after; rebuilt stored structure has 55 consolidated candidates. Candidates are NOT rendered as independent black bars: that trial produced crossing clutter, rejected by user. Display uses only measured floor boundary, with thin wall/obstacle strokes. Mirror reflection in user screenshot remains unresolved; no artificial wall or traversability claim was introduced. 71 HQ tests passed, including nearby-later-view support and stationary-repeat rejection.

Localization visibility investigation (2026-09-28): offline identical-map/scan replay previously returned no proposal in3.02s; revised terminal-surface visibility check returned91.67% endpoint agreement, .0663distinct-candidate cost margin in3.11s. It distinguishes a thick terminal occupied band from a separate intervening surface followed by a clear gap. Four tests pass, including repeated-room rejection, thickendpoint and true intervening walls. This Python change is staged on the bind mount but NOT loaded into the running bridge: manual capture was active, so no mapping restart occurred. Replay artifacts/hq/localization-visibility-replay.json. This is not a mirror solution. User reports real mirror producing apparent room AND entrance; need actual plane distance/extent before exclusion, question pending. Do not invent traversability or physical wall position from coherent reflected geometry.
