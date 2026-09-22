# Validation

- Stock rootfs MD5 matched live `/dev/ubi0_0`: `0d1e4559ecb9b7c662bf1db6733bc3b3`.
- Prepared rootfs MD5: `b7ee794c8800d372bbec34fe9ecc51d0`; transferred image matches.
- Full SquashFS pseudo comparison: 3,828 entries; only `etc/rc.conf` content changed; metadata preserved.
- Startup/recovery shell scripts passed device-side `sh -n`.
- Runtime small-file uploader passed binary round-trip MD5 verification (all byte values).
- Runtime command wrapper correctly raises on a failing remote command.
- USB root shell and authenticated Wi-Fi root shell verified before persistence.
- Custom speech clips "Raymond" and "What's up, Raymond?" played successfully; user confirmed playback.
- Recovery verified physical MTD 6 and the unmounted normal MTD 5 target before flashing.
- Installed rootfs read-back MD5 verified as `b7ee794c8800d372bbec34fe9ecc51d0`.
- A new normal boot returned with a distinct boot ID, physical MTD 5, `autostart.sh` enabled, and authenticated root Wi-Fi ADB started from the writable `/data` hook.
- Post-reboot `medusa`, `deebot`, and `wifi_daemon` processes were running.
