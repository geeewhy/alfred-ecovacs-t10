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

The on-robot engine is a loopback-only HTTP runtime. The HTTP interface, audio service, native firmware adapter, and temporary clip store are separate components behind narrow interfaces. The host client creates a temporary authenticated ADB forward; no unauthenticated LAN port is exposed.

`GET /v1/telemetry/battery` returns the engine's latest ROS `/power/Battery` and `/power/ChargeState` observations. The telemetry component reconnects independently of HTTP and audio, and atomically persists its last state to `/data/alfred/state/battery.json`.

`POST /v1/audio/play` streams an Ogg body into bounded `/tmp` storage and then invokes the native audio daemon. The firmware playback interface is file-oriented, so playback begins after the complete clip arrives. Up to eight recent clips are retained for asynchronous native playback and older clips are removed automatically.
