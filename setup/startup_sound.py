#!/usr/bin/env python3
"""Install or restore the robot's native boot greeting without flashing rootfs."""
import argparse, pathlib, subprocess, sys, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot
TARGET='/media/music/ZH/0.ogg'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore',action='store_true')
    parser.add_argument('--preview',action='store_true')
    args=parser.parse_args();robot=Robot()
    if args.restore:
        robot.shell('rm -f /data/alfred/startup-sound.enabled; if grep -q " '+TARGET+' " /proc/mounts; then umount '+TARGET+'; fi')
        print('Original firmware boot sound restored.');return
    robot.shell('mkdir -p /data/alfred/audio /data/alfred/backups; if ! test -f /data/alfred/backups/startup-original.ogg; then cp '+TARGET+' /data/alfred/backups/startup-original.ogg; fi')
    with tempfile.TemporaryDirectory() as temp:
        source=pathlib.Path(temp)/'greeting.aiff';clip=pathlib.Path(temp)/'greeting.ogg'
        subprocess.run(['say','-v','Daniel','-o',str(source),'Hello, my good sir.'],check=True,timeout=15)
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),'-ar','16000','-ac','1','-c:a','libvorbis',str(clip)],check=True,timeout=15)
        robot.upload(clip,'/data/alfred/audio/startup.ogg.new')
    robot.upload(ROOT/'setup/startup-sound.sh','/data/alfred/startup-sound.sh')
    robot.upload(ROOT/'setup/rolling_log.py','/data/alfred/rolling_log.py')
    robot.upload(ROOT/'setup/adb-start.sh','/data/alfred/adb-start.sh')
    robot.shell('sh -n /data/alfred/adb-start.sh; sh -n /data/alfred/startup-sound.sh; chmod 700 /data/alfred/adb-start.sh /data/alfred/startup-sound.sh; mv /data/alfred/audio/startup.ogg.new /data/alfred/audio/startup.ogg; if grep -q " '+TARGET+' " /proc/mounts; then umount '+TARGET+'; fi; touch /data/alfred/startup-sound.enabled; sh /data/alfred/startup-sound.sh; sync')
    print(robot.shell('md5sum /data/alfred/audio/startup.ogg '+TARGET+'; grep " '+TARGET+' " /proc/mounts'))
    if args.preview:
        # Same path and player used by stock play_boot_music.sh.
        print(robot.play(TARGET))
    print('Installed: Hello, my good sir. (Daniel). Next normal power-on uses the native boot player.')

if __name__=='__main__':main()
