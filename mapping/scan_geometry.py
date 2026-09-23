"""Deskew ordered full LiDAR sweeps into their end-of-sweep odometry frame."""
import bisect,math
from collections import deque

def wrap(a):return math.atan2(math.sin(a),math.cos(a))
class ScanGeometry:
    def __init__(self):self.history=deque(maxlen=150);self.last_stamp=None;self.period=.2
    def odometry(self,stamp,pose):
        if self.history and stamp<=self.history[-1][0]:return
        self.history.append((stamp,tuple(pose)))
    def at(self,stamp):
        values=list(self.history)
        if not values or stamp<values[0][0] or stamp>values[-1][0]+.03:return None
        index=bisect.bisect_left([v[0] for v in values],stamp)
        if index==0:return values[0][1]
        if index==len(values):return values[-1][1]
        t0,a=values[index-1];t1,b=values[index];f=(stamp-t0)/(t1-t0)
        return (a[0]+f*(b[0]-a[0]),a[1]+f*(b[1]-a[1]),wrap(a[2]+f*wrap(b[2]-a[2])))
    def points(self,scan):
        stamp=scan.get('source_stamp')
        if stamp is None:return None
        if stamp!=self.last_stamp:
            self.period=max(.1,min(.3,stamp-self.last_stamp)) if self.last_stamp is not None else .2
            self.last_stamp=stamp
        period=self.period
        end=self.at(stamp)
        if end is None or self.at(stamp-period) is None:return None
        c=math.cos(end[2]);s=math.sin(end[2]);out=[];count=len(scan['points'])
        for i,p in enumerate(scan['points']):
            if p['power']<=0:continue
            pose=self.at(stamp-period+(i+1)/count*period)
            if pose is None:return None
            angle=wrap(pose[2]-end[2]);dx=pose[0]-end[0];dy=pose[1]-end[1]
            out.append((math.cos(angle)*p['x']/1000-math.sin(angle)*p['y']/1000+c*dx+s*dy,math.sin(angle)*p['x']/1000+math.cos(angle)*p['y']/1000-s*dx+c*dy))
        return out
