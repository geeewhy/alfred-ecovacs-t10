from pathlib import Path
import struct,collections,json
root=Path(__file__).parent
b=(root/'decrypted/normal_boot.bin').read_bytes(); blocks=collections.defaultdict(dict)
for p in range(0,len(b),262144):
 if b[p:p+4]!=b'UBI#':continue
 vo,do=struct.unpack_from('>II',b,p+16); v=p+vo
 if b[v:v+4]!=b'UBI!':continue
 vid,ln=struct.unpack_from('>II',b,v+8); blocks[vid][ln]=b[p+do:p+262144]
for vid,bs in blocks.items():
 d=b''.join(bs[k] for k in sorted(bs)); (root/f'boot-volume-{vid}.bin').write_bytes(d); pos=0
 while True:
  p=d.find(b'\xd0\x0d\xfe\xed',pos)
  if p<0:break
  pos=p+4
  h=struct.unpack_from('>10I',d,p); size,ost,oss=h[1:4]
  if size>1000000 or size<40:continue
  dt=d[p:p+size]; (root/f'dtb-{vid}-{p}.dtb').write_bytes(dt)
  off=ost; stack=[]; lines=[]
  while off+4<=len(dt):
   tok=struct.unpack_from('>I',dt,off)[0];off+=4
   if tok==1:
    end=dt.index(0,off); stack.append(dt[off:end].decode());off=(end+4)&~3
   elif tok==2:stack.pop()
   elif tok==3:
    n,no=struct.unpack_from('>II',dt,off);off+=8;name=dt[oss+no:dt.index(0,oss+no)].decode(); val=dt[off:off+n];off=(off+n+3)&~3
    if val and val[-1]==0 and all(x==0 or 32<=x<127 for x in val):v=repr(val.rstrip(b'\0').decode())
    else:v=val.hex()
    lines.append('/'.join(stack)+' '+name+' = '+v)
   elif tok==9:break
   elif tok!=4:raise ValueError(tok)
  (root/f'dtb-{vid}-{p}.txt').write_text('\n'.join(lines))
  print('DTB',vid,p,size)
