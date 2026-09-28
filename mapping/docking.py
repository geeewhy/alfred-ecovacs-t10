"""Measured-enclosure docking, with stopped observations and bounded motion pulses."""
import math,time
import numpy as np
from scipy.spatial import cKDTree
from scipy.optimize import least_squares


def wrap(a):return math.atan2(math.sin(a),math.cos(a))
def rotation(a):
    c,s=math.cos(a),math.sin(a)
    return np.array([[c,-s],[s,c]])
def relative(station,pose):
    delta=rotation(-pose['theta'])@np.array([station['x']-pose['x'],station['y']-pose['y']])
    return np.array([*delta,wrap(station['theta']-pose['theta'])])

def fit_enclosure(template,points,prior):
    """Align observed returns to the dock model, not hidden model points to rays.

    From outside, parts of the docked calibration are occluded. Forcing those
    hidden points onto the visible scan biases heading and rejects a real U.
    Require observed support on both sides and the rear, with bounded error
    limits, and keep the fit bounded by the map/odometry prior.
    """
    template=np.asarray(template,dtype=float);prior=np.asarray(prior,dtype=float)
    scan=np.asarray([(p['x']/1000,p['y']/1000) for p in points if p['power']>0 and .06<math.hypot(p['x'],p['y'])/1000<1.7])
    if len(scan)<40 or len(template)<30:return None
    local=(scan-prior[:2])@rotation(prior[2])
    scan=scan[np.all((local>template.min(axis=0)-.08)&(local<template.max(axis=0)+.08),axis=1)]
    if len(scan)<40:return None
    _,ix=np.unique(np.round(scan/.005),axis=0,return_index=True);scan=scan[ix]
    tree=cKDTree(template);fits=[]
    def residual(p):return tree.query((scan-p[:2])@rotation(p[2]))[0]
    for angle in np.linspace(-.3,.3,9):
        initial=prior.copy();initial[2]+=angle
        solved=least_squares(residual,initial,bounds=(prior-[.18,.18,.6],prior+[.18,.18,.6]),loss='soft_l1',f_scale=.025,max_nfev=80)
        p=solved.x;local=(scan-p[:2])@rotation(p[2]);ds=residual(p)
        # Disjoint surfaces prevent a rear corner from counting as two walls.
        sectors=[(local[:,1]>.09)&(local[:,0]>-.14),(local[:,1]<-.09)&(local[:,0]>-.14),(local[:,0]<-.10)&(np.abs(local[:,1])<.09)]
        support=[float(np.mean(ds[sector]<.04)) for sector in sectors if np.count_nonzero(sector)>=6]
        score=float(np.mean(ds<.04));rms=float(np.sqrt(np.mean(np.minimum(ds,.06)**2)))
        if len(support)==3 and min(support)>.70 and score>.82 and rms<.030:
            fits.append({'target':[float(p[0]),float(p[1]),wrap(float(p[2]))],'score':score,'rms':rms,'surfaces':support})
    if not fits:return None
    fits.sort(key=lambda f:f['rms']);best=fits[0]
    if any(np.linalg.norm(np.array(f['target'][:2])-best['target'][:2])>.08 and f['rms']<best['rms']+.003 for f in fits[1:]):return None
    return best


def coherent_near(points,forward=True,clearance=.24):
    sign=1 if forward else -1
    # Swept circular footprint, not a rectangle: parallel enclosure sides
    # beside the body are not an obstacle in the forward exit path.
    radius=.18;xs=[]
    for p in points:
        x,y=sign*p['x']/1000,p['y']/1000
        if p['power']>0 and abs(y)<radius and .06<x<math.sqrt(radius*radius-y*y)+(clearance-radius):xs.append(x)
    xs.sort()
    return any(xs[i+2]-xs[i]<.035 for i in range(len(xs)-2))

