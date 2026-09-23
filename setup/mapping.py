#!/usr/bin/env python3
"""Prepare the pinned Linux mapping service; run --build once, then --start."""
import argparse, pathlib, subprocess, tempfile, json
ROOT=pathlib.Path(__file__).resolve().parents[1]
COMMIT='326cf8a0b487c34246bb8f3326afbcd69576dc60'
def run(*args):return subprocess.run(args,cwd=ROOT,check=True,timeout=15)
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--build',action='store_true');p.add_argument('--start',action='store_true');p.add_argument('--fresh',action='store_true',help='Reinstall ROS dependencies instead of reusing the installed image');a=p.parse_args()
 if a.build:
  vendor=ROOT/'mapping/vendor/m-explore-ros2'
  if not vendor.exists():
   vendor.parent.mkdir(parents=True,exist_ok=True)
   run('git','clone','https://github.com/robo-friends/m-explore-ros2.git',str(vendor))
   run('git','-C',str(vendor),'checkout',COMMIT)
   run('git','-C',str(vendor),'apply',str(ROOT/'mapping/patches/frontier-target.patch'))
  actual=subprocess.check_output(['git','-C',str(vendor),'rev-parse','HEAD'],text=True,timeout=3).strip()
  if actual!=COMMIT:raise RuntimeError('Unexpected explorer source revision')
  run('git','-C',str(vendor),'apply','--reverse','--check',str(ROOT/'mapping/patches/frontier-target.patch'))
  log=ROOT/'artifacts/hq/mapping-build.log';log.parent.mkdir(parents=True,exist_ok=True)
  # Public image pull needs no account credentials or desktop credential helper.
  config=pathlib.Path(tempfile.mkdtemp(prefix='alfred-docker-'));(config/'config.json').write_text('{}')
  plugins=pathlib.Path.home()/'.docker/cli-plugins'
  if plugins.exists():(config/'cli-plugins').symlink_to(plugins,target_is_directory=True)
  host='unix://'+str(pathlib.Path.home()/'.docker/run/docker.sock')
  installed=subprocess.run(['docker','image','inspect','alfred-mapping:jazzy'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3).returncode==0
  dockerfile='mapping/Dockerfile.runtime' if installed and not a.fresh else 'mapping/Dockerfile'
  with log.open('w') as output:
   process=subprocess.Popen(['docker','--config',str(config),'-H',host,'build','-f',dockerfile,'-t','alfred-mapping:jazzy','mapping'],cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
  print(json.dumps({'buildPid':process.pid,'log':str(log)}))
 if a.start:
  run('docker','compose','-f','mapping/compose.yaml','up','-d')
  print('Mapping service: http://127.0.0.1:48766/status')
 if not a.start and not a.build:p.print_help()
if __name__=='__main__':main()
