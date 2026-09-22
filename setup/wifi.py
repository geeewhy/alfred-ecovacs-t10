#!/usr/bin/env python3
"""Reusable macOS native targeted Wi-Fi scan/association. No implicit retries."""
import argparse,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
def binary():
    source=ROOT/'setup/wifi.m';target=ROOT/'artifacts/bin/wifi';target.parent.mkdir(parents=True,exist_ok=True)
    if not target.exists() or source.stat().st_mtime>target.stat().st_mtime:
        subprocess.run(['clang','-fno-modules','-framework','Foundation','-framework','CoreWLAN',str(source),'-o',str(target)],check=True,capture_output=True)
    return target

def call(action,ssid):
    r=subprocess.run([str(binary()),action,ssid],capture_output=True,text=True,timeout=15)
    result=json.loads(r.stdout)
    if r.returncode or not result.get('ok'):raise RuntimeError(json.dumps(result))
    return result

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['scan','join']);p.add_argument('ssid');a=p.parse_args()
    print(json.dumps(call(a.action,a.ssid),indent=2))
if __name__=='__main__':main()
