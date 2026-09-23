#!/usr/bin/env python3
"""Refresh Jazzy DWB's cached speed bound live, without stopping SLAM.
The same refresh is included in Bridge.update_settings for future changes.
"""
import subprocess
subprocess.run(['docker','exec','alfred-mapping','bash','-c',
    '. /opt/ros/jazzy/setup.bash; ros2 param set /controller_server FollowPath.min_speed_theta 0.0'],check=True,timeout=10)
