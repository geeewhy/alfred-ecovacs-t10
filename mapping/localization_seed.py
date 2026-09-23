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
