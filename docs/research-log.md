# T10 Omni USB and root-access research

## Device and observations

User photo confirms DBX53 / FCC ID 2AZAT-DBX53, marketed as T10 Omni. User wants to retain working stock functionality. Robot has now been charged. Ordinary USB cable connection through multiple hubs/cables has not produced a robot USB device in macOS IORegistry. Hubs themselves enumerate. This does not distinguish disabled USB gadget software, boot-mode requirements, port/cable issues, or other hardware behavior. No robot commands or firmware writes performed.

## Findings

- Dennis Giese's current Ecovacs overview and `ecovacs.jtmf04` entry identify T10 Omni/ZJ2209 as Horizon X3M and list public UART rooting. A second older-looking `ecovacs.t10.omni` entry instead has unfilled root support and no public method. These entries are inconsistent; don't treat the database as proof that this particular firmware is rootable. The jtmf04 entry's N10-named firmware files are another reason not to use its downloads blindly.
  - https://robotinfo.dev/robotinfo_ecovacs.html
  - https://robotinfo.dev/detail_ecovacs.jtmf04_0.html
  - https://robotinfo.dev/detail_ecovacs.t10.omni_0.html
- Firsthand Reddit report, N8: micro-USB to iMac did not enumerate. Follow-up includes another owner's successful UART boot logs/login prompt. A comment suggesting a secret button sequence is speculation, not a demonstrated procedure.
  - https://www.reddit.com/r/robotics/comments/1hkho0h/
  - https://www.reddit.com/r/robotics/comments/1hknivp/following_up_on_my_ecovacs_deebot_n8_hacking/
- Firsthand T50 Max Pro report describes holding S1/Wi-Fi reset during power-on to enter USB LOADER mode. That board uses Rockchip RK3562, unlike the T10 Omni's documented Horizon X3M. Do not present this as a T10 procedure.
  - https://www.reddit.com/r/RobotVacuums/comments/1so7eyh/t50_max_pro_bricked_after_ota_need_eco_partition/
- X1 Omni firsthand notes describe UART at 115200 baud and root login, then optional filesystem modifications. Author reports reversed connector orientation relative to research diagram; physical pinout must be checked. Notes mention `/etc/conf/adbkey.pub`, but provide no verified USB-only unlock procedure.
  - https://github.com/itsjfx/ecovacs-hacking/blob/master/x1_omni.md
- X3 platform documentation supports USB ADB, gadget roles, and fastboot. Its fastboot entry methods require existing Linux/U-Boot access or a development-board switch. These are platform capabilities, not confirmed T10 firmware behavior.
  - https://developer.d-robotics.cc/api/v1/fileData/documents/bsp_develop/driver_devolep_guide/21-USB_Gadget_User_Guide.html
- Original Ecovacs research includes root-password derivation and debug connector diagrams. Web password calculator does not explicitly offer T10; correct model-specific calculation remains unresolved.
  - https://dontvacuum.me/talks/DEFCON32/DEFCON32_reveng_hacking_ecovacs_robots.pdf
  - https://builder.dontvacuum.me/ecopassword.php
- Additional GitHub project `kushagharahi/ecovacs-privacy-control` covers an older Rockchip RV1108/900-family device, not T10; its debug tricks cannot be assumed applicable.
- Searched English and Chinese terms for T10/DBX53/ZJ2209 USB, ADB, debug mode, boot buttons, and rooting, plus Reddit and GitHub. Found no verified T10 Omni USB-only entry sequence. 4PDA search snippets surfaced discussions but direct page retrieval failed.

## Recommended next step

Identify the physical debug header and confirm its UART pinout and signal voltage before connecting a 3.3 V logic USB-to-UART adapter. Obtain read-only boot logs and the installed firmware identity before pursuing root credentials or persistent modifications. USB-only mode remains unverified, not disproven.

## Broader Ecovacs alternatives

