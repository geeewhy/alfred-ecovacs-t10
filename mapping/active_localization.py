"""A short observation move before retrying saved-map localization."""
import math,time
from localization_seed import advance_pose
from motion_recovery import blocked


def station_from_departure(pose,pose_odom,dock_odom):
    return {k:v for k,v in advance_pose(pose,pose_odom,dock_odom).items() if k in ('x','y','theta')}



def combined_views(history,current_odom):
    """Express prior stationary scans in the current robot frame using odometry."""
    points=[]
    for scan,odom in history:
        relative=advance_pose({'x':0.,'y':0.,'theta':0.},current_odom,odom)
        c,s=math.cos(relative['theta']),math.sin(relative['theta'])
        points.extend((relative['x']+c*x-s*y,relative['y']+s*x+c*y) for x,y in scan)
    return points


def observation_step(request,valid,boot_id,clock=time.monotonic,sleep=time.sleep,wheel_separation_mm=243):
    """Move at most 18 cm, with an independent time limit and engine deadman."""
    battery=request('/v1/telemetry/battery')
    if battery.get('percent') is None or battery['percent']<=10 or battery.get('low_voltage'):raise RuntimeError('Battery too low for observation move')
    start=None;started=clock();last=None;stationary=0
    try:
        while clock()-started<2.5:
            if not valid():raise RuntimeError('Position search cancelled')
            frame=request('/v1/mapping/native/frame');native=frame['native'];scan=frame['lidar'];wheels=native['wheels']
            if native['boot_id']!=boot_id:raise RuntimeError('Robot restarted during position search')
            work=native.get('reports',{}).get('/task/WorkState',{}).get('bytes',[])
            if len(work)<3 or work[2]!=0:raise RuntimeError('Another firmware task took control; observation move stopped')
            if wheels.get('age_ms') is None or wheels['age_ms']>300 or scan.get('age_ms') is None or scan['age_ms']>500:
                raise RuntimeError('Fresh wheel and LiDAR telemetry required for observation move')
            if start is None:start=list(wheels['values'])
            moved=sum(v-a for v,a in zip(wheels['values'],start))/2000
            if moved>=.18:break
            if blocked(scan['points'],True,.38):raise RuntimeError('Observation move blocked ahead')
            if not valid():raise RuntimeError('Position search cancelled')
            request('/v1/mapping/twist',{'linear_mm_s':100,'angular_rad_s':0,'wheel_separation_mm':wheel_separation_mm},'PUT')
            sleep(.08)
        if start is None:raise RuntimeError('No observation motion recorded')
    finally:
        request('/v1/drive/stop',{},'POST')
    for _ in range(5):
        if not valid():raise RuntimeError('Position search cancelled')
        sleep(.2);frame=request('/v1/mapping/native/frame');native=frame['native'];w=native['wheels']
        if native['boot_id']!=boot_id or w.get('age_ms') is None or w['age_ms']>300:raise RuntimeError('Observation stop telemetry unavailable')
        if last and w['stamp']>last['stamp'] and max(abs(v-a) for v,a in zip(w['values'],last['values']))<2:stationary+=1
        else:stationary=0
        last=w
        if stationary>=2:break
    if stationary<2:raise RuntimeError('Observation move did not settle')
    distance=sum(v-a for v,a in zip(last['values'],start))/2000
    if not .05<=distance<=.3:raise RuntimeError('Observation move made insufficient or excessive progress')
    return distance
