#!/bin/sh
# Native announcement overlays, reapplied by Alfred's existing autostart hook.
apply_sound() {
    EVENT="$1"
    TARGET="$2"
    SOURCE="/data/alfred/audio/$EVENT.ogg"
    [ -f "/data/alfred/$EVENT-sound.enabled" ] || return 0
    [ -s "$SOURCE" ] && [ -f "$TARGET" ] || return 1
    grep -q " $TARGET " /proc/mounts && return 0
    mount -o bind "$SOURCE" "$TARGET"
}
apply_sound startup /media/music/ZH/0.ogg
apply_sound charging /media/music/EN/119.ogg
apply_sound charging /media/music/ZH/119.ogg
apply_sound returning /media/music/EN/117.ogg
apply_sound returning /media/music/ZH/117.ogg
apply_sound return-cancelled /media/music/EN/118.ogg
apply_sound return-cancelled /media/music/ZH/118.ogg
apply_sound docked /media/music/EN/20.ogg
apply_sound docked /media/music/ZH/20.ogg
apply_sound find-robot /media/music/EN/30.ogg
apply_sound find-robot /media/music/ZH/30.ogg
apply_sound resume-cleaning /media/music/EN/108.ogg
apply_sound resume-cleaning /media/music/ZH/108.ogg
apply_sound low-battery /media/music/EN/24.ogg
apply_sound low-battery /media/music/ZH/24.ogg
apply_sound blocked /media/music/EN/122.ogg
apply_sound blocked /media/music/ZH/122.ogg
apply_sound lifted /media/music/EN/3.ogg
apply_sound lifted /media/music/ZH/3.ogg
apply_sound brush-tangled /media/music/EN/31.ogg
apply_sound brush-tangled /media/music/ZH/31.ogg
apply_sound dustbin-missing /media/music/EN/6.ogg
apply_sound dustbin-missing /media/music/ZH/6.ogg
apply_sound wifi-setup /media/music/EN/137.ogg
apply_sound wifi-setup /media/music/ZH/137.ogg
apply_sound wheels-stuck /media/music/EN/4.ogg
apply_sound wheels-stuck /media/music/ZH/4.ogg
apply_sound cliff-sensors-dirty /media/music/EN/35.ogg
apply_sound cliff-sensors-dirty /media/music/ZH/35.ogg
apply_sound bumper-stuck /media/music/EN/124.ogg
apply_sound bumper-stuck /media/music/ZH/124.ogg
apply_sound charging-power-off /media/music/EN/29.ogg
apply_sound charging-power-off /media/music/ZH/29.ogg
apply_sound station-not-found /media/music/EN/120.ogg
apply_sound station-not-found /media/music/ZH/120.ogg
