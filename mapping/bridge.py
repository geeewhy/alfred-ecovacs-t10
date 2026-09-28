#!/usr/bin/env python3
"""ROS 2 adapter for Alfred's native SLAM and bounded Nav2 command lease."""
import http.client, json, math, os, socket, struct, subprocess, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import rclpy
import numpy as np
from scipy.ndimage import label, binary_dilation
from rclpy.node import Node
from rclpy.action import ActionClient
from nav2_msgs.action import NavigateToPose
from rclpy.parameter import Parameter
from rclpy.parameter_client import AsyncParameterClient
from rclpy.qos import QoSProfile, DurabilityPolicy, ReliabilityPolicy
from geometry_msgs.msg import TransformStamped, Twist
from nav_msgs.msg import OccupancyGrid, Odometry, Path
from sensor_msgs.msg import LaserScan, PointCloud2, PointField
from std_msgs.msg import Bool
from rcl_interfaces.msg import Log
from action_msgs.msg import GoalStatusArray
from tf2_ros import TransformBroadcaster, StaticTransformBroadcaster
from explore_lite_msgs.msg import ExploreStatus
from slam_session import SlamSession
from scan_geometry import ScanGeometry
from localization_seed import advance_pose
import copy
from refinement import observation_goal, frontier_regions
from wall_verification import wall_goal
from deep_pass import DeepPass
from motion_recovery import MotionRecovery, RecoveryBlocked, blocked
from rclpy.duration import Duration
from docking import Docking

ENGINE=os.environ.get('ALFRED_ENGINE','http://192.168.1.89:8765')
TOKEN=open(os.environ.get('ALFRED_ENGINE_TOKEN_FILE','/alfred/engine-token')).read().strip()
ADDRESS=urllib.parse.urlparse(ENGINE)
LOCAL=threading.local()
def request(path,body=None,method=None):
    verb=method or ('POST' if body is not None else 'GET')
    # A closed keepalive socket must not abort an otherwise healthy observation.
    # Retry reads once on a new socket; never replay a motion command.
    for attempt in range(2 if verb=='GET' else 1):
        if not getattr(LOCAL,'connection',None):
            LOCAL.connection=http.client.HTTPConnection(socket.gethostbyname(ADDRESS.hostname),ADDRESS.port,timeout=.8)
        try:
            LOCAL.connection.request(verb,path,body=json.dumps(body) if body is not None else None,headers={'Content-Type':'application/json','Authorization':'Bearer '+TOKEN})
            response=LOCAL.connection.getresponse();value=json.loads(response.read())
            if not value['ok']:raise RuntimeError(value['result'])
            return value['result']
        except Exception as error:
            LOCAL.connection.close();LOCAL.connection=None
            if verb!='GET' or attempt or not isinstance(error,(OSError,http.client.HTTPException)):raise
def wrap(value):return math.atan2(math.sin(value),math.cos(value))
def quaternion(rotation,theta):rotation.z=math.sin(theta/2);rotation.w=math.cos(theta/2)

