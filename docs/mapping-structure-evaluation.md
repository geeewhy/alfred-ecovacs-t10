# Structural extraction evaluation

Upstream ROSE² was evaluated offline on the paired native map in `artifacts/hq/mapping-runs/1790145430725-native-load.json`. The repeatable runner is `tools/evaluate_rose.py <upstream-checkout> <snapshot>`; results and detailed output are in `artifacts/hq/rose-evaluation.json` and `.log`.

ROSE found four dominant directions (approximately 9° and its perpendiculars), but its wall-clustering stage rejected this partial map with an empty-cluster error. Its ROS wrapper handles that error by skipping the map. This snapshot therefore produced no ROSE² rooms or structural edges. Do not put this pipeline in the live control path or claim that its output validates this home's dimensions.

The candidate remains an offline comparison for a completed room. HQ's structural layer must preserve gaps and require accumulated measured support; it must also retain stable accepted walls between updates instead of disappearing whenever a new scan partly occludes them.

A temporary empty-cluster guard in the upstream checkout advanced processing but then failed on an undefined `centroid`; that modified run is separate from the original result (`rose-evaluation-patched.log`). No upstream ROSE code is in the production service.

Production structure uses corrected scan poses/points and a matching occupancy grid exported from SLAM Toolbox's serialized Karto graph. Partial wall views contribute per-segment votes from separated positions; accepted walls retain identities until current occupancy contradicts them. This avoids using uncorrected historical HQ scan poses after loop closure. The exporter is exercised against Alfred's saved graph by `tools/mapping_checkpoint_test.py` inside the companion.
