#!/bin/sh
# Authenticated USB + Wi-Fi ADB. /data persists; 10 KiB diagnostic logs persist across reboot.
MODE="${1:-start}"
case "$MODE" in
 stop) touch /data/alfred/adb-supervisor.disabled; killall adbd alfred-engine; exit 0 ;;
 start|usb) ;;
 *) exit 2 ;;
esac
# Reapply the opt-in, reversible contact-loss policy to each firmware process.
# This never restarts firmware and does not depend on HQ or the engine.
if [ -f /data/alfred/firmware/no-contact-return-live.enabled ] || [ -f /data/alfred/firmware/no-stock-voice.enabled ]; then
    python /data/alfred/firmware_policy.py supervise
fi
if [ -f /data/alfred/startup-sound.sh ]; then
    sh /data/alfred/startup-sound.sh
fi
[ -s /data/misc/adb/adb_keys ] || exit 1
if [ -x /data/alfred/alfred-engine ] && ! pidof alfred-engine >/dev/null; then
    if [ -f /data/alfred/start_engine.py ]; then
        python /data/alfred/start_engine.py
    else
        /data/alfred/alfred-engine </dev/null >>/tmp/alfred-engine.log 2>&1 &
    fi
fi
rm -f /data/alfred/adb-supervisor.disabled
# Delay supervisor startup until the primary path has had time to launch adbd.
( sleep 3; python /data/alfred/adb_supervisor.py ) </dev/null >/dev/null 2>&1 &
pidof adbd >/dev/null && exit 0
# Property names contain dots; use env, not shell export.
ROLE=/sys/devices/platform/soc/b2000000.usb/b2000000.dwc3/role
if [ "$MODE" = usb ] && [ "$(cat "$ROLE" 2>/dev/null)" = device ]; then
    rm -f /var/run/adbd.lock
    # Patch only the daemon invocation in a temporary copy of the stock USB setup.
    sed 's|^    adbd |    python /data/alfred/rolling_log.py /data/alfred/logs/adb.log env PROP_service.adb.tcp.port=5555 PROP_ro.adb.secure=1 /usr/sbin/adbd |' /etc/rc.d/adbd.sh > /tmp/alfred-usb-adb.sh
    /bin/sh /tmp/alfred-usb-adb.sh start >>/tmp/alfred-adb.log 2>&1
    [ -n "$(cat /sys/kernel/config/usb_gadget/g1/UDC 2>/dev/null)" ] || exit 1
else
    # Boot default: reliable authenticated TCP ADB. USB is optional and must
    # never prevent remote recovery when no host data link is present.
    python /data/alfred/rolling_log.py /data/alfred/logs/adb.log \
        env PROP_service.adb.tcp.port=5555 PROP_ro.adb.secure=1 /usr/sbin/adbd
fi