class Docking:
    def __init__(self,station,template,boot_id,now,pose):
        self.station=dict(station);self.template=template;self.boot_id=boot_id;self.started=now
        self.phase='navigate' if math.hypot(pose['x']-station['x'],pose['y']-station['y'])>1.0 else 'observe'
        self.message='Approaching station' if self.phase=='navigate' else 'Observing station enclosure'
        self.done=False;self.error=None;self.last_fit=None;self.last_sequence=None;self.wait_until=now+.4
        self.pulse=None;self.missing_since=None;self.contact_since=None;self.retries=0;self.progress=[];self.travel=0.;self.last_wheels=None
        self.correcting=False;self.reseat=False;self.commands=0;self.recovery_since=None;self.aligning=False
        self.goal_odom=None;self.odom_epoch=None;self.local_pose=None
        self.acquisition=None
    def status(self):
        return {'state':'failed' if self.error else 'docked' if self.done else self.phase,'message':self.message,'error':self.error,'fit':self.last_fit,'pose':self.local_pose,'retries':self.retries,'commands':self.commands,'travel_m':self.travel,'acquisition':self.acquisition}
    def fail(self,message):self.error=message;self.message=message;self.phase='failed';self.pulse=None;return 0.,0.
    def recover_telemetry(self,now,reason):
        # Stop the current pulse; resume only through a new observation after
        # telemetry returns. Keep the return intent, but bound the outage.
        if self.recovery_since is None:self.recovery_since=now
        self.pulse=None;self.wait_until=now+.4
        self.message='Waiting for fresh telemetry: '+reason
        if now-self.recovery_since>=5:return self.fail('Telemetry did not recover within 5 seconds: '+reason)
        return 0.,0.
    def cancel(self,message='Custom return stopped'):return self.fail(message)
    def step(self,now,frame,pose,battery,nav=(0.,0.),near_goal=False):
        if self.done or self.error:return 0.,0.
        native,scan,sensors=frame['native'],frame['lidar'],frame['bumpers'];w=native['wheels']
        if native['boot_id']!=self.boot_id:return self.fail('Robot restarted; custom return stopped')
        if battery.get('on_charger'):
            self.pulse=None;self.contact_since=self.contact_since or now;self.message='Confirming charging contact'
            if now-self.contact_since>=1:self.done=True;self.phase='docked';self.message='Docked; charging contact confirmed'
            return 0.,0.
        self.contact_since=None
        work=native.get('reports',{}).get('/task/WorkState',{}).get('bytes',[])
        if len(work)<3 or work[2]!=0:return self.fail('Firmware task took control; custom return stopped')
        if not sensors.get('fresh') or sensors.get('cliff_raw')!=0 or sensors.get('wheel_lift_raw')!=0 or sensors.get('left') or sensors.get('right'):return self.fail('Contact or unsafe safety telemetry; custom return stopped')
        if len(scan.get('points',[]))<20:return self.recover_telemetry(now,'LiDAR coverage')
        if w.get('age_ms') is None or w['age_ms']>300 or scan.get('age_ms') is None or scan['age_ms']>500:return self.fail('Fresh wheel and LiDAR readings required')
        if battery.get('percent') is None or battery['percent']<=10 or battery.get('low_voltage'):return self.fail('Battery unavailable or too low')
        if self.last_wheels:
            delta=max(abs(a-b) for a,b in zip(w['values'],self.last_wheels))
            if delta>200:return self.fail('Wheel measurement discontinuity')
            self.travel+=sum(abs(a-b) for a,b in zip(w['values'],self.last_wheels))/2000
        self.last_wheels=list(w['values'])
        odom=frame.get('odom');prior=None
        if self.goal_odom is not None and odom is not None:
            if frame.get('odom_epoch')!=self.odom_epoch:return self.fail('Dock odometry interrupted; stopped')
            prior=np.array([*(rotation(-odom[2])@(self.goal_odom[:2]-odom[:2])),wrap(self.goal_odom[2]-odom[2])])
            angle=wrap(self.station['theta']-prior[2]);xy=np.array([self.station['x'],self.station['y']])-rotation(angle)@prior[:2]
            self.local_pose={'x':float(xy[0]),'y':float(xy[1]),'theta':angle,'age_ms':0}
        if now-self.started>300 or self.travel>8:return self.fail('Custom return reached its time or travel limit')
        if self.phase=='navigate':
            if pose is None:return self.fail('Map tracking lost on station approach')
            if near_goal:self.phase='observe';self.wait_until=now+.4;return 0.,0.
            return max(-.04,min(.15,nav[0])),max(-.6,min(.6,nav[1]))
        continuing_entry=False
        if self.pulse:
            p=self.pulse;distance=sum(abs(a-b) for a,b in zip(w['values'],p['wheels']))/2000
            angle=abs(((w['values'][1]-p['wheels'][1])-(w['values'][0]-p['wheels'][0]))/243)
            if now>=p['until'] or distance>=p['max_distance'] or angle>=p['max_angle']:
                self.pulse=None
                continuing_entry=p.get('continuous_entry',False)
                if not continuing_entry:
                    self.wait_until=now+.15;self.last_sequence=scan['sequence'];return 0.,0.
            else:return p['velocity']
        if not continuing_entry and (now<self.wait_until or scan['sequence']==self.last_sequence):return 0.,0.
        self.last_sequence=scan['sequence']
        # Map tracking owns the approach. Wheel prediction bridges brief pose
        # gaps; enclosure recognition is an optional final alignment correction.
        map_valid=pose is not None and pose.get('age_ms',0)<500
        if map_valid:
            target=relative(self.station,pose)
            self.missing_since=None
        elif prior is not None:
            self.missing_since=self.missing_since or now
            if now-self.missing_since>2:return self.fail('Map tracking did not recover during return')
            target=prior.copy()
        else:
            self.missing_since=self.missing_since or now
            if now-self.missing_since>5:return self.fail('Map position did not recover during return')
            return self.recover_telemetry(now,'map position')
        self.acquisition={'source':'map' if map_valid else 'odometry','prior':target.tolist(),'accepted':True}
        estimated=-rotation(-target[2])@target[:2]
        fit=None
        if estimated[0]<.30:
            fit=fit_enclosure(self.template,scan['points'],target)
            if fit is not None:
                measured=np.asarray(fit['target'])
                # A detailed shape match can refine a known destination, never
                # move it to another object or veto the map-guided approach.
                if np.linalg.norm(measured[:2]-target[:2])<.06 and abs(wrap(measured[2]-target[2]))<.15:
                    target[:2]+=.25*(measured[:2]-target[:2])
                    target[2]=wrap(target[2]+.25*wrap(measured[2]-target[2]))
                    self.acquisition['source']='map+enclosure'
        self.last_fit=fit
        robot=-rotation(-target[2])@target[:2];out,lateral=robot;heading=wrap(target[2])
        if odom is not None:
            self.goal_odom=np.array([*(rotation(odom[2])@target[:2]+odom[:2]),wrap(odom[2]+target[2])]);self.odom_epoch=frame.get('odom_epoch')
        self.acquisition.update(outward_m=float(out),lateral_m=float(lateral),heading_error=float(heading))
        if fit is not None:fit.update(outward_m=float(out),lateral_m=float(lateral),heading_error=float(heading))
        # Match evidence, not spinning encoders, must show movement.
        self.progress.append((now,float(out),float(lateral),float(heading)));self.progress=[p for p in self.progress if now-p[0]<12]
        if len(self.progress)>12 and now-self.progress[0][0]>10:
            a=self.progress[0]
            if math.hypot(out-a[1],lateral-a[2])<.008 and abs(wrap(heading-a[3]))<.025:return self.fail('No measured docking progress; stopped')
        inside=out<.30
        if inside and (abs(lateral)>.05 or abs(heading)>.30):self.correcting=True
        if self.correcting:
            if out>=.42:self.correcting=False
            else:
                if abs(heading)>.6:return self.fail('Too crooked to clear the enclosure without rotating; stopped')
                self.message='Creeping forward for alignment clearance'
                return self.move(now,w,scan,.025,0.)
        aligned=abs(lateral)<.04 and abs(heading)<.20
        if aligned:
            if out<-.012 and not self.reseat:
                if self.retries>=2:return self.fail('Charging contact not found within measured dock position')
                self.retries+=1;self.reseat=True
            if self.reseat:
                if out<.04:
                    self.message='Releasing contacts for a slow retry';return self.move(now,w,scan,.020,0.)
                self.reseat=False
            self.message='Backing into station and correcting alignment'
            yaw=max(-.12,min(.12,1.2*(heading+max(-.15,min(.15,lateral*4)))))
            return self.move(now,w,scan,-.150 if out>.60 else -.100,yaw,fast_distance=max(0.,out-.55) if out>.60 else 0.,continuous_entry=out<=.60)
        # No large turns in the enclosure. Go to a clear staging point first.
        if inside:return self.fail('Dock alignment outside the safe correction range')
        staging=target[:2]+rotation(heading)@np.array([.45,0.])
        distance=float(np.linalg.norm(staging))
        if distance<.06 and abs(lateral)<.04:self.aligning=True
        if self.aligning and (distance>.12 or abs(lateral)>.06):self.aligning=False
        if not self.aligning:
            angle=math.atan2(staging[1],staging[0]);self.message='Aligning outside the enclosure'
            if abs(angle)>.10:return self.move(now,w,scan,0.,math.copysign(max(.16,min(.60,abs(angle)*1.2)),angle))
            return self.move(now,w,scan,.150 if out>.60 else .050,max(-.10,min(.10,angle*.5)),fast_distance=max(0.,out-.55) if out>.60 else 0.)
        self.message='Aligning rear with station wall'
        return self.move(now,w,scan,0.,math.copysign(max(.16,min(.60,abs(heading)*1.2)),heading))
    def move(self,now,w,scan,linear,angular,fast_distance=0.,continuous_entry=False):
        if linear<0 and self.acquisition:
            obstacles=scan['points']
            if self.acquisition.get('outward_m',1)<=.30 and len(self.template)>=30:
                # Expected enclosure surfaces are the destination. Other returns
                # in the swept rear footprint remain obstacles during entry.
                target=np.asarray(self.acquisition['prior'])
                tree=cKDTree(np.asarray(self.template)@rotation(target[2]).T+target[:2])
                obstacles=[p for p in obstacles if tree.query([p['x']/1000,p['y']/1000])[0]>.05]
            if coherent_near(obstacles,False,.22):return self.fail('Reverse approach obstructed; stopped')
        if linear>0 and coherent_near(scan['points']):return self.fail('Forward exit obstructed; stopped')
        if linear==0 and abs(angular)>.05:
            # Major rotation is only allowed outside and with body clearance.
            close=sum(p['power']>0 and .06<math.hypot(p['x'],p['y'])/1000<.225 for p in scan['points'])
            if close>=3:return self.fail('Insufficient body clearance to rotate')
        rotating=linear==0 and abs(angular)>.05
        self.commands+=1;self.pulse={'until':now+.7,'wheels':list(w['values']),'continuous_entry':continuous_entry,'max_distance':.06 if continuous_entry else min(.05,fast_distance) if fast_distance else .05 if rotating else .025 if abs(linear)>.025 else .006,'max_angle':.30 if rotating else .08,'velocity':(linear,angular)}
        return linear,angular