- Bumper's T10 Plus guide documents UART bootloader interruption and a temporary `init=/bin/bash` boot argument, offering an alternative to the normal root-password login. Still requires UART hardware. Exact bootloader behavior on this Omni is unknown. https://mvladislav.github.io/bumper/internals/certificate-unpinning-bot/
- `denysvitali/ecovacs-firmware-tools` downloads OTA images and decrypts their sections; examples cover T9 AIVI and N8 Pro. Offline inspection of matching firmware is a promising no-new-hardware research path to find USB gadget/adbd initialization or boot triggers. T10 Omni compatibility untested. https://github.com/denysvitali/ecovacs-firmware-tools
- Bluetooth command injection was demonstrated across some Ecovacs products; vendor advisory lists X2, X5 Pro variants, T30 Omni, and T30S with patched versions. No evidence here that the T10 Omni exposes the affected BLE interface. https://www.ecovacs.com/global/userhelp/dsa20241119
- MVladislav's Bumper fork lists tested T10 Plus and X1/X2/X9/T80 models. It replaces cloud services; it does not itself grant a Linux shell. Some firmware needs certificate changes through root/UART, so not universally a no-root route. https://github.com/MVladislav/bumper
- Home Assistant's Ecovacs integration provides ordinary control and telemetry via account/cloud, with self-hosted Bumper configuration also documented. Useful for functional reuse without initially obtaining root. https://www.home-assistant.io/integrations/ecovacs

## Subsequent physical experiments

Multiple 55-second USB polling windows (quarter-second snapshots) showed no new robot device; precise coverage of earliest power-on was not guaranteed. User attempted a Wi-Fi/reset button hold. Robot later announced reset to default settings and rebooted. Subsequent USB checks still found only hubs and their peripherals. Slow-blinking indicator was identified as the Wi-Fi light. User accepts reset and currently has only ordinary micro-USB cables, no UART adapter.

## Latest firmware inspected offline

Official Ecovacs advisory dsa20241217001 identifies T10 OMNI as `lx3j7m`; `jtmf04` is plain T10, despite conflicting community metadata. GET `https://portal-ww.ecouser.net/api/ota/products/wukong/class/lx3j7m/firmware/latest.json?ver=1.9.0&module=fw0` returned 1.11.0. Query with ver=1.11.0 returned 404; this establishes latest offered for the tested request, not every regional/device rollout.

Downloaded `out/firmware/lx3j7m-1.11.0.bin` (160527256 bytes), MD5 `729a77b1f0052dca32c62094df4069ae` matches server metadata. Offline extraction using the algorithm from denysvitali/ecovacs-firmware-tools succeeded for all 11 sections; SHA256 verified for every section. Reproducible extraction script and metadata saved beside image. Manifest product zj2116c, fw_ver 1.11.0, release_date 2025-05-07-09:59:11. Rootfs and recovery extracted with squashfs; no firmware executed or flashed. Installed Homebrew squashfs for extraction.

Direct evidence in extracted files:
- `rootfs/etc/rc.conf`: `!adbd.sh`; `etc/rc.sysinit` explicitly skips `!` entries. Normal startup disables ADB.
- `recovery/etc/rc.conf`: `adbd.sh` enabled. Both ADB scripts require `/sys/devices/platform/soc/b2000000.usb/b2000000.dwc3/role` to equal `device` before enabling gadget. Recovery configuration alone is not proof a physical boot-button sequence reaches recovery or selects device mode.
- `etc/rc.d/adbd.sh`: VID 18d1, PID 4e26, manufacturer hobot, product xj3.
- `rootfs/etc/conf/key-service.conf`: short press 200ms; long press 5000ms.
- `rootfs/etc/conf/medusa/press_key_help.sh`: short press initiates Wi-Fi/AP configuration; long press factory-resets and reboots; multi press handles livePWD. No ADB enabling in these normal-runtime button hooks. Bootloader button handling remains unverified.

User observed: with button held at boot no startup sound; main power switch off leaves board apparently on until USB unplugged. This is consistent with USB powering some circuitry but does not establish USB data communication or recovery mode. Immediate Mac IOUSB and `adb devices -l` checks show hubs/accessories only and no ADB device. No new serial device.

## USB role and alternate local access investigation

