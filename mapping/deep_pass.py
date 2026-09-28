"""Persistent spatial coverage checklist for a deliberate whole-map inspection."""
import math
from wall_verification import wall_goal

class DeepPass:
    def __init__(self, saved=None):
        self.targets=(saved or {}).get('targets',[])
        # Rebuild old dense pending lists; preserve actual completed checks.
        if (saved or {}).get('version')!=2:
            self.targets=[t for t in self.targets if t['state']=='verified']
        self.next_id=max([int(t['id'].split('-')[-1]) for t in self.targets]+[0])+1
        for t in self.targets:
            if t['state']!='verified':t['state']='pending';t['attempts']=[]
    def refresh(self,walls):
        if not walls:return
        def project(p,points):
            a,b=points;dx,dy=b[0]-a[0],b[1]-a[1]
            t=max(0.,min(1.,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy or 1.)))
            return [a[0]+t*dx,a[1]+t*dy]
        def same_surface(a,b):
            u=[a[1][i]-a[0][i] for i in range(2)]
            v=[b[1][i]-b[0][i] for i in range(2)]
            return abs(u[0]*v[0]+u[1]*v[1])>=math.cos(math.radians(20))*math.hypot(*u)*math.hypot(*v)
        retained=[]
        for target in self.targets:
            if target['state']=='checking':retained.append(target);continue
            matches=[w for w in walls if same_surface(target['points'],w['points']) and math.dist(target['point'],project(target['point'],w['points']))<.35]
            if not matches:continue
            wall=min(matches,key=lambda w:math.dist(target['point'],project(target['point'],w['points'])))
            # Pending checks follow corrected geometry rather than steering at
            # an old contour. Completed observations retain their real location.
            if target['state']!='verified':
                target['point']=project(target['point'],wall['points'])
                target['points']=wall['points']
                target['unknown']=bool(wall.get('unknown'))
            retained.append(target)
        self.targets=retained
        for wall in walls:
            a,b=wall['points'];length=math.dist(a,b)
            if length<.3:continue
            n=max(1,math.ceil(length/1.5))
            for i in range(n):
                t=(i+.5)/n;p=[a[j]+t*(b[j]-a[j]) for j in range(2)]
                if any(math.dist(p,q['point'])<1.0 for q in self.targets):continue
                self.targets.append({'id':f'section-{self.next_id}','point':p,'points':[a,b],'unknown':bool(wall.get('unknown')),'state':'pending','attempts':[]})
                self.next_id+=1
    def goal(self,grid,resolution,origin,pose):
        best=None
        for target in self.targets:
            if target['state']=='verified' or len(target['attempts'])>=3:continue
            goal=wall_goal(grid,resolution,origin,pose,[{'id':target['id'],'points':target['points'],'unknown':target['unknown'],'sample':target['point']}],target['attempts'],deep=True)
            if goal:
                distance=math.hypot(goal['x']-pose['x'],goal['y']-pose['y'])
                score=distance+len(target['attempts'])*2
                if best is None or score<best[0]:best=(score,goal)
        return best[1] if best else None
    def started(self,goal):
        for target in self.targets:
            if target['id']==goal['wall_id']:
                target['attempts'].append(dict(goal));target['state']='checking';break
    def record(self,goal,result):
        for target in self.targets:
            if target['id']==goal['wall_id']:
                target['state']='verified' if result in ('close_scan','contact','observed') else 'pending'
                target['result']=result
                if target['attempts']:target['attempts'][-1]['result']=result
                break
    def status(self):
        verified=sum(t['state']=='verified' for t in self.targets)
        return {'version':2,'spacing_m':1.5,'targets':self.targets,'total':len(self.targets),'verified':verified,'remaining':len(self.targets)-verified}
