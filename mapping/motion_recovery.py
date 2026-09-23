"""Bounded stall recovery from scan-matched motion, independent of wheel spin."""
import math

def distance(a,b):return math.hypot(a['x']-b['x'],a['y']-b['y'])
def wrap(a):return math.atan2(math.sin(a),math.cos(a))
def blocked(points,forward,clearance):
    # Require a coherent surface, not an isolated LiDAR return. Coordinates mm.
    side=1 if forward else -1
    near=sorted(side*p['x']/1000 for p in points if p['power']>0 and 195<side*p['x']<clearance*1000 and abs(p['y'])<195)
    return any(near[i+2]-near[i]<.06 for i in range(len(near)-2))

class RecoveryBlocked(RuntimeError):pass

class MotionRecovery:
    def __init__(self):self.reset();self.attempts=[]
    def reset(self):self.anchor=None;self.phase=None;self.message=None;self.event=None
    def begin(self,phase,pose,now):self.phase=phase;self.origin=dict(pose);self.started=now
    def step(self,now,pose,linear,angular,points,cruise):
        self.event=None
        if self.phase is None:
            if abs(angular)>.3:self.anchor=None;return None
            if self.anchor is None:
                if linear>.005:self.anchor={'since':now,'pose':dict(pose),'effort':0.,'last':now,'forward':now,'speed':linear}
                return None
            a=self.anchor
            a['effort']+=max(0.,a['speed'])*max(0.,min(.25,now-a['last']))
            a['last']=now;a['speed']=linear
            if linear>.005:a['forward']=now
            if now-a['forward']>.6 or distance(a['pose'],pose)>.04:self.anchor=None;return None
            if now-a['since']<2. or a['effort']<.05 or distance(a['pose'],pose)>max(.012,a['effort']*.3):return None
            self.attempts=[(t,p) for t,p in self.attempts if now-t<60 and distance(p,pose)<.5]
            if len(self.attempts)>=3:raise RecoveryBlocked('Repeated stall at this obstacle; exploration paused')
            self.retry=not self.attempts and not blocked(points,True,.55)
            self.attempts.append((now,dict(pose)));self.event='pause'
            self.begin('back',pose,now)
        elapsed=now-self.started;moved=distance(self.origin,pose)
        if self.phase=='back':
            self.message='No forward progress; backing up for another approach'
            if blocked(points,False,.32):raise RecoveryBlocked('Recovery blocked behind Alfred; stopped')
            if moved>=.10:
                if self.retry:self.begin('cross',pose,now)
                else:
                    self.begin('turn',pose,now);self.target=wrap(pose['theta']+math.pi/2);self.event='blocked'
                return 0.,0.
            if elapsed>=2.5:raise RecoveryBlocked('Could not back away from obstacle; stopped')
            return -.06,0.
        if self.phase=='cross':
            self.message='Retrying the small threshold with more momentum'
            if blocked(points,True,.45):
                self.retry=False;self.begin('back',pose,now);return 0.,0.
            if moved>=.32 or elapsed>=2.:
                if moved<.12:
                    self.retry=False;self.begin('back',pose,now);return 0.,0.
                self.reset();self.event='resume';return 0.,0.
            # Ramp up, never use cockpit's much higher maximum for a recovery.
            return min(.20,max(.16,cruise*1.5),.06+elapsed*.20),0.
        self.message='Obstacle remains; turning to explore another direction'
        error=wrap(self.target-pose['theta'])
        if abs(error)<.12:self.reset();self.event='resume';return 0.,0.
        if elapsed>=7.:raise RecoveryBlocked('Recovery turn made insufficient progress; stopped')
        return 0.,max(-.35,min(.35,error))