Parsed UBI (262144-byte PEBs), Android boot image, and four appended DTBs offline with `out/firmware/inspect_boot.py`. T10-specific DTB (`dtb-4-6431744.txt`) explicitly names `Ecovacs X3 + T10`:
- DWC3 `dr_mode=otg`, extcon wired to `linux,extcon-usb-gpio`, ID GPIO index 0x41 (65), active high.
- GPIO button uses index 0x15 (21), distinct from USB role input.
- Vendor public kernel `D-Robotics/kernel` extcon driver maps ID high to device and ID low to host. Public `main-ubuntu-20.04/drivers/usb/dwc3/core.c` implements writable `role`, accepting device/host/otg. This is vendor reference code, not proof it exactly matches the robot's 4.14.74 kernel (built Sep 3 2022).
- No verified physical button-to-recovery path established. Firmware recovery flag uses boot_mode2 in sys UBI; changing it requires existing access and is not attempted.

Alternative: pairing-mode `wd_hook.sh` starts GoAhead on TCP 8888, default AP 192.168.0.1, SSID ECOVACS_<serial last4>. Network completion closes this service. `etc/www/cgi-bin/startFct` is unstripped. Disassembly shows JSON `key` passed unchanged into `snprintf("td=\"StartFactory\" key=%s  %s & ",key,factory_hook)`, then popen; captured stdout is returned. This appears to permit shell injection via local pairing service, pending runtime verification; no live exploit has been run. Prepared read-only diagnostic `probe-local-setup.py`: comments out factory hook, prints id and current USB role. Robot network identity must be established before running it. User asked whether robot AP visible via async question. Potential next step after confirmed read-only access: temporary USB role/ADB activation, without flashing or persistent writes.

## Live access and Wi-Fi restoration results

Confirmed live root command execution via pairing CGI: response `uid=0(root) gid=0(root)` and USB role `device`. Temporary ADB start requested via same CGI, but no ADB USB enumeration afterward; startup log not yet retrieved. No firmware flashed.

Mac Wi-Fi return failed twice with networksetup error -3900 despite exit code 0; user manually restored connection. Initial script also used competing restoration retries, removed later. User supplied home Wi-Fi password; explicit password-assisted join now completed without error, Mac address 192.168.1.147 with router 192.168.1.1 verified. Password not saved in research artifacts. Script now refuses actual switch unless return password is provided via environment, uses it in the sole restore process, checks output for failure despite exit code 0, and verifies home subnet. No further robot-network switch performed after user complaint. User has authorized connecting robot to home Wi-Fi, but this remains undone.

## Success: authenticated ADB on home Wi-Fi

Live firmware confirmed 1.11.0, zj2116c, Linux 4.14.74. Pairing network ECOVACS_0150 worked in successful tool calls, although user reported seeing ECOVACS_150. Do not assume future name without checking.

Retrieved ADB log: gadget enabled, daemon running, controller `not attached`. USB physical enumeration remains unresolved.

Inspected libcutils: property_get reads environment variables prefixed PROP_. Started adbd with `PROP_service.adb.tcp.port=5555 PROP_ro.adb.secure=1`, after adding Mac's existing ADB public key to `/data/misc/adb/adb_keys`. Uploaded only public key, no private key. Started temporarily, no boot persistence installed. Provisioned user-authorized home Wi-Fi via netmon_ctl ap_event. Credentials were passed in memory and not recorded in artifacts.

Robot MAC 14:f5:f9:31:93:3b matched home IP 192.168.1.89. `adb connect 192.168.1.89:5555` succeeded; `adb devices -l` shows device (authorized). `adb -s 192.168.1.89:5555 shell id` returned uid=0(root) gid=0(root). medusa and deebot processes remain running. Physical cleaning behavior not tested. Mac restoration now verified with supplied password. Network ADB may stop after robot reboot; home Wi-Fi and authorized public key are saved, but no startup modification made.

Silent CGI commands return misleading factory-hook error because wrapper treats zero stdout as failure. Subsequent authenticated ADB connection verifies key upload and daemon startup actually succeeded.

## Success: USB ADB

User changed cable/hub; Mac now enumerates xj3 through Apple USB-C Digital AV Multiport Adapter hub. Default Mac adb 35.0.2 libusb backend crashed/failed startup clearing halt on endpoint 0x81. Starting server with `ADB_LIBUSB=0 adb start-server` succeeded. `adb devices -l` lists USB serial ZJ2116C14F5F931933B as device. This isolates prior non-enumeration to the old physical setup, although it does not distinguish the cable from the hub. Use native backend for future server starts.
