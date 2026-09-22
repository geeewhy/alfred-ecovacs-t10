# Alfred — Ecovacs T10 Omni

Local root access and speaker tools for DBX53, firmware 1.11.0.

## Setup

```sh
python3 setup/setup.py
```

Setup enables authenticated USB and Wi-Fi ADB and **installs boot persistence by default**. It verifies the image, uses recovery for the rootfs update, reboots, and checks both transports. Keep the working USB cable connected. Use `--no-persist` for temporary access, or `--manual-join` if macOS refuses automatic association with the robot's AP. The home Wi-Fi password is prompted for or read from `ECOVACS_RETURN_WIFI_PASSWORD`; it is not saved.

Persistent authenticated Wi-Fi root ADB is installed and reboot-verified on this robot. The boot image enables the stock autostart runner; the managed startup script remains writable at `/data/alfred/adb-start.sh`. See `docs/setup.md` for validation and rollback details.

## Everyday use

Requires Python 3 and Android platform-tools (`adb`). Speech also needs macOS `say` and `ffmpeg`.

```sh
python3 runtime/alfred.py status
python3 runtime/alfred.py shell
python3 runtime/alfred.py say "What's up, Raymond?"
python3 runtime/alfred.py play /path/to/audio.wav
```

The tool prefers USB, otherwise connects to the Wi-Fi address in `robot.json`. Reserve `192.168.1.89` for MAC `14:f5:f9:31:93:3b` in the router, or update that address when DHCP changes it.

Direct access:

```sh
ADB_LIBUSB=0 adb start-server
adb connect 192.168.1.89:5555
adb -s 192.168.1.89:5555 shell
# Or USB:
adb -s ZJ2116C14F5F931933B shell
```

## HQ

`hq/` is the local Node control surface. Its server talks to Alfred through authenticated ADB and serves the browser interface on loopback.

```sh
cd hq
npm start
```

Open `http://127.0.0.1:4173`. Home shows live connectivity, battery, firmware, Linux, network, storage, thermal, and service telemetry. Cockpit shows the live 864×480 front camera and LIDAR point cloud. Movement controls remain inactive until their robot interfaces and safety behavior are implemented.

## Engine

`engine/` is a componentized Rust HTTP runtime deployed to `/data/alfred/alfred-engine`. It binds only to robot loopback and is reached through authenticated ADB forwarding. Its writable autostart integration requires no further firmware changes.

```sh
cargo zigbuild --manifest-path engine/Cargo.toml --release --target aarch64-unknown-linux-musl
python3 setup/deploy_engine.py
```

HTTP interface:

- `GET /health`
- `GET /v1/telemetry/battery`
- `GET /v1/telemetry/lidar`
- `GET /v1/camera/frame` (JPEG with frame metadata headers)
- `POST /v1/audio/play` with an `audio/ogg` body and `Content-Length`
- `POST /v1/audio/stock/{number}`
- `PUT /v1/audio/volume/{percent}`

The engine persistently subscribes to the robot's ROS battery, charge-state, and LIDAR topics. It activates the stock VPS/VENC camera path and maintains a low-rate JPEG snapshot feed without replacing the vendor media stack. Battery observations are cached under `/data/alfred/state/`, so HQ retains the last known value across engine restarts. A fresh installation reports no battery value until the firmware publishes its first power event.

The Mac's default libusb ADB backend fails with this robot; tools set `ADB_LIBUSB=0`. If an incompatible server is already running, stop it with `adb kill-server` before starting the native backend (this disconnects other ADB devices too).

## Layout

- `runtime/`: normal connection, shell, status, audio playback.
- `hq/`: Node server and minimal browser control surface.
- `engine/`: minimal on-robot Rust command and streamed-audio engine.
- `setup/`: initial access, authenticated startup, image preparation and installation.
- `setup/research/`: archived investigation helpers, not the everyday interface.
- `docs/`: verified findings, setup and recovery notes.
- `artifacts/`: local firmware images, backups, generated clips, and build outputs; ignored by Git.
- `robot.json`: non-secret device identity and connection defaults.

Wi-Fi passwords and private ADB keys are not stored in this project. The robot trusts the existing Mac ADB public key in `/data/misc/adb/adb_keys`. Network ADB uses key authentication on TCP 5555; keep it on the local network.

See [setup and recovery](docs/setup.md) for boot persistence status and rollback.
