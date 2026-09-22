# Setup and recovery

## Verified access

- Model DBX53 / T10 Omni; Ecovacs class lx3j7m; product zj2116c.
- Live firmware 1.11.0, Linux 4.14.74.
- USB serial ZJ2116C14F5F931933B; USB configured at high speed with working cable/hub.
- Wi-Fi root ADB at 192.168.1.89:5555; device MAC 14:f5:f9:31:93:3b.
- Robot speaker accepts Ogg Vorbis through `/tmp/audio_daemon.sock`.
- Legacy ADB file sync is incompatible with this Mac client. Small files use checksum-verified base64 transfer; large images use a temporary local HTTP server.

## Boot persistence

Normal firmware skips `!autostart.sh` and `!adbd.sh`. The root filesystem is read-only SquashFS. `/data` is persistent and writable.

The prepared rootfs changes only `!autostart.sh` to `autostart.sh` in `/etc/rc.conf`. Every other file's content, timestamps, ownership, permissions, symlinks, and device-node records are checked via SquashFS pseudo export. The stock backup matches the live rootfs MD5 `0d1e4559ecb9b7c662bf1db6733bc3b3`.

Startup script `/data/alfred/adb-start.sh` starts USB and TCP ADB with `PROP_ro.adb.secure=1`, only if an authorized-key file exists. It is linked as `/data/autostart/alfred.sh`. Recovery has its own guarded `/data/autostart/recovery.sh` to restart ADB with the same authentication after stock recovery startup.

Preparation (does not flash):

```sh
python3 setup/prepare_boot_image.py
python3 setup/verify_boot_image.py
python3 setup/stage_startup.py
python3 setup/stage_image.py
```

`stage_startup.py` refuses to overwrite existing hooks. These commands are setup operations, not needed for everyday use. Firmware updates or factory resets can remove persistence or authorization.

## Recovery principles

Never write a root filesystem while it is the active mounted root. Normal root is UBI on physical MTD 5 (`system`); recovery root is MTD 6 (`system_b`). UBI numbering can differ between boots: inspect the physical MTD association and volume name before writing.

The existing boot selection uses `ubi_atomic_update_leb /dev/ubi2_0 -i boot_mode2 -n 0` for recovery and `boot_mode1` for normal boot. Stock recovery times out back to normal after about ten minutes if no update starts. Keep working USB attached and preserve the stock image.

Rollback consists of booting recovery, identifying/attaching physical `system` (MTD 5), restoring the verified stock SquashFS with `ubiupdatevol`, and selecting normal boot. The upstream X1 guide in this directory is reference material, not a blindly executable T10 script.

## Provenance

- Firmware decryption: https://github.com/denysvitali/ecovacs-firmware-tools
- Recovery/rootfs approach: https://github.com/itsjfx/ecovacs-hacking
- Detailed chronological investigation: [research log](research-log.md).

Installation and reboot validation results are recorded below after execution.

### Recovery connection interruption

During the first recovery boot, the experimental delayed ADB restart dropped USB before the flash preflight completed. **No flash write occurred in that experiment.** The failed hook was removed before the verified installation below.

## Repeatable native Mac Wi-Fi path

```sh
python3 setup/wifi.py scan ECOVACS_0150
python3 setup/wifi.py join ECOVACS_0150
```

This compiles `setup/wifi.m` locally and uses CoreWLAN to scan the exact SSID and associate with the returned network object. It rejects ambiguous/encrypted targets, reports native error domain/code, and makes no implicit retries. Scan success is not association success. macOS may redact SSID/BSSID and may reject programmatic association even when the AP is visible.

`setup/recover_adb.py --run` uses this helper for the outbound robot connection, with one independent password-assisted home reconnection. It validates the known robot MAC and existing authorized key, restores ADB without re-uploading keys, and only reports success after a root ADB command over home Wi-Fi. Supply the home password via `ECOVACS_RETURN_WIFI_PASSWORD` or the interactive prompt. This new combined path still needs successful live association validation. `--manual-join` supports choosing the AP in the Mac Wi-Fi menu if native association is rejected.

### September 22 corrections

The original `networksetup` round trip succeeded again at 12:33: root identity and home restoration verified. Default recovery now uses that proven path; the CoreWLAN helper remains diagnostic only. Setup performs USB initialization after returning to home Wi-Fi, not in the brief AP window.

The first background USB restart was lost when its ADB shell closed. `restart_adb.py` now double-forks, detaches, ignores SIGHUP, redirects descriptors, waits for the prior daemon to exit, and arms an independent TCP fallback. The stock-wrapper daemon path was also corrected to `/usr/sbin/adbd`.

### Verified installation — September 22, 2026

Recovery boot on physical MTD 6 verified the unmounted normal rootfs target on physical MTD 5 before writing. The prepared image was written and read-back verified as MD5 `b7ee794c8800d372bbec34fe9ecc51d0`, then normal boot was selected.

After reboot, the robot returned on authenticated root Wi-Fi ADB at `192.168.1.89:5555`. Normal boot (`ubi0/mtd_num=5`), the installed rootfs hash, `autostart.sh` in `/etc/rc.conf`, `/data/autostart/alfred.sh -> /data/alfred/adb-start.sh`, secure ADB environment, and the normal `medusa`, `deebot`, and `wifi_daemon` services were independently verified. The boot hook starts Wi-Fi ADB by default; USB gadget mode remains an explicit runtime action so a missing USB host cannot prevent remote recovery.
