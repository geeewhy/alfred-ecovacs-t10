# Alfred in HQ

HQ sends user text to the dedicated Haicue session (Codex by default) using `hai session send`. Final replies are correlated by the request marker and Haicue turn ID from the transcript returned by `hai session inspect`. Personality lives in `hq/alfred-personality.md` and is included with every request, including after agent/model changes. HQ stores only its own conversation in `artifacts/hq/chat.json`. It displays final answers and optionally speaks them using the saved voice; never duplicate speech from the session.

Robot tools live in this repo. Read-only status: `GET http://127.0.0.1:4173/api/bots`; LIDAR `/api/bots/alfred/lidar`; camera `/api/bots/alfred/camera/frame`. These endpoints expose cached timestamps: distinguish fresh from stale. For richer device inspection use `python3 runtime/alfred.py shell '<command>'`.

Only drive when the current user message requests it. Engine commands through HQ: PUT `/api/bots/alfred/drive` with JSON `{linear,angular}` in [-1,1]; POST `/api/bots/alfred/drive/stop`. Speed settings: GET `/api/bots/alfred/drive/settings`. Movement requires bounded duration, refreshed commands, and an explicit stop in finally. The engine has a 350ms deadman and automatically wakes on drive intent. Do not bypass protections. Do not change settings or code merely to answer conversation.

Chat settings: GET/PUT `/api/bots/alfred/chat/settings` with `enabled`, `speaker`, `agent`, `model`. GET `/api/bots/alfred/chat` returns history/pending/errors. POST `/api/bots/alfred/chat` accepts `{text}`. No automatic resend after uncertain delivery. Speaker errors retain the text reply; past replies never play on refresh/restart. A long-running reply remains pending, avoiding accidental duplicate physical commands.

Chat mode uses the robot microphone, local Whisper on the Mac, then Haicue. No wake name is required. Settings selects the Haicue agent/model; History includes speaker output. Native English recognition uses Ecovacs cloud, not a verified offline transcription API.

Microphone transport: `runtime/robot_mic_server.py` calls the firmware TalkClient SDK directly for mono 16 kHz PCM. It pauses `speech_inter_client` while recording: both processes otherwise read `/dev/spidev1.0` and corrupt capture. The stock `audio_record` drops alternate samples; do not treat its output as 16 kHz. The bridge restores the stock assistant on disconnect and shutdown. `runtime/robot_mic.py` deploys/starts this automatically.

Voice/chat command timeouts are at most 15 seconds, polling is 1 second. After 15 seconds without a Haicue reply, HQ reports the delay but retains request correlation; it never resends robot commands automatically. Last transcription and audio levels are exposed in microphone status. Verified through robot mic → Whisper → Haicue → reply → robot playback acknowledgement; recognition can still mishear words.

Maps: GET `/api/maps` lists saved maps; GET `/api/maps/active` reports capture/exploration. POST `/api/maps/active/pause` stops and pauses it. The normal HQ drive-stop endpoint also cancels exploration, including a pending start. Use HQ stop rather than a direct engine stop while exploration is active, so the planner cannot send another movement command. Never resume mapping without an explicit user request. Full mapping workflow: `docs/maps.md`.
