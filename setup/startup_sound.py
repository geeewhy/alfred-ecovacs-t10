#!/usr/bin/env python3
"""Install or restore native startup and charging announcements without flashing rootfs."""
import argparse, pathlib, subprocess, sys, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot
PROFILES={
    'startup':{'text':'Hello, my good sir.','targets':['/media/music/ZH/0.ogg']},
    'charging':{'text':"I'm going to take a rest here, my dear sir.",'targets':['/media/music/EN/119.ogg','/media/music/ZH/119.ogg']},
}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event',choices=PROFILES,default='startup')
    parser.add_argument('--restore',action='store_true')
    parser.add_argument('--preview',action='store_true')
    args=parser.parse_args();robot=Robot();profile=PROFILES[args.event];targets=profile['targets'];event=args.event
    if args.restore:
        robot.shell('rm -f /data/alfred/'+event+'-sound.enabled')
        for target in targets:
            robot.shell('if grep -q " '+target+' " /proc/mounts; then umount '+target+'; fi')
        print('Original firmware '+event+' sound restored.');return
    robot.shell('mkdir -p /data/alfred/audio /data/alfred/backups')
    for target in targets:
        backup='/data/alfred/backups/'+event+'-'+target.split('/')[-2]+'-original.ogg'
        robot.shell('if ! test -f '+backup+'; then cp '+target+' '+backup+'; fi')
    with tempfile.TemporaryDirectory() as temp:
        source=pathlib.Path(temp)/'greeting.aiff';clip=pathlib.Path(temp)/'greeting.ogg'
        subprocess.run(['say','-v','Daniel','-o',str(source),profile['text']],check=True,timeout=15)
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),'-ar','16000','-ac','1','-c:a','libvorbis',str(clip)],check=True,timeout=15)
        robot.upload(clip,'/data/alfred/audio/'+event+'.ogg.new')
    robot.upload(ROOT/'setup/startup-sound.sh','/data/alfred/startup-sound.sh')
    robot.upload(ROOT/'setup/rolling_log.py','/data/alfred/rolling_log.py')
    robot.upload(ROOT/'setup/adb_supervisor.py','/data/alfred/adb_supervisor.py')
    robot.upload(ROOT/'setup/adb-start.sh','/data/alfred/adb-start.sh')
    robot.shell('sh -n /data/alfred/adb-start.sh && sh -n /data/alfred/startup-sound.sh && chmod 700 /data/alfred/adb-start.sh /data/alfred/startup-sound.sh')
    for target in targets:
        robot.shell('if grep -q " '+target+' " /proc/mounts; then umount '+target+'; fi')
    robot.shell('mv /data/alfred/audio/'+event+'.ogg.new /data/alfred/audio/'+event+'.ogg; touch /data/alfred/'+event+'-sound.enabled; sh /data/alfred/startup-sound.sh; sync')
    print(robot.shell('md5sum /data/alfred/audio/'+event+'.ogg '+' '.join(targets)))
    if args.preview:
        # Same path and player used by stock play_boot_music.sh.
        print(robot.play(targets[0]))
    print('Installed '+event+': '+profile['text']+' (Daniel).')

if __name__=='__main__':main()
