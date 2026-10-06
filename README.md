# Alfred

This started with an Ecovacs T10 Omni that didn't vacuum right. We had no idea what was running inside. Could've been potatoes.

Now it chases the cat around the house, builds maps with LiDAR, and takes voice commands.[^1] A browser cockpit gives us a live camera feed, remote driving, named map sections and return-to-dock controls. A custom Rust engine runs onboard.

Built for the DBX53 on firmware 1.11.0.

## Run it

Start with [setup and recovery](docs/setup.md), then [deploy the engine](docs/runtime.md). Provisioning enables persistent authenticated root access. Keep the stock backup and a working USB connection during setup.

Set your device details in `robot.json`. With Node.js 22 or later:

```sh
cd hq
npm ci
npm start
```

Open http://127.0.0.1:4173. See [voice setup](docs/hq-chat.md) for wake-word detection and spoken commands.

`engine/` runs on the robot. `hq/` serves the cockpit. `setup/` and `runtime/` handle provisioning, recovery and host tools.

[Navigation](docs/native-navigation.md) · [Cat-follow](docs/cat-follow.md) · [Runtime tools](docs/runtime.md)

[^1]: AI conversation and LLM integration are powered by [Haicue](https://haicue.com/pilot).
