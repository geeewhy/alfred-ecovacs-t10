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

def frontier_regions(grid,resolution,origin,pose,visited=None):
    components,_=label(grid==0)
    boundaries=(grid<0)&binary_dilation(grid==0)
    regions,_=label(boundaries,structure=np.ones((3,3)))
    sizes=np.bincount(regions.ravel());eligible=set(np.flatnonzero(sizes>=math.ceil(.35/resolution)));eligible.discard(0)
    reachable=set();h,w=grid.shape
    if pose:
        x=int((pose['x']-origin[0])/resolution);y=int((pose['y']-origin[1])/resolution)
        if 0<=x<w and 0<=y<h and components[y,x]>0:
            reachable=set(np.unique(regions[binary_dilation(components==components[y,x])&boundaries]))&eligible
    # Distant disconnected free-space islands can be returns through windows.
    # They are not unfinished rooms until a traversable connection or an actual
    # robot visit establishes that they belong to the explored floor.
    outside=set()
    if visited is not None:
        visited_components=set()
        for p in [*(visited or []),*([pose] if pose else [])]:
            vx=int((p['x']-origin[0])/resolution);vy=int((p['y']-origin[1])/resolution)
            if 0<=vx<w and 0<=vy<h and components[vy,vx]>0:visited_components.add(components[vy,vx])
        if visited_components:
            adjacent=binary_dilation(np.isin(components,list(visited_components)))&boundaries
            home_regions=set(np.unique(regions[adjacent]))&eligible
            outside=eligible-home_regions
            eligible=home_regions
            reachable&=eligible
    markers=[]
    for region in sorted(eligible-reachable):
        ys,xs=np.nonzero(regions==region)
        # Use an actual boundary cell nearest the center, not a centroid which
        # can lie inside an obstacle when the boundary is curved.
        index=int(np.argmin((xs-xs.mean())**2+(ys-ys.mean())**2))
        markers.append({'x':float(origin[0]+(xs[index]+.5)*resolution),'y':float(origin[1]+(ys[index]+.5)*resolution),'length_m':float(len(xs)*resolution)})
    return {'reachable':len(reachable),'disconnected':len(markers),'total':len(eligible),'markers':markers,'outside_observed':len(outside)}
