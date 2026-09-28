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
