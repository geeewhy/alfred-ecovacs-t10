#!/bin/bash
set -eo pipefail
source /opt/ros/jazzy/setup.bash
source /alfred/install/setup.bash
python3 /alfred/configure.py
children=()
cleanup() { kill "${children[@]}" 2>/dev/null || true; wait || true; }
trap cleanup EXIT TERM INT
python3 /alfred/bridge.py & children+=($!)
ros2 launch slam_toolbox online_async_launch.py slam_params_file:=/tmp/alfred-slam.yaml use_sim_time:=false & children+=($!)
ros2 run nav2_controller controller_server --ros-args --params-file /tmp/alfred-nav2.yaml & children+=($!)
ros2 run nav2_planner planner_server --ros-args --params-file /tmp/alfred-nav2.yaml & children+=($!)
ros2 run nav2_bt_navigator bt_navigator --ros-args --params-file /tmp/alfred-nav2.yaml & children+=($!)
ros2 run nav2_lifecycle_manager lifecycle_manager --ros-args -r __node:=lifecycle_manager_navigation --params-file /tmp/alfred-nav2.yaml & children+=($!)
wait -n
