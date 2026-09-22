#!/usr/bin/env python3
"""Rebind an initialized USB gadget over Wi-Fi without restarting adbd."""
import pathlib
import shlex
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'runtime'))
from alfred import Robot, CONFIG, adb


def main():
    robot = Robot(CONFIG['wifi_address'] + ':5555')
    if 'uid=0(root)' not in robot.shell('id'):
        raise RuntimeError('Wi-Fi root connection required')
    path = '/sys/kernel/config/usb_gadget/g1/UDC'
    controller = robot.shell('cat ' + path).strip()
    if not controller:
        raise RuntimeError('USB gadget is not initialized; run setup first')
    robot.shell("printf '\\n' > " + path +
                ' && printf %s ' + shlex.quote(controller) + ' > ' + path)
    for attempt in range(5):
        state = robot.shell('cat /sys/class/udc/*/state').strip()
        print('USB: ' + state, flush=True)
        if CONFIG['usb_serial'] + '\tdevice' in adb('devices'):
            print(Robot(CONFIG['usb_serial']).shell('id'))
            return
        if attempt < 4:
            time.sleep(1)
    raise SystemExit('USB ADB unavailable after rebind; Wi-Fi root access remains available.')


if __name__ == '__main__':
    main()
