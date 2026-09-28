# Charging-contact automatic return

The T10 1.11.0 scheduler has a separate contact-loss return trigger. Direct wheel
commands do not change its remembered charging work type. In
`JobLogic::chargeSigDetTimer10s()` (ELF address/file offset `0x24590`, size 1660),
the work-type-7 path checks `in_station` at state+0x1c and charging at state+0x10.
If contact is lost, it clears the job queue, appends return job type 5 and calls
`JobQueueExecutor::manualStart`. Paused and station-work paths also schedule return.
This explains a firmware route back after a manual departure while the custom
return controller is idle. The individual reported departure was not recorded.

On 2026-09-27 the user explicitly requested disabling this firmware behavior.
The deployed policy changes this void callback's first instruction from
`sub sp, sp, #0x210` (`ff4308d1`) to `ret` (`c0035fd6`) in the running process.
A second contact-signal-count timer (`ChargeSigCountTimer15s`) also queues type-5
return when its counter exceeds 10 and admission returns 0x13. Its conditional
branch at `0x2dad4` is changed from `b.eq` (`e0010054`) to `nop` (`1f2003d5`),
so it falls through to the existing counter reset without scheduling motion.
Other contact observers/timers remain intact.

The policy does not change the library on disk, restart firmware, or disable charging
telemetry. Explicit native return, custom return and other firmware triggers
(including low-battery handling) are outside this callback and remain untouched.
Loss of charging contact will no longer cause this automatic reseating behavior.

`setup/contact_return_patch.c` uses a brief PTRACE_SEIZE/INTERRUPT stop, then
PTRACE_POKETEXT and readback, preserving the adjacent instruction with aligned eight-byte writes. The Linux
executable-page write path handles instruction-cache maintenance. The helper
always attempts detach and never requests EXITKILL or process restart. Its
on-device `selftest` patches and restores an executable callback in its own child,
checking actual execution results 42 -> 7 -> 42 before touching firmware.

`setup/firmware_policy.py` pins the full disk SHA-256 to
`41c8816113c3045e38934cd614b6cf4a304f7717086c31ae637c8ed60a1bf475`, validates the
loaded inode and instruction, and refuses other firmware or old overlays.
A locked, opt-in supervisor reapplies to replacement processes every two seconds;
`setup/adb-start.sh` launches it at boot, independently of HQ and the Rust engine.
Persistence is installed but a robot reboot has not been exercised in this run.
The older bind-mount/restart experiment is superseded and must not be reapplied.

Build and manage:

```sh
zig cc -target aarch64-linux-musl -Os -s -static -Wall -Wextra -Werror \
  setup/contact_return_patch.c -o artifacts/firmware-policy/contact-return-patch
python3 setup/auto_return.py enable   # disable automatic contact-loss return
python3 setup/auto_return.py status   # read actual live instruction
python3 setup/auto_return.py disable  # restore stock callback and remove boot flag
```

Verification: six policy tests, executable on-device patch/restore selftest,
both actual firmware instruction readbacks with PID unchanged, disk hash unchanged, and
charging/direct engine availability after activation. Manual departure remains
the user's next physical check; do not claim that reproduction passed yet.
