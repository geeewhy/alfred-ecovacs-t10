"""Reachable observation positions for corners and partly hidden map boundaries.

The input is the live inflated costmap. We never shrink the robot footprint or
make occupied/unknown cells traversable to manufacture an inspection route.
"""
import math
import numpy as np
from scipy.ndimage import label, binary_dilation, distance_transform_edt, maximum_filter

def observation_goal(grid, resolution, origin, pose, visited):
    free=grid==0;components,_=label(free)
    x=int((pose['x']-origin[0])/resolution);y=int((pose['y']-origin[1])/resolution)
    h,w=grid.shape
    if not (0<=x<w and 0<=y<h) or not components[y,x]:return None
    reachable=components==components[y,x]
    # Unknown boundaries plus bends in measured obstacle surfaces. A second
    # viewpoint, not extra scans from the same position, reveals occluded sides.
    occupied=grid>=100
    horizontal=maximum_filter(occupied,size=(1,5))
    vertical=maximum_filter(occupied,size=(5,1))
    corners=(horizontal&vertical&~occupied)&binary_dilation(occupied)
    targets=((grid<0)&binary_dilation(free))|corners
    ty,tx=np.nonzero(targets)
    if not len(tx):return None
    stride=max(1,math.ceil(len(tx)/800));tx=tx[::stride];ty=ty[::stride]
    clearance=distance_transform_edt(free)*resolution
    best=None;step=max(1,round(.2/resolution))
    for gy,gx in zip(*np.nonzero(reachable)):
        if gx%step or gy%step or clearance[gy,gx]<.05:continue
        px=origin[0]+(gx+.5)*resolution;py=origin[1]+(gy+.5)*resolution
        distance=math.hypot(px-pose['x'],py-pose['y'])
        if distance<.45 or distance>2.:continue
        if any(math.hypot(px-v[0],py-v[1])<.65 for v in visited):continue
        distances=np.hypot(tx-gx,ty-gy)*resolution
        selected=np.flatnonzero((distances>.35)&(distances<1.4))
        visible=[]
        for i in selected:
            steps=max(2,int(distances[i]/resolution))
            xs=np.rint(np.linspace(gx,tx[i],steps)).astype(int);ys=np.rint(np.linspace(gy,ty[i],steps)).astype(int)
            # Inflated cells at the target itself are fine; sightlines may not
            # cross a measured obstacle before reaching the surface.
            if not np.any(occupied[ys[:-2],xs[:-2]]):visible.append(i)
        if len(visible)<3:continue
        score=len(visible)/(1+distance)
        if best is None or score>best[0]:
            target=visible[int(np.argmin(distances[visible]))]
            best=(score,{'x':px,'y':py,'theta':math.atan2(ty[target]-gy,tx[target]-gx)})
    return best[1] if best else None
