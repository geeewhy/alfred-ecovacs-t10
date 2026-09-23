#!/usr/bin/env python3
"""Install the native mapping bridge and its on-device connection watchdog."""
import pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot
if __name__=='__main__':
    robot=Robot()
    robot.upload(ROOT/'runtime/map_bridge.py','/data/alfred/map_bridge.py.new')
    robot.shell('python -m py_compile /data/alfred/map_bridge.py.new && mv /data/alfred/map_bridge.py.new /data/alfred/map_bridge.py',timeout=10)
    print(robot.shell('python /data/alfred/map_bridge.py status',timeout=10))
