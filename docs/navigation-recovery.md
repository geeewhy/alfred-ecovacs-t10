# Native navigation recovery

The September 29 return trace stalled for 300 seconds and 534 replans after
leaving its initial planning-margin overlap. Localization stayed tracked. Saved
free-space connectivity split the robot and station into separate components;
the old recovery selected at most four goal-near viewpoints, then waited.
Recorded grid/scan overlays show a narrow entrance between these components.

## Algorithm

- Plan with a 0.18 m hard body radius; add graded costs for preferred clearance
  around saved and live obstacles instead of banning the whole comfort margin.
  Local trajectory scoring also favors clearance, and limits forward speed to
  0.10 m/s when an observed obstacle is within 0.28 m of the centre.
- Keep a per-operation live navigation layer. Three distinct scan observations
  of free rays may override saved occupancy for navigation. Current endpoints
  revoke free evidence immediately; overrides expire after five unobserved scan
  updates. The localization grid and station calibration are never rewritten.
  Installed reflection boundaries cannot be cleared by this layer.
- If no complete route exists, search the reachable component for viewpoints
  offering new visibility. Score expected new cells against travel cost and
  distance to the goal. Remember visited viewpoints instead of stopping after an
  arbitrary four; the existing 300-second operation deadline remains.
- Continue collision-checked differential-drive rollout and fresh sensor/contact
  guards. Footprint feasibility, preferred clearance, and exploration are separate
  decisions. A geometrically impossible passage remains impossible.
- Report route size, chosen recovery target, visited viewpoints, confirmed free
  cells and live obstacle count in native navigation status.
- Track a hold timeout per reason. Startup telemetry waiting must not consume a
  later motor-wake retry's time budget.

## Sources and adaptation

[Nav2 obstacle layers](https://docs.nav2.org/jazzy/configuration_and_development/configuration_guide/core_servers/costmap_2d/costmap_plugins/obstacle/)
document measured marking/clearing and layer combination policies.
[Frontier-based information gain](https://arxiv.org/abs/2011.05323) motivates choosing
new views by expected information and motion cost. Alfred uses a small discrete
ray-cast approximation, not that paper's differentiable optimization or benchmark.

The 18 cm radius and evidence/clearance parameters are engineering choices for
this robot, not universal values established by either source. A single 2D laser
still cannot distinguish every reflective opening; mirror-model repair remains a
separate task. No map-specific doorway or coordinate exception is installed.

## Validation

65 engine tests pass, including complete narrow-doorway traversal, chair and
U-obstacle detours, changed live obstacles, distinct-scan free confirmation, hit
revocation, and an impassable wall. Offline replay accepts optional scan history
so persistent observation effects can be reproduced without motor initialization.

Interval captures: `artifacts/hq/navigation-intervals/`.
Physical trials: `artifacts/hq/navigation-trial-1/` (startup wake timeout) and
`artifacts/hq/navigation-trial-2/` (subsequent trial; record final outcome separately).

### Physical result

On September 29, after explicit user authorization to drive the trials, trial 2
completed onboard in **56.432 seconds**. At 15.7 seconds Alfred had crossed the
previously blocked entrance; at 36.4 seconds it was staging at the station; at
46.7 seconds it was backing in. At completion the engine reported `docked`,
`active:false`, and a fresh independent dock query returned `docked:true`.
A subsequent query also confirmed charging. HQ sent no navigation heartbeat or
intermediate steering during the run. Saved station coordinates are unchanged.

Deployed engine MD5: `121d0f8aa1fa09def2880f348940add8`.
Rollback: `/data/alfred/alfred-engine.before-layered-navigation`.
This verifies the observed entrance-to-dock failure case, not every possible
floor arrangement or reflective surface.
