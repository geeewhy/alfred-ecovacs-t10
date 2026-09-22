#!/usr/bin/python
"""Detach Alfred engine from the invoking shell. Python 2 compatible."""
import os,signal

if os.fork():os._exit(0)
os.setsid();signal.signal(signal.SIGHUP,signal.SIG_IGN)
if os.fork():os._exit(0)
fd=os.open('/dev/null',os.O_RDONLY);os.dup2(fd,0);os.close(fd)
fd=os.open('/tmp/alfred-engine.log',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
os.dup2(fd,1);os.dup2(fd,2);os.close(fd)
os.execv('/data/alfred/alfred-engine',['alfred-engine'])
