#!/bin/sh
# Recovery already starts stock ADB later; defer authenticated restart until then.
[ "${1:-start}" = start ] || exit 0
[ "$(cat /sys/class/ubi/ubi0/mtd_num)" = 6 ] || exit 0
(
    sleep 12
    killall adbd 2>/dev/null
    rm -f /var/run/adbd.lock
    /data/alfred/adb-start.sh start
) </dev/null >/tmp/alfred-recovery.log 2>&1 &
