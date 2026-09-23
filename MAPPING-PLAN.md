# Mapping implementation plan

Goal: Alfred autonomously explores, builds a geometrically credible floor plan, and locates itself in that saved map. UI work does not count as proof of navigation.

## 1. Restore control and prove movement — DONE
- Deploy the engine and verify fresh LiDAR and safety telemetry.
- Physically test forward and turning commands with a stop after each run.
- Evidence: forward ~8 cm / 11 scans; turn ~19° / 11 scans. Engine deployed.

## 2. Make continuous exploration reliable — IN PROGRESS
- Keep exploration targets stable; use LiDAR coverage to seek unmapped space and supported walls to route around it.
- On bumper contact: stop, reverse briefly, turn away after release, and replan. Retain cliff/lift checks and the deadman.
- Fix failures from live runs, record continuous LiDAR, and repeat bounded runs.
- Verified: autonomous travel over 1 m and 196 accumulated scans; relocalization between runs; fixed clock-skew freshness checks and target oscillation.
- Fixed and deployed partial sensor merging with independent freshness. Right-bumper contact, reverse, ~90° left turn and escape travel physically verified. Contact locations and recovery phase now survive pause/resume. Next: a longer uninterrupted run and inspect accumulated geometry.
- Exit check: sustained exploration with fresh telemetry, changing position and expanding coverage; actual bumper recovery verified.

## 3. Validate mapping against the room — NEXT
- Collect overlapping scans from separated positions and turns, not one stationary snapshot.
- Inspect recordings, pose estimates and occupancy for alignment errors; correct sensor/frame assumptions if needed.
- Accept structural walls only with support from multiple positions. Keep unsupported returns out of the floor plan.
- Exit check: observed walls and openings agree with the real room; revisit alignment does not duplicate or bend walls.

## 4. Verify saved-map localization and loop closure — PARTIAL
- Saved-reference search, ambiguity rejection, two-scan verification and graph correction are implemented.
- Saved-map relocalization worked between short physical runs. Synthetic relocation/loop tests pass.
- Still required: physical revisit loop and localization after reposition/reboot; failed or ambiguous matches must keep wheels stopped.

## 5. Finish the floor-plan experience — PARTIAL
- Implemented: dedicated Maps page, live scan status, map deletion, area drawing/naming/split/merge/corner edits, undo/redo, export, architectural styling, door/window annotations, manual north alignment.
- Still required: validate the rendered plan using the completed real scan, improve wall/room geometry from that evidence, and check the full scan→save→reopen→locate workflow.

## Execution rules
- Work in this repo and use its setup/runtime/test tools. Keep calls ≤15 seconds and status polling short.
- Use bounded floor runs; stop in cleanup and preserve the user's Test map.
- Save raw runs under artifacts/hq/mapping-runs/. Current live validation map: 580daacc-7934-4425-9a40-d5aba4662890.
- Update this file as evidence changes. Report simulated, recorded-data and physical results separately. Do not call mapping complete until the live exit checks pass.
