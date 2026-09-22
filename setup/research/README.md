# Archived initial-access research

These helpers preserve how the initial connection was established. They are not required after persistent authenticated ADB is installed.

- `extract.py`, `inspect_boot.py`: original firmware analysis; expect the original filenames beside the script. Adapt paths before reusing.
- `probe-local-setup.py`: read-only pairing CGI probe; only use against the owner's robot.
- `network_adb.py`: initial public-key installation and Wi-Fi provisioning.
- `wifi-probe-roundtrip.py`: experimental Wi-Fi switching helper. Requires `ECOVACS_RETURN_WIFI_PASSWORD` in the process environment. The robot's network name must be verified: user-visible and tool-reported spellings differed during the session. Do not use this as a general network manager.

Historical helpers contain assumptions specific to the original session. Everyday commands live in `runtime/`, and new setup work uses the documented scripts one directory above.
