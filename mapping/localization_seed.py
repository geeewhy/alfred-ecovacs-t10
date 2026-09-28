"""Find a better AMCL seed near a saved pose; never authorizes movement."""
import math,time
import numpy as np
from scipy.optimize import differential_evolution

def refine_seed(reference,points,prior):
    if len(points)<100:return prior
    xy=np.asarray(points)[::2];center=np.array([prior['x'],prior['y'],prior['theta']]);started=time.monotonic()
    def distances(p):
        c,s=math.cos(p[2]),math.sin(p[2])
        return reference.query(xy@np.array([[c,s],[-s,c]])+p[:2])[0]
    def cost(p):return float(np.minimum(distances(p),.3).mean())
    initial=distances(center)
    if np.mean(initial<.1)>=.85:return prior
    fit=differential_evolution(cost,[(center[0]-2,center[0]+2),(center[1]-2,center[1]+2),(center[2]-1,center[2]+1)],seed=4,maxiter=70,popsize=10,polish=False,callback=lambda *_,**__:time.monotonic()-started>.8)
    score=float(np.mean(distances(fit.x)<.1))
    if score<.8 or fit.fun>=cost(center)*.8:return prior
    return {'x':float(fit.x[0]),'y':float(fit.x[1]),'theta':float(fit.x[2]),'seed_score':score}


def advance_pose(pose, previous_odom, current_odom):
    """Carry a map pose forward by relative wheel motion, preserving its metadata."""
    rotation=pose['theta']-previous_odom[2]
    c,s=math.cos(rotation),math.sin(rotation)
    dx,dy=current_odom[0]-previous_odom[0],current_odom[1]-previous_odom[1]
    theta=pose['theta']+current_odom[2]-previous_odom[2]
    return dict(pose,x=pose['x']+c*dx-s*dy,y=pose['y']+s*dx+c*dy,
                theta=math.atan2(math.sin(theta),math.cos(theta)))