class Bridge(Node):
    def __init__(self):
        super().__init__('alfred_adapter')
        qos=QoSProfile(depth=1,durability=DurabilityPolicy.TRANSIENT_LOCAL,reliability=ReliabilityPolicy.RELIABLE)
        self.frontier_pub=self.create_publisher(OccupancyGrid,'frontier_map',qos)
        self.create_subscription(OccupancyGrid,'global_costmap/costmap',self.frontier_map,qos)
        self.scan_pub=self.create_publisher(LaserScan,'scan',10)
        self.obstacle_scan_pub=self.create_publisher(LaserScan,'obstacle_scan',10)
        self.contact_pub=self.create_publisher(PointCloud2,'bumper_contacts',10)
        self.odom_pub=self.create_publisher(Odometry,'odom',10)
        self.resume_pub=self.create_publisher(Bool,'explore/resume',10)
        self.tf=TransformBroadcaster(self);self.static=StaticTransformBroadcaster(self)
        t=TransformStamped();t.header.frame_id='base_link';t.child_frame_id='laser';t.transform.rotation.w=1.
        self.static.sendTransform(t)
        self.create_subscription(Twist,'cmd_vel',self.velocity,10)
        self.failed_goals=set()
        self.create_subscription(GoalStatusArray,'navigate_to_pose/_action/status',self.goal_status,qos)
        self.create_subscription(Path,'plan',lambda m:self.update(path=[[p.pose.position.x,p.pose.position.y] for p in m.poses]),10)
        self.create_subscription(ExploreStatus,'explore/status',self.explore_status,qos)
        self.lock=threading.RLock();self.active=False;self.lease=0.;self.command=(0.,0.,0.);self.generation=0
        self.state={'ready':False,'message':'Waiting for robot telemetry','path':[],'navigation_errors':[]}
        self.create_subscription(Log,'rosout',self.navigation_error,10)
        self.recovery=None;self.motion_recovery=MotionRecovery();self.contacts=[];self.battery={};self.battery_at=0.
        self.explorer=None;self.last_map=None;self.last_scan=None;self.previous=None;self.odom=[0.,0.,0.];self.odom_epoch=0;self.engine_request=request
        self.settings={'cruise_mm_s':120.,'approach_mm_s':60.,'wheel_separation_m':.243,'robot_radius_m':.18}
        if os.path.exists('/alfred/state/settings.json'):
            self.settings.update(json.load(open('/alfred/state/settings.json')))
        self.parameters=AsyncParameterClient(self,'controller_server')
        self.navigator=ActionClient(self,NavigateToPose,'navigate_to_pose')
        self.slam=SlamSession(self,qos)
        self.scan_geometry=ScanGeometry();self.robot_boot=None
        self.deep=None;self.wall_candidates=[];self.wall_attempted=[];self.wall_verifications=[]
        self.docking=None;self.dock_handle=None;self.dock_battery_at=0.;self.dock_battery={};self.dock_contact=None;self.dock_waking_since=None
        self.refinement=None;self.inspected=[];self.inspection_stalls=0;self.inspection_area=0.;self.frontier_grid=None;self.refinement_handle=None
        threading.Thread(target=self.poll_dock_contact,daemon=True).start()
        threading.Thread(target=self.run_poll,daemon=True).start()
    def navigation_error(self,msg):
        if msg.level<30 or msg.name not in ('controller_server','planner_server','bt_navigator','explore_node'):return
        record={'at':time.time(),'node':msg.name,'message':msg.msg[:400]}
        with self.lock:
            errors=self.state['navigation_errors']
            if errors and errors[-1]['message']==record['message'] and record['at']-errors[-1]['at']<2:return
            self.state['navigation_errors']=(errors+[record])[-10:]
        # Keep actionable navigation failures after verbose ROS checkpoint logs roll.
        try:
            os.makedirs('/alfred/state',exist_ok=True);filename='/alfred/state/navigation.log'
            previous=open(filename,'rb').read()[-9500:] if os.path.exists(filename) else b''
            data=(previous+json.dumps(record).encode()+b'\n')[-10000:]
            with open(filename,'wb') as output:output.write(data)
        except OSError:pass
    def frontier_map(self, msg):
        # Explorer needs binary traversability: inflated-but-traversable costs
        # are free, while inscribed obstacles and unknown cells stay blocked.
        msg.data=[-1 if v<0 else 100 if v>=99 else 0 for v in msg.data]
        self.frontier_pub.publish(msg)
        self.frontier_grid=(np.asarray(msg.data).reshape(msg.info.height,msg.info.width),msg.info.resolution,(msg.info.origin.position.x,msg.info.origin.position.y))
        self.update(frontiers=frontier_regions(*self.frontier_grid,self.state.get('pose'),self.slam.graph_nodes))
    def explore_status(self,msg):
        with self.lock:
            if self.refinement is not None:return
            if self.frontier_grid:
                grid,resolution,_=self.frontier_grid;area=float(np.count_nonzero(grid==0))*resolution**2
                if area>self.inspection_area+.15:self.inspection_stalls=0
                self.inspection_area=max(self.inspection_area,area)
            verification=self.inspection_goal(self.state['pose']) if self.frontier_grid and self.state.get('pose') else None
            if self.active and msg.status=='exploration_complete' and (verification or self.inspection_stalls<3 and len(self.inspected)<20):
                self.refinement={'phase':'select','started':time.monotonic()}
                self.update(exploration='refining',message='Checking corners and hidden boundaries')
            else:self.update(exploration=msg.status)
    def inspection_goal(self,pose):
        return self.deep.goal(*self.frontier_grid,pose) if self.deep else wall_goal(*self.frontier_grid,pose,self.wall_candidates,self.wall_attempted)
    def cancel_refinement(self):
        self.refinement=None
        if self.refinement_handle:
            self.refinement_handle.cancel_goal_async();self.refinement_handle=None
    def refinement_velocity(self,pose,now):
        r=self.refinement
        if r is None:return None
        self.update(exploration='refining')
        if r['phase']=='select':
            self.resume_pub.publish(Bool(data=False));self.command=(0.,0.,0.)
            goal=self.inspection_goal(pose) if self.frontier_grid else None
            if goal:
                self.wall_attempted.append(goal)
                if self.deep:self.deep.started(goal);self.update(deep_pass=self.deep.status())
            else:
                self.inspection_stalls+=1
                goal=observation_goal(*self.frontier_grid,pose,self.inspected) if self.frontier_grid else None
            if goal:
                if goal.get('kind')!='wall':self.inspected.append((goal['x'],goal['y']))
                r.update(phase='send',goal=goal,started=now,travel_budget=max(25,math.hypot(goal['x']-pose['x'],goal['y']-pose['y'])/.12+15) if self.deep else 25)
            elif not self.inspected:
                self.inspected.append((pose['x'],pose['y']))
                r.update(phase='sweep',last=pose['theta'],rotation=0.,started=now)
            else:self.finish_refinement()
            return 0.,0.
        if r['phase']=='send':
            self.update(message='Approaching a surface for verification' if r['goal'].get('kind')=='wall' else 'Moving to inspect a corner')
            if now-r['started']<.3:return 0.,0.
            goal=NavigateToPose.Goal();goal.pose.header.frame_id='map';goal.pose.header.stamp=self.get_clock().now().to_msg()
            goal.pose.pose.position.x=r['goal']['x'];goal.pose.pose.position.y=r['goal']['y'];quaternion(goal.pose.pose.orientation,r['goal']['theta'])
            r.update(phase='navigate',started=now)
            future=self.navigator.send_goal_async(goal)
            def accepted(future):
                with self.lock:
                    handle=future.result()
                    if self.refinement is not r:
                        if handle.accepted:handle.cancel_goal_async()
                        return
                    if not handle.accepted:r['phase']='done';return
                    self.refinement_handle=handle
                    def arrived(future):
                        with self.lock:
                            if self.refinement is not r:return
                            self.refinement_handle=None
                            if future.result().status==4:r.update(phase='align' if r['goal'].get('kind')=='wall' else 'sweep',last=None,rotation=0.,started=time.monotonic())
                            else:r['phase']='done'
                    handle.get_result_async().add_done_callback(arrived)
            future.add_done_callback(accepted)
            return 0.,0.
        if r['phase']=='navigate':
            self.update(message='Approaching a surface for verification' if r['goal'].get('kind')=='wall' else 'Moving to inspect a corner')
            if now-r['started']>r.get('travel_budget',25):self.record_verification(pose,'not_reached');self.finish_refinement();return 0.,0.
            return None  # Nav2 owns the approach and obstacle avoidance.
        if r['phase']=='align':
            target=r['goal']['surface'];heading=math.atan2(target[1]-pose['y'],target[0]-pose['x'])
            error=wrap(heading-pose['theta']);self.update(message='Facing the surface for a close check')
            if abs(error)<.08:r.update(phase='probe',started=now,origin=dict(pose));return 0.,0.
            if now-r['started']>15:self.record_verification(pose,'not_reached');self.finish_refinement();return 0.,0.
            return 0.,max(-.6,min(.6,error))
        if r['phase']=='probe':
            self.update(message='Checking the surface up close')
            moved=math.hypot(pose['x']-r['origin']['x'],pose['y']-r['origin']['y'])
            # Unknown edges get a complete view from known free space.
            if r['goal'].get('unknown'):
                r.update(phase='sweep',last=pose['theta'],rotation=0.,started=now);return 0.,0.
            target=r['goal']['surface'];distance=math.hypot(target[0]-pose['x'],target[1]-pose['y'])
            points=getattr(self,'current_points',[])
            close=sum(p['power']>0 and 160<p['x']<250 and abs(p['y'])<120 for p in points)>=3
            if close or distance<=.23 or now-r['started']>=8 or moved>=.25:
                self.record_verification(pose,'close_scan' if close and distance<=.4 else 'not_reached')
                self.finish_refinement();return 0.,0.
            error=wrap(math.atan2(target[1]-pose['y'],target[0]-pose['x'])-pose['theta'])
            speed=min(self.settings['approach_mm_s']/1000, .10 if distance>.32 else .055)
            return (speed if abs(error)<.2 else 0.),max(-.35,min(.35,error))
        if r['phase']=='sweep':
            self.update(message='Scanning around the corner')
            if r['last'] is not None:r['rotation']+=wrap(pose['theta']-r['last'])
            r['last']=pose['theta']
            if r['rotation']>=2*math.pi-.15 or now-r['started']>15:
                if r.get('goal',{}).get('unknown'):self.record_verification(pose,'observed' if r['rotation']>=2*math.pi-.15 else 'not_reached')
                self.finish_refinement();return 0.,0.
            return 0.,.8
        self.record_verification(pose,'not_reached');self.finish_refinement();return 0.,0.
    def record_verification(self,pose,result):
        r=self.refinement
        if not r or r.get('goal',{}).get('kind')!='wall':return
        if result=='contact' and (r['phase']!='probe' or math.hypot(pose['x']-r['goal']['surface'][0],pose['y']-r['goal']['surface'][1])>.4):result='approach_blocked'
        if self.deep:self.deep.record(r['goal'],result);self.update(deep_pass=self.deep.status())
        r['goal']['result']=result
        self.wall_verifications.append({'wall_id':r['goal']['wall_id'],'point':r['goal']['surface'],'pose':dict(pose),'result':result,'at':time.time()})
        self.update(wall_verifications=self.wall_verifications[-200:])
    def finish_refinement(self):
        self.cancel_refinement();self.command=(0.,0.,0.)
        if self.deep and self.active and self.frontier_grid and self.state.get('pose') and self.inspection_goal(self.state['pose']):
            self.refinement={'phase':'select','started':time.monotonic()};return
        # A fresh explorer retries routes against the improved live costmap;
        # failed old goals must not remain blacklisted after a new observation.
        if self.explorer and self.explorer.poll() is None:self.explorer.terminate()
        self.explorer=None
        if self.active:
            self.explorer=subprocess.Popen(['ros2','run','explore_lite','explore','--ros-args','--params-file','/alfred/explore.yaml'])
            self.update(exploration='starting',message='Replanning after corner inspection')
    def update(self,**values):
        with self.lock:self.state.update(values)
    def goal_status(self,msg):
        for goal in msg.status_list:
            if goal.status==6:self.failed_goals.add(bytes(goal.goal_info.goal_id.uuid))
        self.update(failed_goals=len(self.failed_goals))
    def velocity(self,msg):
        with self.lock:
            self.command=(msg.linear.x,msg.angular.z,time.monotonic()) if self.active or self.docking and self.docking.phase=='navigate' else (0.,0.,0.)
    def stop_docking(self,message=None):
        if self.dock_handle:self.dock_handle.cancel_goal_async();self.dock_handle=None
        if self.docking:
            if message and not self.docking.done and not self.docking.error:self.docking.cancel(message)
            self.update(docking=self.docking.status())
        self.docking=None;self.command=(0.,0.,0.)
        request('/v1/drive/stop',method='POST')
    def docking_fault(self,error):
        """Hold a return across bounded acquisition/transport outages; never replay motion."""
        dock=self.docking
        if dock is None:return
        now=time.monotonic();reason=str(error)
        waking='Robot waking' in reason or 'wake check in progress' in reason
        recoverable=waking or reason in ('Waiting for scan odometry history','Wheel odometry stale') or isinstance(error,(OSError,http.client.HTTPException))
        self.command=(0.,0.,0.)
        if recoverable and now<=self.lease:
            if waking:self.dock_waking_since=self.dock_waking_since or now
            dock.recover_telemetry(now,reason)
            self.update(docking=dock.status())
            if not dock.error:
                try:request('/v1/drive/stop',method='POST')
                except Exception:pass
                return
        self.stop_docking(dock.error or reason)
    def poll_dock_contact(self):
        while True:
            if self.docking:
                started=time.monotonic()
                try:
                    contact=request('/v1/telemetry/dock')
                    if not isinstance(contact.get('docked'),bool):raise ValueError('Invalid charging response')
                    # Fresh native query; age is exclusively local elapsed time.
                    # Device/HQ wall clocks are irrelevant to motor safety.
                    self.dock_contact=(contact,started)
                except Exception:pass
            time.sleep(.3)
    def start_docking(self,body):
        if self.active or self.docking:raise RuntimeError('Another motion controller is active')
        station=body.get('station',{});pose=self.slam.pose()
        if body.get('map_id')!=self.slam.map_id or not self.slam.capture or pose is None:raise RuntimeError('Verify position in the station map before returning')
        if station.get('source')!='docked-robot-pose' or any(not isinstance(station.get(k),(int,float)) or not math.isfinite(station[k]) for k in ('x','y','theta')):raise ValueError('A verified station is required')
        self.dock_contact=None;self.dock_waking_since=None
        template=json.load(open('/alfred/dock-enclosure.json'))['points']
        self.reset_explorer();self.command=(0.,0.,0.);self.generation+=1
        self.docking=Docking(station,template,self.robot_boot,time.monotonic(),pose);self.lease=time.monotonic()+3
        if self.docking.phase=='navigate':
            if not self.state['ready']:self.docking=None;raise RuntimeError('Navigation is not ready for the station approach')
            self.dock_staging={'x':station['x']+.65*math.cos(station['theta']),'y':station['y']+.65*math.sin(station['theta']),'theta':station['theta']}
            goal=NavigateToPose.Goal();goal.pose.header.frame_id='map';goal.pose.header.stamp=self.get_clock().now().to_msg()
            goal.pose.pose.position.x=self.dock_staging['x'];goal.pose.pose.position.y=self.dock_staging['y'];quaternion(goal.pose.pose.orientation,station['theta'])
            owner=self.docking
            def accepted(future):
                with self.lock:
                    try:handle=future.result()
                    except Exception as error:
                        if self.docking is owner:owner.fail('Station route unavailable: '+str(error))
                        return
                    if self.docking is not owner:handle.cancel_goal_async();return
                    if not handle.accepted:owner.fail('Station route rejected');return
                    self.dock_handle=handle
                    def arrived(result):
                        with self.lock:
                            if self.docking is not owner or owner.phase!='navigate':return
                            try:
                                if result.result().status==4:owner.phase='observe';owner.wait_until=time.monotonic()+.4;self.command=(0.,0.,0.)
                                else:owner.fail('Could not reach the station staging point')
                            except Exception as error:owner.fail('Station approach failed: '+str(error))
                    handle.get_result_async().add_done_callback(arrived)
            self.navigator.send_goal_async(goal).add_done_callback(accepted)
        self.update(docking=self.docking.status());return self.docking.status()
    def docking_velocity(self,frame,pose):
        now=time.monotonic();dock=self.docking
        if now>self.lease:dock.fail('HQ heartbeat expired; custom return stopped')
        if self.dock_waking_since is not None:
            work=frame['native'].get('reports',{}).get('/task/WorkState',{}).get('bytes',[])
            scan=frame['lidar']
            if now-self.dock_waking_since>5:
                dock.fail('Robot did not finish waking within 5 seconds');self.stop_docking();return 0.,0.
            if work and work[0]==9 and work[2]!=0 or scan.get('age_ms') is None or scan['age_ms']>500:
                dock.recover_telemetry(now,'robot waking');self.update(docking=dock.status());return 0.,0.
            self.dock_waking_since=None
        sample=self.dock_contact
        if not sample or now-sample[1]>1.5:
            velocity=dock.recover_telemetry(now,'charging contact')
            self.update(docking=dock.status())
            if dock.error:self.stop_docking()
            return velocity
        if dock.recovery_since is not None:
            dock.message='Approaching station' if dock.phase=='navigate' else 'Observing station enclosure'
        dock.recovery_since=None
        contact=sample[0]
        self.dock_battery={'percent':contact.get('percent'),'on_charger':contact['docked']}
        near=dock.phase=='navigate' and pose and math.hypot(pose['x']-self.dock_staging['x'],pose['y']-self.dock_staging['y'])<.10
        if near and self.dock_handle:self.dock_handle.cancel_goal_async();self.dock_handle=None;self.command=(0.,0.,0.)
        linear,angular,received=self.command
        velocity=dock.step(now,{**frame,'odom':tuple(self.odom),'odom_epoch':self.odom_epoch},pose,self.dock_battery,(linear,angular) if now-received<.25 else (0.,0.),near)
        self.update(docking=dock.status())
        if dock.done or dock.error:self.stop_docking();return 0.,0.
        return velocity
    def update_settings(self,body,apply=False):
        if self.active:raise RuntimeError('Pause exploration before changing speed')
        values=dict(self.settings)
        for key in ['cruise_mm_s','approach_mm_s']:
            value=float(body.get(key,values[key]))
            if not math.isfinite(value) or value<=0:raise ValueError('Speeds must be positive finite numbers')
            values[key]=value
        if values['approach_mm_s']>values['cruise_mm_s']:raise ValueError('Approach speed must not exceed cruise speed')
        if apply or self.slam.navigation_ready:
            if not self.parameters.wait_for_services(timeout_sec=1.):raise RuntimeError('Navigation settings service unavailable')
            # Jazzy DWB refreshes max_speed_xy_sq in the min_speed_theta callback,
            # not the max_speed_xy callback. Send this last to apply the new limit.
            future=self.parameters.set_parameters([Parameter('FollowPath.max_vel_x',value=values['cruise_mm_s']/1000),Parameter('FollowPath.max_speed_xy',value=values['cruise_mm_s']/1000),Parameter('FollowPath.min_speed_theta',value=0.)])
            done=threading.Event();future.add_done_callback(lambda _:done.set())
            if not done.wait(2.):raise RuntimeError('Navigation settings update timed out')
            results=future.result().results
            if not all(r.successful for r in results):raise RuntimeError('; '.join(r.reason for r in results if not r.successful))
        os.makedirs('/alfred/state',exist_ok=True)
        with open('/alfred/state/settings.json.new','w') as output:json.dump(values,output)
        os.replace('/alfred/state/settings.json.new','/alfred/state/settings.json');self.settings=values
        return values
    def control(self,action,body):
        if action.startswith('mapping/'):return self.slam.control(action.split('/')[1],body)
        if action=='settings':return self.update_settings(body)
        with self.lock:
            if action=='dock':return self.start_docking(body)
            if action in ('start','heartbeat') and 'walls' in body:
                walls=body['walls']
                if not isinstance(walls,list) or len(walls)>200:raise ValueError('Invalid verification surfaces')
                for wall in walls:
                    if not isinstance(wall.get('id'),str) or len(wall.get('points',[]))!=2 or any(len(p)!=2 or any(not math.isfinite(v) or abs(v)>1000 for v in p) for p in wall['points']):raise ValueError('Invalid verification surface coordinates')
                self.wall_candidates=walls
                if self.deep:self.deep.refresh(walls);self.update(deep_pass=self.deep.status())
            if action=='heartbeat':
                if self.active or self.docking or self.slam.location.get('state')=='locating':self.lease=time.monotonic()+3
            elif action=='start':
                if self.docking:raise RuntimeError('Custom return owns motion; stop it before exploration')
                if not self.state['ready']:raise RuntimeError('Fresh robot telemetry is required')
                self.check_battery()
                self.deep=DeepPass(body.get('deep_pass')) if body.get('deep') else None
                if self.deep:self.deep.refresh(self.wall_candidates)
                self.update(deep_pass=self.deep.status() if self.deep else None)
                self.active=True;self.lease=time.monotonic()+3;self.generation+=1;self.motion_recovery.reset();self.failure_since=None;self.resume_after_fault=False;self.state['stop_reason']=None
                self.state['exploration']='starting';self.failed_goals.clear();self.inspected=[];self.inspection_stalls=0;self.inspection_area=0.;self.wall_attempted=[];self.wall_verifications=[];self.cancel_refinement()
                if self.explorer is None or self.explorer.poll() is not None:
                    self.explorer=subprocess.Popen(['ros2','run','explore_lite','explore','--ros-args','--params-file','/alfred/explore.yaml'])
                else:self.resume_pub.publish(Bool(data=True))
                if self.deep:self.refinement={'phase':'select','started':time.monotonic()}
            elif action=='pause':
                if self.docking:self.stop_docking('Custom return stopped')
                self.cancel_refinement()
                self.active=False;self.generation+=1;self.command=(0.,0.,0.);self.recovery=None;self.motion_recovery.reset();self.resume_after_fault=False
                self.resume_pub.publish(Bool(data=False))
                try:request('/v1/drive/stop',method='POST')
                except Exception as error:self.update(message='Stopped locally; robot link unavailable: '+str(error))
            else:raise ValueError('Unknown action')
            return {**self.state,'active':self.active,'settings':self.settings,'mapping':self.slam.status()}
    def reset_explorer(self):
        if self.explorer and self.explorer.poll() is None:
            self.explorer.terminate()
            try:self.explorer.wait(timeout=1.)
            except subprocess.TimeoutExpired:self.explorer.kill()
        self.explorer=None;self.failed_goals.clear();self.contacts=[]
        self.update(path=[],exploration='idle',failed_goals=0)
    def check_battery(self):
        if time.monotonic()-self.battery_at>2:
            self.battery=request('/v1/telemetry/battery');self.battery_at=time.monotonic()
        percent=self.battery.get('percent')
        if percent is None:raise RuntimeError('Battery telemetry unavailable; exploration paused')
        if percent<=10 or self.battery.get('low_voltage'):
            raise RuntimeError(f'Battery at {percent}%; charge Alfred before exploring')
        if self.battery.get('on_charger'):raise RuntimeError('Remove Alfred from the charger before exploring')
    def recovery_velocity(self, sensors, pose, now):
        pressed=sensors.get('left') or sensors.get('right')
        if pressed and self.recovery is None:
            self.motion_recovery.reset()
            self.contacts=[t for t in self.contacts if now-t<30]+[now]
            if len(self.contacts)>4:raise RuntimeError('Repeated contact; exploration paused')
            self.resume_pub.publish(Bool(data=False));self.command=(0.,0.,0.)
            self.recovery={'phase':'back','started':now,'pose':dict(pose),'turn':-1 if sensors.get('left') else 1}
            point=PointCloud2();point.header.stamp=self.get_clock().now().to_msg();point.header.frame_id='map';point.height=1;point.width=1
            point.fields=[PointField(name=n,offset=i*4,datatype=PointField.FLOAT32,count=1) for i,n in enumerate(['x','y','z'])];point.point_step=12;point.row_step=12;point.is_dense=True
            side=.08 if sensors.get('left') else -.08
            point.data=struct.pack('<fff',pose['x']+.18*math.cos(pose['theta'])-side*math.sin(pose['theta']),pose['y']+.18*math.sin(pose['theta'])+side*math.cos(pose['theta']),.1)
            self.contact_pub.publish(point)
        r=self.recovery
        if r is None:return None
        if r['phase']=='back':
            self.update(message='Bumper contact; backing away')
            if now-r['started']>(3. if self.deep else 1.5):raise RuntimeError('Bumper recovery could not clear the surface; stopped')
            if self.deep and blocked(getattr(self,'current_points',[]),False,.30):raise RuntimeError('Rear surface blocks contact recovery; stopped')
            if not pressed and (math.hypot(pose['x']-r['pose']['x'],pose['y']-r['pose']['y'])>(.10 if self.deep else .025) or now-r['started']>(2.2 if self.deep else .9)):
                r.update(phase='turn',started=now,target=wrap(pose['theta']+r['turn']*math.pi/2))
                return 0.,0.
            return (-.06 if self.deep and not pressed else -.03),0.
        if pressed:raise RuntimeError('Contact during recovery turn; stopped')
        error=wrap(r['target']-pose['theta']);self.update(message='Turning away from contact')
        if abs(error)<.1:
            self.recovery=None;self.command=(0.,0.,0.)
            if self.deep:self.refinement={'phase':'select','started':now}
            else:self.resume_pub.publish(Bool(data=True))
            return 0.,0.
        if now-r['started']>8:raise RuntimeError('Recovery turn made insufficient progress')
        return 0.,max(-.35,min(.35,error))

    def run_poll(self):
        while rclpy.ok():
            started=time.monotonic();self.poll();time.sleep(max(.001,.05-(time.monotonic()-started)))
    def poll(self):
        try:
            frame=request('/v1/mapping/native/frame');status=frame['native'];wheels=status['wheels']
            if self.robot_boot and self.robot_boot!=status['boot_id']:
                self.control('pause',{});self.slam.capture=False;self.slam.locating=False;self.slam.location_token+=1;self.slam.pose_seen=0.
                self.previous=None;self.odom=[0.,0.,0.];self.odom_epoch+=1;self.last_scan=None;self.scan_geometry=ScanGeometry()
            self.robot_boot=status['boot_id']
            if wheels['age_ms'] is None or wheels['age_ms']>300:raise RuntimeError('Wheel odometry stale')
            now=self.get_clock().now().to_msg()
            vx=wz=0.
            if self.previous:
                old=self.previous;dt=wheels['stamp']-old['stamp']
                # Absolute wheel counters preserve a small docking step across a delayed poll.
                # The engine deadman has already stopped motion during the gap.
                dock_gap=bool(self.docking and .5<=dt<=1.5 and max(abs(a-b) for a,b in zip(wheels['values'],old['values']))<=30)
                if (dt>=.5 and not dock_gap) or dt<0:self.odom_epoch+=1
                if 0<dt<.5 or dock_gap:
                    dl=(wheels['values'][0]-old['values'][0])/1000;dr=(wheels['values'][1]-old['values'][1])/1000
                    if max(abs(dl),abs(dr))>.2:
                        self.odom_epoch+=1;raise RuntimeError('Wheel counter discontinuity')
                    dyaw=(dr-dl)/self.settings['wheel_separation_m'];distance=(dl+dr)/2
                    self.odom[0]+=distance*math.cos(self.odom[2]+dyaw/2);self.odom[1]+=distance*math.sin(self.odom[2]+dyaw/2);self.odom[2]=wrap(self.odom[2]+dyaw)
                    vx=distance/dt;wz=dyaw/dt
            self.previous=wheels
            self.scan_geometry.odometry(wheels["stamp"],self.odom)
            odom=Odometry();odom.header.stamp=now;odom.header.frame_id='odom';odom.child_frame_id='base_link'
            odom.pose.pose.position.x=self.odom[0];odom.pose.pose.position.y=self.odom[1];quaternion(odom.pose.pose.orientation,self.odom[2]);odom.twist.twist.linear.x=vx;odom.twist.twist.angular.z=wz
            self.odom_pub.publish(odom)
            local=TransformStamped();local.header=odom.header;local.child_frame_id='base_link';local.transform.translation.x=self.odom[0];local.transform.translation.y=self.odom[1];quaternion(local.transform.rotation,self.odom[2])
            self.tf.sendTransform([local])
            mapped_pose=self.slam.pose()
            pose=mapped_pose or {'x':self.odom[0],'y':self.odom[1],'theta':self.odom[2],'age_ms':0}
            scan=frame['lidar']
            if scan['age_ms'] is None or scan['age_ms']>600:raise RuntimeError('LiDAR stale')
            if (self.slam.capture or self.slam.locating) and scan['sequence']!=self.last_scan:
                laser=LaserScan();laser.header.stamp=(self.get_clock().now()-Duration(seconds=max(0.,wheels['stamp']-scan.get('source_stamp',wheels['stamp'])))).to_msg();laser.header.frame_id='laser';laser.angle_min=-math.pi;laser.angle_increment=2*math.pi/720;laser.angle_max=laser.angle_min+719*laser.angle_increment;laser.range_min=self.settings['robot_radius_m']+.015;laser.range_max=12.;laser.scan_time=.2
                ranges=[math.inf]*720
                points=self.scan_geometry.points(scan)
                if points is None:raise RuntimeError('Waiting for scan odometry history')
                for x,y in points:
                    distance=math.hypot(x,y)
                    if not self.settings['robot_radius_m']+.015<distance<12:continue
                    index=round((math.atan2(y,x)+math.pi)/laser.angle_increment)%720;ranges[index]=min(ranges[index],distance)
                # Drop isolated returns, retaining coherent surfaces and gaps as unknown.
                supported=[value if math.isfinite(value) and sum(math.isfinite(ranges[(i+d)%720]) and abs(ranges[(i+d)%720]-value)<.06 for d in range(-2,3))>=3 else math.inf for i,value in enumerate(ranges)]
                laser.ranges=supported
                obstacles=copy.deepcopy(laser)
                # Only a verified, time-aligned map pose may address the engine's
                # map-scoped boundary model. No host/device wall-clock comparison.
                scan_pose=None
                scan_odom=self.scan_geometry.at(scan['source_stamp'])
                if mapped_pose and scan_odom and self.slam.map_id and not self.slam.locating:
                    scan_pose=advance_pose(mapped_pose,self.odom,scan_odom)
                    measured=[(r*math.cos(laser.angle_min+i*laser.angle_increment),r*math.sin(laser.angle_min+i*laser.angle_increment)) for i,r in enumerate(supported) if math.isfinite(r)]
                    filtered=request('/v1/mapping/reflectance/filter',{'map_id':self.slam.map_id,'pose':scan_pose,'points':measured})
                    # NaN is unknown, not a max-range clearing ray. Boundary
                    # intersections go only to obstacle marking, not scan matching.
                    if filtered['reflected']:
                        laser.ranges=[math.nan]*720;obstacles.ranges=[math.nan]*720
                        for target,cloud in ((laser,filtered['points']),(obstacles,filtered['points']+filtered['obstacles'])):
                            bins=[math.nan]*720
                            for x,y in cloud:
                                index=round((math.atan2(y,x)+math.pi)/laser.angle_increment)%720
                                d=math.hypot(x,y);bins[index]=d if not math.isfinite(bins[index]) else min(bins[index],d)
                            target.ranges=bins
                    self.update(reflectance={'revision':filtered['revision'],'reflected_rays':filtered['reflected']})
                self.obstacle_scan_pub.publish(obstacles)
                self.slam.scan(laser,scan['sequence'],scan_pose,scan_odom);self.last_scan=scan['sequence']
            ready=self.slam.navigation_ready and self.navigator.server_is_ready() and self.last_map is not None and mapped_pose is not None
            self.update(ready=ready,message=('Exploring' if self.active else (self.state.get('stop_reason') or 'Navigation ready')) if ready else (self.slam.pose_error or 'Starting navigation controller'),pose=mapped_pose,measured_speed_mm_s=vx*1000,telemetry={'wheel_age_ms':wheels['age_ms'],'lidar_age_ms':scan['age_ms']})
            with self.lock:
                if self.docking:
                    linear,angular=self.docking_velocity(frame,mapped_pose)
                    request('/v1/mapping/twist',{'linear_mm_s':linear*1000,'angular_rad_s':angular,'wheel_separation_mm':self.settings['wheel_separation_m']*1000},'PUT')
                if self.active and time.monotonic()>self.lease:
                    self.active=False;self.cancel_refinement();self.command=(0.,0.,0.);self.resume_pub.publish(Bool(data=False));request('/v1/drive/stop',method='POST');self.update(message='HQ heartbeat expired; stopped')
                if self.active:
                    if ready and getattr(self,'resume_after_fault',False):
                        self.resume_after_fault=False;self.command=(0.,0.,0.);self.resume_pub.publish(Bool(data=True))
                    self.check_battery()
                    if mapped_pose is None:raise RuntimeError(self.slam.pose_error or "SLAM position unavailable; stopped")
                    linear,angular,received=self.command
                    if time.monotonic()-received>.25:linear=angular=0.
                    sensors=frame['bumpers']
                    if not sensors.get('fresh') or sensors.get('cliff_raw')!=0 or sensors.get('wheel_lift_raw')!=0:raise RuntimeError('Safety telemetry unavailable or cliff/lift detected')
                    self.current_points=scan['points']
                    if sensors.get('left') or sensors.get('right'):
                        self.record_verification(pose,'contact')
                        self.cancel_refinement()
                    refinement=self.refinement_velocity(pose,time.monotonic()) if self.recovery is None else None
                    if refinement is not None:linear,angular=refinement
                    recovery=self.recovery_velocity(sensors,pose,time.monotonic())
                    if recovery is not None:linear,angular=recovery
                    else:
                        # Accepted scan pose detects spinning wheels without counting
                        # odometry extrapolation as real forward progress.
                        matched=self.slam.last_pose
                        progress_pose=matched if matched and time.monotonic()-self.slam.pose_seen<2. else pose
                        probing=self.refinement is not None and self.refinement['phase'] in ('align','probe')
                        motion=None if probing else self.motion_recovery.step(time.monotonic(),progress_pose,linear,angular,scan['points'],self.settings['cruise_mm_s']/1000)
                        event=None if probing else self.motion_recovery.event
                        if event=='pause':self.cancel_refinement();self.resume_pub.publish(Bool(data=False));self.command=(0.,0.,0.)
                        if event=='resume':self.command=(0.,0.,0.);self.resume_pub.publish(Bool(data=True))
                        if event=='blocked':
                            point=PointCloud2();point.header.stamp=self.get_clock().now().to_msg();point.header.frame_id='map';point.height=1;point.width=1
                            point.fields=[PointField(name=n,offset=i*4,datatype=PointField.FLOAT32,count=1) for i,n in enumerate(['x','y','z'])];point.point_step=12;point.row_step=12;point.is_dense=True
                            point.data=struct.pack('<fff',pose['x']+.35*math.cos(pose['theta']),pose['y']+.35*math.sin(pose['theta']),.1);self.contact_pub.publish(point)
                        if motion is not None:
                            linear,angular=motion;recovery=motion
                            self.update(message=self.motion_recovery.message or 'Choosing the next route')
                    if linear>0 and recovery is None:
                        # Slow for a coherent surface close to the front body,
                        # not one noisy return half a metre away. Nav2 still checks
                        # the full footprint along the trajectory.
                        if blocked(scan['points'],True,.36):linear=min(linear,self.settings['approach_mm_s']/1000)
                    self.update(commanded_speed_mm_s=linear*1000,commanded_yaw_rad_s=angular)
                    # Physical endpoint uses ROS CCW yaw directly, independent of cockpit mixing.
                    request('/v1/mapping/twist',{'linear_mm_s':linear*1000, 'angular_rad_s':angular, 'wheel_separation_mm':self.settings['wheel_separation_m']*1000},'PUT')
            self.failure_since=None
        except Exception as error:
            self.update(ready=False,message=str(error))
            if self.docking:
                try:self.docking_fault(error)
                except Exception:pass
            if self.active:
                self.command=(0.,0.,0.)
                if 'bumper pressed' in str(error):return
                self.failure_since=getattr(self,'failure_since',None) or time.monotonic()
                self.resume_after_fault=getattr(self,'resume_after_fault',False) or self.recovery is not None or self.motion_recovery.phase is not None
                self.recovery=None;self.motion_recovery.reset()
                terminal=isinstance(error,RecoveryBlocked) or any(s in str(error) for s in ('cliff/lift','Battery at','charger','Repeated contact','Bumper did not release','Bumper recovery','Rear surface blocks','recovery turn','Recovery turn'))
                if terminal or time.monotonic()-self.failure_since>5.:
                    self.active=False;self.cancel_refinement();self.resume_after_fault=False;self.resume_pub.publish(Bool(data=False));self.update(stop_reason=str(error))
                try:request('/v1/drive/stop',method='POST')
                except Exception:pass

def main():
    rclpy.init();node=Bridge()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed=urllib.parse.urlparse(self.path)
            def result():
                if parsed.path=='/grid':return node.slam.grid
                if parsed.path=='/structure':
                    sequence=urllib.parse.parse_qs(parsed.query).get('sequence',[None])[0]
                    return None if node.slam.structure and node.slam.structure['sequence']==sequence else node.slam.structure
                return {**node.state,'active':node.active,'settings':node.settings,'mapping':node.slam.status()}
            self.reply(result)
        def do_POST(self):
            length=int(self.headers.get('Content-Length',0))
            body=json.loads(self.rfile.read(length) or '{}');self.reply(lambda:node.control(self.path.strip('/'),body))
        def reply(self,fn):
            try:value={'ok':True,'result':fn()};code=200
            except Exception as error:value={'ok':False,'error':str(error)};code=400
            data=json.dumps(value).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('0.0.0.0',8766),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:rclpy.spin(node)
    finally:
        node.active=False
        try:request('/v1/drive/stop',method='POST')
        except Exception:pass
        if node.explorer:node.explorer.terminate()
        server.shutdown();rclpy.shutdown()
if __name__=='__main__':main()
