# Runtime tools

`runtime/alfred.py` selects an authorized USB device first, then Wi-Fi. Override with `--serial 192.168.1.89:5555` to test Wi-Fi explicitly.

| Command | Effect |
|---|---|
| `status` | Read identity, firmware, boot ID, service PIDs, USB state |
| `connect` | Establish connection and print selected transport |
| `shell` | Interactive root shell |
| `shell 'command'` | Run a command and validate its exit status |
| `say 'text'` | Generate macOS speech, convert/upload/play a temporary clip |
| `play file.wav` | Convert/upload/play local audio |

Audio is placed in `/tmp/alfred-clip.ogg`, which disappears on reboot. Built-in sound 137 says "ready for network setup"; use `say` for arbitrary text instead.

The root command interface is powerful: cleaning/movement controls are deliberately not included in the current tool. The code has only been exercised on this owner's T10 Omni 1.11.0.

## Audio engine

`runtime/audio_engine.py` provides `AudioEngine(robot)` with `say`, `play`, `volume`, and `stock`. It separates native robot playback/control from speech synthesis.

```sh
python3 runtime/alfred.py volume       # read native 0–1600 value
python3 runtime/alfred.py volume 50    # set percentage, mapped to 800
python3 runtime/alfred.py stock 137    # built-in network-setup announcement
python3 runtime/alfred.py say 'Hello Raymond' --backend mac
python3 runtime/alfred.py say 'Hello Raymond' --backend native
```

The default Mac backend is verified end-to-end. `native` invokes the installed `speech_tts` command with a timeout. Static inspection shows `/usr/lib/libttsclient.so` targets `https://smarthome.baidubce.com/v2/service/tts`; this option sends text through the vendor's cloud flow and may require voice-assistant credentials/configuration. Native arbitrary-text synthesis has not yet been verified on this robot. Native playback and volume APIs are supported by the firmware scripts.

## Rust engine

The on-robot engine listens directly on IPv4 LAN port 8765. Every endpoint requires the bearer credential stored in `/data/alfred/engine-token` (mode0600); the matching host file is `artifacts/engine-token`, ignored by Git. Missing or invalid credentials prevent startup. HQ, mapping, and the Python engine client use direct HTTP rather than an ADB forward. The HTTP interface, audio service, native firmware adapter, and temporary clip store remain separate components.

`GET /v1/telemetry/battery` returns the engine's latest ROS `/power/Battery` and `/power/ChargeState` observations. The telemetry component reconnects independently of HTTP and audio, and atomically persists its last state to `/data/alfred/state/battery.json`.

`POST /v1/audio/play` streams an Ogg body into bounded `/tmp` storage and then invokes the native audio daemon. The firmware playback interface is file-oriented, so playback begins after the complete clip arrives. Up to eight recent clips are retained for asynchronous native playback and older clips are removed automatically.

## Cockpit speech

Cockpit has a text box and Speak action. HQ Settings persists Daniel (male, British English) or Samantha (female, American English) on this Mac in `artifacts/hq/speech.json`. HQ uses the existing `runtime/alfred.py say` path; macOS synthesizes, and the robot’s native audio engine plays the clip. Daniel playback submission and saved-setting reload were verified.

Native investigation: `speech_tts` reads `/data/config/speech/tts.json` and supports junhao, duxiaowen, duxiaoxian, duxiaoduo and duxiaoqiao. This robot lacks `/data/config/speech/quadruples.json`; a native synthesis probe returned exit 255 (missing Baidu credentials). No native voice gender or working native synthesis is claimed. Its BusyBox timeout syntax is `timeout -t 12`, now corrected in the runtime.

Boot ordering: the stock ROS master can start after Alfred’s /data hook. Drive publisher registration now retries every second with a one-second RPC timeout, retaining its listeners instead of terminating the engine. Observed and recovered after the September 23 boot; a subsequent physical reboot remains the end-to-end autostart check.

Cockpit shows front bumper states via HQ `GET /api/bots/alfred/bumpers` and engine `GET /v1/telemetry/bumpers`. The engine subscribes to `/onOffInfo/OnOffInfo` (TYPE_BUMP=0), decoding bits 0/1 as left/right from the firmware BumpValue indices. HQ polls every 250 ms; readings older than 2 seconds become unknown/stale. Physical left/right press mapping still needs confirmation. This is telemetry, not a new automatic collision-stop feature.

Diagnostics: each log retains the newest complete records within 10 KiB. HQ: `artifacts/hq/diagnostics.log` (connection transitions, boot IDs, HTTP transport and microphone failures; no chat/audio payloads). Robot: `/data/alfred/logs/engine.log` and `/data/alfred/logs/adb.log` (boot IDs, child PIDs, output and exit codes), retained across boots by `setup/rolling_log.py`. All setup/deploy paths install the logger. HQ still starts when the robot is offline. Read device logs with `python3 runtime/alfred.py shell 'cat /data/alfred/logs/adb.log /data/alfred/logs/engine.log'`.

Native startup greeting: `python3 setup/startup_sound.py --preview` installs Daniel saying “Hello, my good sir.” A persistent clip is bind-mounted over `/media/music/ZH/0.ogg` by Alfred's autostart hook, before the stock boot player runs; no HQ/network dependency or rootfs flash. Original saved at `/data/alfred/backups/startup-original.ogg`; `python3 setup/startup_sound.py --restore` disables the overlay. Stock OTA/watchdog-boot suppression still applies. Installed path/checksums and playback verified; next normal power-on verifies the full boot sequence.

HQ Maps: live LiDAR capture, saved floor plans, polygon areas, split/merge and PNG/SVG export. See [maps.md](maps.md) for workflow and scan-matching limits.

Connection failure investigation (2026-09-27): repeated `adb connect` against
an already-connected device leaked one robot-side socket per invocation
(25 requests: FD count66→91); ordinary shell requests did not show that growth.
Persistent adbd logs show repeated exits255 after `Too many open files`. HQ
runtime control no longer uses ADB. The retained installation/debug client
checks host transport state before connecting; runtime/alfred.py reuses an
existing Wi-Fi transport.

The deployed `setup/adb_supervisor.py` restarts a missing authenticated adbd
within 5 seconds, records FD counts/uptime and honors the explicit stop flag.
It does not restart a healthy daemon or reboot the robot. Live verification
stopped adbd: direct engine status remained available and the supervisor
restarted adbd with the same robot boot and engine process. No movement was
commanded. The prior unexplained loss of whole-device reachability is not
proven resolved by this transport change.

Direct access deployment: `python3 setup/deploy_engine.py` installs the token,
fixed native helper scripts, supervisor, and engine binary. HQ defaults to
`http://<robot.json wifi_address>:8765` (`HQ_ENGINE_URL` overrides it); mapping
uses `ALFRED_ENGINE_URL` in Compose and a read-only token mount. Redeploy with
the same host credential; do not print or commit it. The engine exposes fixed
status, fresh dock contact, LiDAR wake, and native-return-stop endpoints so
mapping never needs shell access. HQ speech playback also uses the direct API.
The separate microphone capture/debug tooling still uses its existing ADB
path; it is not part of engine control.

Verification: `artifacts/hq/direct-engine-verification.json` records successful
health, system status, charging contact, native frame and Stop requests with
ADB disconnected and its old forward removed. Missing/wrong tokens receive 401.

Onboard custom return is available independently of HQ and the mapping companion.
See [onboard return](onboard-return.md) for API, ownership, map installation,
validation and current limits. The HQ-guided implementation remains a separate
backup. The initial onboard deployment passed an offline localization replay on
the robot (373 ms, 98.8% scan score); physical onboard docking is not yet verified.
