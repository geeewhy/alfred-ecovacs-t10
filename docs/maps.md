# Maps

Run Docker, build once with `python3 setup/mapping.py --build`, then start with `python3 setup/mapping.py --start`. Build output: `artifacts/hq/mapping-build.log`. Later builds reuse installed ROS packages; `--build --fresh` rebuilds dependencies. HQ starts the installed companion automatically. Engine forwarding uses localhost:48765; the companion uses localhost:48766.

New map → Start scan explores automatically. Manual capture records while you drive from Cockpit. Pause, Stop movement, Space, or manual driving cancels autonomous motion. Finish saves; Resume extends a saved map. Locate Alfred verifies its position before navigation. Ambiguous matches remain stopped. Battery at 10% or lower prevents exploration.

Production mapping uses SLAM Toolbox, wheel odometry, Nav2 DWB, and explore_lite. AMCL locates against saved occupancy before loading the graph at the accepted pose. Warm restore is device-tested; relocation from arbitrary positions and a complete physical loop remain acceptance work. Legacy native maps remain viewable/editable and support manual capture; create a new map for automatic exploration.

Settings → Mapping controls cruise and approach speeds (defaults 120/60 mm/s), including while the robot is offline. Supported walls guide navigation; bumper contact causes a bounded reverse and turn away. Cliff/lift, stale sensors, missing position, lost HQ heartbeat, and repeated contact stop movement. The engine has a 350 ms deadman; the companion lease expires after three seconds.

Floor plan derives walls from corrected saved-graph scans, with annotations, upright labels and aligned dimensions. Measurements toggles the occupancy/trajectory overlay. Rotation aligns the drawing without changing navigation coordinates. Draw/name areas, split, merge, edit corners, annotate doors/windows, undo/redo and export PNG/SVG. Unknown gaps remain open; annotations do not alter navigation occupancy.

HQ maps/checkpoints: `artifacts/hq/maps/` (every two seconds). SLAM graph pairs and manifests: `mapping/state/maps/` (every 15 seconds and on pause). Settings: `mapping/state/settings.json`. Delete archives HQ files and graphs in each store's `deleted/` directory. Preserve both stores for backup.

Checks: `node --test hq/test/*.test.mjs`, `python3 -m unittest discover -s mapping/test`. Calibration: `node tools/mapping_motion_test.mjs forward --speed=120 --seconds=2` (compare against a physical mark). Bounded device run: `node tools/mapping_explore_test.mjs [map-id] --seconds=15`; it pauses in `finally`. Evidence: `artifacts/hq/mapping-runs/`. See the thread's mapping rebuild plan for remaining physical acceptance gates.
