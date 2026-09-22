# Offline Ecovacs section extraction, adapted from denysvitali/ecovacs-firmware-tools.
import base64, hashlib, json, struct, subprocess
from pathlib import Path
root=Path(__file__).parent
b=(root/'lx3j7m-1.11.0.bin').read_bytes()
m=json.loads((root/'metadata.json').read_text())['fw0']
assert len(b)==m['size'] and hashlib.md5(b).hexdigest()==m['checkSum']
out=root/'decrypted'; out.mkdir(exist_ok=True)
off=0; i=0; manifest=None
while off+72<=len(b):
    a,c,t,n=struct.unpack_from('<BBHI',b,off)
    if a!=1 or c!=1 or n<=0 or off+72+n>len(b):
        off+=1; continue
    assert hashlib.sha256(b[off:off+8+n]).hexdigest().encode()==b[off+8+n:off+72+n]
    s=f'ZWNvX2Z3X3RhcmdldCAECO-PT1jdSAtpx30byBtYW4{t>>12}y5iaW4{n:x}825xxjeff-hk@126.com'
    h=hashlib.sha256(base64.b64encode(s.encode())[4:4+len(s)]).hexdigest()
    p=subprocess.run(['openssl','enc','-d','-aes-128-cbc','-K',h[35:51].encode().hex(),'-iv',h[:16].encode().hex()],input=b[off+8:off+8+n],capture_output=True,check=True)
    data=p.stdout
    if i==0:
        manifest=json.loads(data); name='manifest.json'; data=json.dumps(manifest,indent=2).encode()
    else:
        sec=manifest['sections'][i-1]; name=sec['name']+'.'+{'sh_script':'sh','fs':'img','img':'img'}.get(sec['type'],'bin')
    assert Path(name).name==name
    (out/name).write_bytes(data)
    print(i,off,n,name,'SHA256 verified')
    off+=72+n; i+=1
