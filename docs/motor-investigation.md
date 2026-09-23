# Motor investigation — September 22

Read-only firmware inspection and live ROS snapshot; no motion or interlock changes made.

- `engine/src/components/drive.rs` sends speed_type=0 (DRIVING) while naming values mm/s. Firmware `common::Wheel::onSetWheelSpeedMsgReceived` at 0xba0d0 directly truncates those floats to driving integers. Type=1 (PHYSICAL) first divides by the configured wheel conversion factor. Physical unit scale needs confirmation before changing deployed commands.
- The engine deadman stops motion after 350 ms without another command. A two-second test must refresh commands throughout; do not disable the deadman. A 0.2 linear input currently becomes 24 driving units, not verified 20% of motor maximum.
- The wheel callback builds a WA protocol packet without checking side-brush presence. This does not rule out MCU-level protection or higher-level stop commands.
- Firmware exposes MotorOnOffControl, MotorProtection, and motorEnable. Existence alone does not establish that an enable command is missing. motorEnable defaults to 1 when parsed config omits it.
- Live RobotInvalidState was value=1; its definition says this informs SLAM of invalid conditions, so it is not proof of a wheel inhibit.
- Live OnOffInfo: bump=0, down-in=0, fall=0, dirtbox=1; additional types 12=3 and 10=1 are not named in the supplied definition. Do not infer presence polarity from these raw values.
- Both wheel currents were zero at rest. Wheel distance was unchanged between snapshots. MotorProtection and ChargeState yielded no sample within two seconds; silence is not proof of no fault.
- Wheel command publishers include /node, /ROSNODE, and /alfred_engine; potential conflicting commands need capture during the bounded test.

Reusable read-only collector: `tools/motor_snapshot.py` (device Python 2), latest output `artifacts/motor-snapshot.jsonl`. Next establish which parts are disconnected and robot orientation, confirm physical units, and capture command/protection/encoder feedback during the requested bounded test.

## Forward test and conversion correction

A refreshed 0.2 forward command was sent for two seconds with an explicit stop. Capture confirmed WA commands traversing `/protocol/SendSAData` and `/comm/SendData`; wheel encoder feedback stayed unchanged during that run. No MotorProtection event arrived in the capture window.

Firmware initialization passes wheel diameter 71.0, spacing 211.9, encoder factor 20, and reduction 61.915. `setWheelParameters` computes pi*71/(20*61.915), approximately 0.18013 mm per driving unit. Physical mode divides the requested speed by this factor. Thus the old 24-driving-unit command was approximately 4.32 mm/s. Engine serialization now selects physical mode for its existing mm/s values: linear=0.2 requests 24 mm/s, approximately 133 driving units. This is 20% of the engine cap, not a claim about the motor's rated maximum.

POC result: `tools/wheel_poc.py` published physical-mode 24 mm/s commands for two seconds directly to ROS, with a separate stop timer and final zero commands. Both encoder readings increased and both wheel currents became nonzero, returning to zero after stop. No protection bypass was used. User confirmed physical movement. Capture: `artifacts/wheel-poc.jsonl`. Engine build succeeded, but deployment was interrupted during host HTTP server setup, before binary transfer; keep further experimentation in probe code per user instruction.

## Sleep caused the later wheel and LIDAR outage

Confirmed on device: `/task/RobotManage` request byte 1 returned uint32 1 (asleep). ADB, camera, and WA delivery remained functional, but encoders were static and wheel currents zero. `notifyQuitErp` and native app STOP did not wake this idle state. A native WorkManage remote-control STOP cleared sleep to 0, restored LIDAR (~980 points, advancing sequences), and restored the identical 24 mm/s, two-second wheel POC. Currents returned to zero after stop. Capture: `artifacts/wake-wheel-poc.jsonl`.

Repeatable device probes: `robot_sleep_state.py`, `native_wake_poc.py --remote`, then `wheel_poc.py`. Upload their imports too. The wake probe sends no nonzero wheel command. Live WorkManage MD5 is `02b48ec9983e0e81cc0e264c502c304b`; its request is two uint8 fields, a string, and WorkData. The shipped Python stubs are stale. The 74-byte empty remote STOP request sets byte 1 to 9 and byte 59 to 2. RobotManage MD5 is `cfd9e920d932894ddac5afdaed914536`; its response is uint32, not the stub's uint8.

Firmware trace: WorkManage remote request emits 0x1009, handled by `JobLogic::app_remoteCtrl` at 0x2c530, which calls `SleepWorkUp` before starting remote work. Direct wheel publication bypasses this scheduler activity. Engine now checks native sleep before nonzero drive, wakes with this verified STOP request, and requires a subsequent awake confirmation before motion. Cockpit allows idle sleep; held drive controls automatically retry while the engine wakes and confirms readiness. Stop/deadman never wait on wake RPC; delayed drive requests are invalidated by stop and expire after 350 ms. RPCs have a 250 ms timeout and validate firmware MD5.
