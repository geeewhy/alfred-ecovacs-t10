#!/usr/bin/python
"""Detached service runner with a persistent 10 KiB log. Python 2 compatible."""
from __future__ import print_function
import datetime, os, signal, subprocess, sys
LIMIT = 10 * 1024

def append(path, data):
    if not isinstance(data, bytes): data = data.encode('utf-8', 'replace')
    prefix = datetime.datetime.utcnow().isoformat() + 'Z '
    data = prefix.encode('ascii') + data.rstrip(b'\n') + b'\n'
    directory = os.path.dirname(path)
    if not os.path.isdir(directory):
        try: os.makedirs(directory, 0o700)
        except OSError: pass
    try:
        with open(path, 'rb') as source:
            source.seek(0, 2); source.seek(max(0, source.tell()-LIMIT)); previous = source.read()
    except IOError: previous = b''
    content = previous + data
    if len(content) > LIMIT:
        content = content[-LIMIT:]
        newline = content.find(b'\n')
        if newline >= 0: content = content[newline+1:]
    temporary = path + '.tmp'
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as output: output.write(content)
    os.rename(temporary, path)

def run(path, command):
    if os.fork(): return
    os.setsid(); signal.signal(signal.SIGHUP, signal.SIG_IGN)
    if os.fork(): os._exit(0)
    fd = os.open('/dev/null', os.O_RDWR)
    for target in (0, 1, 2): os.dup2(fd, target)
    if fd > 2: os.close(fd)
    try:
        try: boot = open('/proc/sys/kernel/random/boot_id').read().strip()
        except IOError: boot = 'unknown'
        append(path, 'START executable=%s boot=%s' % (command[0], boot))
        child = subprocess.Popen(command, stdin=open('/dev/null'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        append(path, 'PID %s' % child.pid)
        while True:
            data = os.read(child.stdout.fileno(), 2048)
            if not data: break
            append(path, data)
        append(path, 'EXIT pid=%s code=%s' % (child.pid, child.wait()))
    except Exception as error:
        append(path, 'RUNNER ERROR %s' % error)
    os._exit(0)

if __name__ == '__main__': run(sys.argv[1], sys.argv[2:])
