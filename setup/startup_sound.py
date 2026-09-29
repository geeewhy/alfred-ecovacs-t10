#!/usr/bin/env python3
"""Install or restore native Alfred announcements without flashing rootfs."""
import argparse, pathlib, subprocess, sys, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'runtime'))
from alfred import Robot
PROFILES={
    'startup':{'text':'Hello, my good sir.','targets':['/media/music/ZH/0.ogg']},
    'charging':{'text':"Recharging sir.",'targets':['/media/music/EN/119.ogg','/media/music/ZH/119.ogg']},
}

# Verified English firmware clip IDs; both installed language paths use Daniel.
ANNOUNCEMENTS = {
    'returning': (117, 'Returning sir.'),
    'return-cancelled': (118, 'Return cancelled sir.'),
    'docked': (20, 'Safely docked sir.'),
    'find-robot': (30, 'At your service.'),
    'resume-cleaning': (108, 'Resuming duties sir.'),
    'low-battery': (24, 'Battery depleted sir.'),
    'blocked': (122, 'Passage blocked sir.'),
    'lifted': (3, 'Lower me please.'),
    'brush-tangled': (31, 'Brush tangled sir.'),
    'dustbin-missing': (6, 'Dustbin missing sir.'),
    'wifi-setup': (137, 'Awaiting network sir.'),
    'wheels-stuck': (4, 'Wheels stuck sir.'),
    'cliff-sensors-dirty': (35, 'Clean cliff sensors.'),
    'bumper-stuck': (124, 'Bumper stuck sir.'),
    'charging-power-off': (29, 'Power on please.'),
    'station-not-found': (120, 'Station missing sir.'),
}
for event, (number, text) in ANNOUNCEMENTS.items():
    PROFILES[event] = {'text': text, 'targets': [f'/media/music/{lang}/{number}.ogg' for lang in ('EN', 'ZH')]}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--event',choices=[*PROFILES, "all"],default='startup')
    parser.add_argument('--restore',action='store_true')
    parser.add_argument('--preview',action='store_true')
    args=parser.parse_args();robot=Robot()
    for event in (PROFILES if args.event == 'all' else [args.event]):
        install(robot, event, args)

def install(robot, event, args):
    profile=PROFILES[event];targets=profile['targets']
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
