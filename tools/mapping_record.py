#!/usr/bin/env python3
"""Capture original robot mapping messages and live schemas without commanding motion."""
import argparse, json, pathlib, shlex, subprocess, sys, time
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runtime'))
from alfred import Robot, ENV

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=5)
    parser.add_argument('--label', default='stationary')
    args = parser.parse_args()
    if not 0 < args.seconds <= 10:
        parser.error('--seconds must be greater than zero and at most 10')
    if not args.label.replace('-', '').isalnum():
        parser.error('--label must contain letters, numbers or hyphens')
    robot = Robot()
    source = ROOT / 'runtime/mapping_record.py'
    import hashlib
    digest = hashlib.md5(source.read_bytes()).hexdigest()
    current = robot.shell('md5sum /data/alfred/mapping_record.py 2>/dev/null || true').split()
    if not current or current[0] != digest:
        robot.upload(source, '/data/alfred/mapping_record.py')
    directory = ROOT / 'artifacts/hq/mapping-runs'
    directory.mkdir(parents=True, exist_ok=True)
    name = f'{int(time.time()*1000)}-{args.label}-native.jsonl'
    remote = '/data/alfred/' + name
    print(robot.shell(f'python /data/alfred/mapping_record.py {shlex.quote(remote)} {args.seconds}', timeout=15))
    subprocess.run(['adb', '-s', robot.serial, 'pull', remote, str(directory / name)],
                   env=ENV, check=True, timeout=15, capture_output=True)
    robot.shell('rm ' + shlex.quote(remote))
    print(directory / name)

if __name__ == '__main__':
    main()
