#!/bin/sh
# Run by Alfred's autostart hook before stock play_boot_music.sh.
[ -f /data/alfred/startup-sound.enabled ] || exit 0
SOURCE=/data/alfred/audio/startup.ogg
TARGET=/media/music/ZH/0.ogg
[ -s "$SOURCE" ] && [ -f "$TARGET" ] || exit 1
grep -q " $TARGET " /proc/mounts && exit 0
mount -o bind "$SOURCE" "$TARGET"
