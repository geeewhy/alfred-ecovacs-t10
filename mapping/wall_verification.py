"""Reachable standoff positions for bounded close inspection of map surfaces."""
import math
import numpy as np
from scipy.ndimage import label

def wall_goal(grid,resolution,origin,pose,walls,attempted,deep=False):
    components,_=label(grid==0);h,w=grid.shape
    def cell(x,y):return int((x-origin[0])/resolution),int((y-origin[1])/resolution)
    rx,ry=cell(pose['x'],pose['y'])
    if not(0<=rx<w and 0<=ry<h) or not components[ry,rx]:return None
    home=components[ry,rx];best=None
    for wall in walls:
        a,b=wall['points'];length=math.hypot(b[0]-a[0],b[1]-a[1])
        if length<(.3 if deep else .8):continue
        ux,uy=(b[0]-a[0])/length,(b[1]-a[1])/length
        for t in ([((wall["sample"][0]-a[0])*ux+(wall["sample"][1]-a[1])*uy)] if "sample" in wall else np.linspace(.25,length-.25,max(2,math.ceil(length)))):
            surface=(a[0]+t*ux,a[1]+t*uy)
            nearby=[p for p in attempted if math.hypot(surface[0]-p['surface'][0],surface[1]-p['surface'][1])<.55]
            if len(nearby)>=3 or any(p.get('result') in ('contact','close_scan','observed') for p in nearby):continue
            for side,offset in [(side,offset) for side in [-1,1] for offset in [0.,-.3,.3]]:
                x=surface[0]-side*uy*.36+offset*ux;y=surface[1]+side*ux*.36+offset*uy
                if any(math.hypot(x-p['x'],y-p['y'])<.22 for p in nearby):continue
                gx,gy=cell(x,y)
                if not(0<=gx<w and 0<=gy<h) or components[gy,gx]!=home:continue
                distance=math.hypot(x-pose['x'],y-pose['y'])
                if not deep and distance>4.:continue
                score=distance+.15*abs(math.atan2(math.sin(math.atan2(y-pose['y'],x-pose['x'])-pose['theta']),math.cos(math.atan2(y-pose['y'],x-pose['x'])-pose['theta'])))
                if best is None or score<best[0]:best=(score,{'x':float(x),'y':float(y),'theta':math.atan2(surface[1]-y,surface[0]-x),'surface':list(surface),'wall_id':wall['id'],'kind':'wall','unknown':bool(wall.get('unknown'))})
    return best[1] if best else None
