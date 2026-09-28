"""Bounded global scan proposal; AMCL and saved-graph checks remain authoritative."""
import math,time
import numpy as np
from scipy.spatial import cKDTree
from scipy.optimize import minimize

def independent_obstructions(hits, valid, fractions, lengths, resolution):
    """Count an intervening surface only before a clear gap to the return.

    A scan can hit the far side of a thick/noisy mapped surface. The terminal
    occupied band is endpoint support, not a second wall blocking the beam.
    """
    clear=(~hits)&valid
    run=max(3,int(math.ceil(.15/resolution)))
    if hits.shape[1]<run:return 0.
    windows=np.lib.stride_tricks.sliding_window_view(clear,run,axis=1).all(axis=2)
    # A clear run must finish before the endpoint tolerance region.
    ends=fractions[run-1:][None,:]
    windows &= ends < lengths[:,None]-.10
    last_clear=np.max(np.where(windows,ends,-1.),axis=1)
    pairs=hits[:,:-1]&hits[:,1:]
    return float(np.mean(np.any(pairs & (fractions[None,1:] < last_clear[:,None]-.10),axis=1)))

def same_basin(a,b):
    return math.dist(a[:2],b[:2])<.5 and abs(math.atan2(math.sin(a[2]-b[2]),math.cos(a[2]-b[2])))<.4

def global_seed(grid,points,budget=8.):
    if len(points)<100:return None
    started=time.monotonic();resolution=grid['resolution'];origin=np.asarray(grid['origin'])
    cells=np.asarray(grid['cells']);occupied=cells[cells[:,2]>127,:2].astype(int);free=cells[cells[:,2]<=127,:2]
    if len(occupied)<20 or not len(free):return None
    tree=cKDTree((occupied+.5)*resolution+origin)
    xy=np.asarray(points)[np.linspace(0,len(points)-1,min(120,len(points)),dtype=int)]
    free=(free+.5)*resolution+origin
    _,indices=np.unique(np.floor(free/.3).astype(int),axis=0,return_index=True);free=free[indices]
    if len(free)>15000:return None
    width,height=grid['width'],grid['height'];mask=np.zeros((height,width),dtype=bool);mask[occupied[:,1],occupied[:,0]]=True
    def rotation(theta):
        c,s=math.cos(theta),math.sin(theta);return np.array([[c,s],[-s,c]])
    lengths=np.linalg.norm(xy,axis=1)
    # Ignore the robot footprint and the final 15 cm around each observed surface.
    fractions=np.arange(.2,min(12.,max(lengths)),resolution)
    valid=(fractions[None,:]<lengths[:,None])
    rays=xy[:,None,:]*fractions[None,:,None]/lengths[:,None,None]
    def conflicts(p):
        samples=(rays@rotation(p[2]))+np.asarray(p[:2]);ij=np.floor((samples-origin)/resolution).astype(int)
        inside=valid&(ij[:,:,0]>=0)&(ij[:,:,0]<width)&(ij[:,:,1]>=0)&(ij[:,:,1]<height)
        hits=np.zeros(inside.shape,dtype=bool);hits[inside]=mask[ij[:,:,1][inside],ij[:,:,0][inside]]
        return independent_obstructions(hits,inside,fractions,lengths,resolution)
    def distances(p):return tree.query(xy@rotation(p[2])+p[:2])[0]
    candidates=[]
    for theta in np.arange(-math.pi,math.pi,math.pi/18):
        if time.monotonic()-started>budget:return None
        ds=tree.query((free[:,None,:]+(xy@rotation(theta))[None,:,:]).reshape(-1,2))[0].reshape(len(free),len(xy))
        costs=np.minimum(ds,.3).mean(axis=1)
        candidates.extend((float(costs[i]),[free[i,0],free[i,1],theta]) for i in np.argsort(costs)[:4])
    ranked=[]
    for cost,p in candidates:
        if time.monotonic()-started>budget:return None
        ranked.append((cost+.2*conflicts(p),p))
    ranked.sort(key=lambda q:q[0]);fits=[]
    for _,p in ranked:
        if any(same_basin(p,q['pose']) for q in fits):continue
        def cost(v):
            if time.monotonic()-started>budget:raise TimeoutError()
            return float(np.minimum(distances(v),.3).mean())+.2*conflicts(v)
        try:fit=minimize(cost,p,method='Powell',bounds=[(p[0]-.35,p[0]+.35),(p[1]-.35,p[1]+.35),(p[2]-.2,p[2]+.2)],options={'maxiter':12})
        except TimeoutError:return None
        candidate={'pose':fit.x,'cost':float(fit.fun),'agreement':float(np.mean(distances(fit.x)<.1)),'conflicts':conflicts(fit.x)}
        # Different coarse seeds can converge to the same physical hypothesis.
        # They are not competing rooms and must not consume the ambiguity margin.
        same=[q for q in fits if same_basin(candidate['pose'],q['pose'])]
        if same:
            candidate=min([candidate]+same,key=lambda q:q['cost'])
            fits=[q for q in fits if not any(q is old for old in same)]
        fits.append(candidate)
        if len(fits)==4:break
    if len(fits)<2:return None
    fits.sort(key=lambda q:q['cost']);best=fits[0]
    if best['agreement']<.85 or best['conflicts']>.12 or fits[1]['cost']-best['cost']<.025:return None
    return dict(zip(('x','y','theta'),map(float,best['pose'])),seed_score=best['agreement'],seed_source='global-visibility',seed_margin=fits[1]['cost']-best['cost'])
