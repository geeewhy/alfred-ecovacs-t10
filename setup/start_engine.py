#!/usr/bin/python
"""Detach engine and retain startup, stderr, and exit evidence across reboot."""
from rolling_log import run
run('/data/alfred/logs/engine.log', ['/data/alfred/alfred-engine'])
