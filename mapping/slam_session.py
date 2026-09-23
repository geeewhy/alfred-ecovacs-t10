"""SLAM Toolbox lifecycle, corrected geometry and durable graph snapshots."""
import json,math,os,re,threading,time,subprocess
from pathlib import Path
from localization_seed import refine_seed
import rclpy
from geometry_msgs.msg import PoseWithCovarianceStamped, Pose2D
from nav2_msgs.msg import ParticleCloud
from nav2_msgs.srv import ManageLifecycleNodes
from sensor_msgs.msg import LaserScan
from std_srvs.srv import Empty
from scipy.spatial import cKDTree
from nav_msgs.msg import OccupancyGrid
from visualization_msgs.msg import MarkerArray
from slam_toolbox.srv import Reset,SerializePoseGraph,DeserializePoseGraph
from tf2_ros import Buffer,TransformListener
from rclpy.qos import qos_profile_sensor_data

class SlamSession:
    def __init__(self,node,qos):
        self.node=node;self.capture=False;self.map_id=None;self.grid=None;self.structure=None;self.sequence=0;self.pose_seen=0.;self.last_pose=None;self.graph_nodes=[];self.graph_edges=0
        self.boot_id=None;self.saved_pose=None;self.structure=None;self.last_save=0.;self.save_lock=threading.RLock()
        self.locating=False;self.location={'state':'idle'};self.location_token=0;self.candidates=[];self.particles=[];self.scan_points=[];self.scan_sequence=0
        self.location_map=node.create_publisher(OccupancyGrid,'localization_map',qos)
        self.location_scan=node.create_publisher(LaserScan,'localization_scan',10)
        self.initial_pose=node.create_publisher(PoseWithCovarianceStamped,'initialpose',10)
        self.global_localization=node.create_client(Empty,'reinitialize_global_localization')
        self.nomotion=node.create_client(Empty,'request_nomotion_update')
        node.create_subscription(PoseWithCovarianceStamped,'localization_pose',self.localization_pose,10)
        node.create_subscription(ParticleCloud,'localization_particles',lambda m:setattr(self,'particles',m.particles),qos_profile_sensor_data)
        self.buffer=Buffer();self.listener=TransformListener(self.buffer,node)
        node.create_subscription(OccupancyGrid,'map',self.map_update,qos)
        node.create_subscription(PoseWithCovarianceStamped,'pose',self.pose_update,10)
        node.create_subscription(MarkerArray,'slam_toolbox/graph_visualization',self.graph_update,10)
        self.navigation_started=False;self.navigation_ready=False
        self.navigation_lifecycle=node.create_client(ManageLifecycleNodes,'lifecycle_manager_navigation/manage_nodes')
        self.reset=node.create_client(Reset,'slam_toolbox/reset')
        self.serialize=node.create_client(SerializePoseGraph,'slam_toolbox/serialize_map')
        self.deserialize=node.create_client(DeserializePoseGraph,'slam_toolbox/deserialize_map')
    def map_update(self,msg):
        if not self.capture:return
        self.sequence+=1
        cells=[[i%msg.info.width,i//msg.info.width,127 if v<50 else 129] for i,v in enumerate(msg.data) if v>=0]
        self.grid={'sequence':self.sequence,'width':msg.info.width,'height':msg.info.height,'resolution':msg.info.resolution,'origin':[msg.info.origin.position.x,msg.info.origin.position.y],'cells':cells,'age_ms':0}
        self.node.last_map=self.sequence
        if time.monotonic()-self.last_save>15:
            self.last_save=time.monotonic()
            threading.Thread(target=self.checkpoint,daemon=True).start()
        if not self.navigation_started:
            self.navigation_started=True
            threading.Thread(target=self.start_navigation,daemon=True).start()
    def start_navigation(self):
        try:
            self.service(self.navigation_lifecycle,ManageLifecycleNodes.Request(command=0))
            self.node.update_settings(self.node.settings,apply=True)
            self.navigation_ready=True
        except Exception as error:self.navigation_started=False;self.navigation_ready=False;self.node.update(message=str(error))
    def pose_update(self,msg):
        p=msg.pose.pose;q=p.orientation
        self.last_pose={'x':p.position.x,'y':p.position.y,'theta':math.atan2(2*q.w*q.z,1-2*q.z*q.z),'age_ms':0}
        self.pose_seen=time.monotonic();self.odom_at_pose=list(self.node.odom)
    def graph_update(self,msg):
        self.graph_nodes=[{'id':m.id,'x':m.pose.position.x,'y':m.pose.position.y} for m in msg.markers if m.ns=='slam_toolbox' and m.action==0]
        self.graph_edges=sum(len(m.points)//2 for m in msg.markers if m.ns=='slam_toolbox_edges' and m.id==0)
    def pose(self):
        self.pose_error=None
        if not self.pose_seen:self.pose_error='Waiting for first matched scan';return None
        prior=getattr(self,'odom_at_pose',None)
        if prior:
            odom=self.node.odom
            distance=math.hypot(odom[0]-prior[0],odom[1]-prior[1])
            angle=abs(math.atan2(math.sin(odom[2]-prior[2]),math.cos(odom[2]-prior[2])))
            if distance>.25 or angle>.5:
                self.pose_error='SLAM stopped matching motion (%.0f mm / %.0f degrees)'%(distance*1000,math.degrees(angle));return None
        try:
            transform=self.buffer.lookup_transform('map','base_link',rclpy.time.Time())
            age=(self.node.get_clock().now().nanoseconds-(transform.header.stamp.sec*10**9+transform.header.stamp.nanosec))/10**6
            if age>500:self.pose_error='Map transform stale (%.0f ms)'%age;return None
            t=transform.transform
            q=t.rotation
            return {'x':t.translation.x,'y':t.translation.y,'theta':math.atan2(2*(q.w*q.z+q.x*q.y),1-2*(q.y*q.y+q.z*q.z)),'age_ms':max(0,age)}
        except Exception as error:self.pose_error='Map transform unavailable: '+str(error);return None
    def status(self):
        return {'backend':'slam_toolbox','map_id':self.map_id,'capture':self.capture,'graph_nodes':len(self.graph_nodes),'graph_edges':self.graph_edges,'graph':self.graph_nodes,'boot_id':self.boot_id,'pose':self.pose(),'location':self.location,'tracking_error':self.pose_error,'matched_pose':self.last_pose,'matched_age_ms':int((time.monotonic()-self.pose_seen)*1000) if self.pose_seen else None}
    def service(self,client,request):
        if not client.wait_for_service(timeout_sec=2.):raise RuntimeError('SLAM service not ready')
        future=client.call_async(request);done=threading.Event();future.add_done_callback(lambda _:done.set())
        if not done.wait(5.):raise RuntimeError('SLAM operation timed out')
        result=future.result()
        if result is None or (hasattr(result,"success") and not result.success):raise RuntimeError("Mapping lifecycle operation failed")
        if hasattr(result,'result') and result.result!=0:raise RuntimeError('SLAM operation failed: '+str(result.result))
        return result
    def directory(self,map_id):
        if not re.fullmatch(r'[a-f0-9-]{36}',map_id or ''):raise ValueError('Invalid map ID')
        p=Path('/alfred/state/maps')/map_id;p.mkdir(parents=True,exist_ok=True);return p
    def checkpoint(self):
        try:self.save()
        except Exception as error:self.node.update(checkpoint_error=str(error))
    def save(self):
        with self.save_lock:self.save_locked()
    def save_locked(self):
        if not self.map_id or self.grid is None or self.location.get("state") in ("locating","failed"):return
        pose=self.pose() or self.last_pose
        if pose is None:raise RuntimeError('No verified pose to save')
        directory=self.directory(self.map_id);filename='graph-'+str(time.time_ns())
        self.service(self.serialize,SerializePoseGraph.Request(filename=str(directory/filename)))
        for extension in ['.posegraph','.data']:
            if not (directory/(filename+extension)).is_file():raise RuntimeError('SLAM graph snapshot incomplete')
        structure_file=directory/(filename+'.json')
        try:
            subprocess.run(['/usr/local/bin/graph_export',str(directory/filename),str(structure_file)],check=True,timeout=5,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            exported=json.loads(structure_file.read_text())
            exported['grid'].update(sequence=self.sequence,age_ms=0)
            self.structure={**exported,'map_id':self.map_id,'sequence':filename}
            self.node.update(structure_error=None)
        except Exception as error:
            structure_file.unlink(missing_ok=True);self.node.update(structure_error=str(error))
        manifest={'filename':filename,'pose':pose,'boot_id':self.boot_id,'grid':self.structure['grid'] if self.structure and self.structure['sequence']==filename else self.grid,'saved_at':time.time()}
        temp=directory/'manifest.new';temp.write_text(json.dumps(manifest));os.replace(temp,directory/'manifest.json')
        # Keep current and previous complete snapshots; clean only our own files.
        for old in sorted(directory.glob('graph-*.posegraph'))[:-2]:
            old.unlink();old.with_suffix('.data').unlink(missing_ok=True);old.with_suffix('.json').unlink(missing_ok=True)
        self.saved_pose=manifest['pose'];self.last_save=time.monotonic();self.node.update(checkpoint_error=None)
    def control(self,action,body):
        # Motion stops before waiting for graph serialization or export.
        if action in ('pause','start') or (action=='delete' and body.get('id')==self.map_id):
            self.location_token+=1;self.locating=False;self.capture=False
            self.node.control('pause',{})
        with self.save_lock:return self.control_locked(action,body)
    def control_locked(self,action,body):
        if action=='pause':
            self.location_token+=1;self.locating=False
            self.capture=False;self.save();return self.status()
        map_id=body['id'];directory=self.directory(map_id)
        if action=='delete':
            if self.map_id==map_id:
                self.node.control('pause',{});self.capture=False;self.map_id=None;self.grid=None;self.structure=None
            archive=Path('/alfred/state/deleted');archive.mkdir(parents=True,exist_ok=True)
            os.replace(directory,archive/(map_id+'-'+str(time.time_ns())))
            return {'deleted':True,'id':map_id}
        self.node.control('pause',{})
        if action=='start':
            self.location_token+=1;self.locating=False;self.node.reset_explorer()
            self.capture=False;self.service(self.reset,Reset.Request(pause_new_measurements=False))
            self.grid=None;self.structure=None;self.node.last_map=None;self.graph_nodes=[];self.graph_edges=0
            self.map_id=map_id;self.boot_id=body['boot_id'];self.pose_seen=0.;self.location={'state':'idle'};self.capture=True
        elif action in ('resume','locate'):
            # Carrying the robot does not advance wheel counters or change boot
            # ID, so every resume verifies the saved frame before navigation.
            self.node.reset_explorer()
            self.begin_location(map_id,body['boot_id'],warm=True)
        else:raise ValueError('Unknown mapping action')
        return self.status()

    def scan(self,laser,sequence):
        self.scan_sequence=sequence
        self.scan_points=[(r*math.cos(laser.angle_min+i*laser.angle_increment),r*math.sin(laser.angle_min+i*laser.angle_increment)) for i,r in enumerate(laser.ranges) if math.isfinite(r) and laser.range_min<r<laser.range_max]
        if self.locating:self.location_scan.publish(laser)
        elif self.capture:self.node.scan_pub.publish(laser)
    def begin_location(self,map_id,boot_id,warm=False):
        manifest=json.loads((self.directory(map_id)/'manifest.json').read_text())
        self.capture=False;self.locating=True;self.location_token+=1;token=self.location_token
        self.location={'state':'locating','message':'Finding Alfred in the saved map'};self.candidates=[];self.particles=[]
        grid=manifest['grid'];resolution=grid['resolution'];origin=grid['origin']
        occupied=[(origin[0]+(x+.5)*resolution,origin[1]+(y+.5)*resolution) for x,y,v in grid['cells'] if v>127]
        if len(occupied)<20:raise RuntimeError('Map has too little measured structure for localization')
        self.reference=cKDTree(occupied)
        m=OccupancyGrid();m.header.frame_id='map';m.header.stamp=self.node.get_clock().now().to_msg();m.info.width=grid['width'];m.info.height=grid['height'];m.info.resolution=resolution;m.info.origin.position.x=origin[0];m.info.origin.position.y=origin[1];m.info.origin.orientation.w=1.
        data=[-1]*(m.info.width*m.info.height)
        for x,y,v in grid['cells']:data[y*m.info.width+x]=0 if v<=127 else 100
        m.data=data;self.location_map.publish(m)
        threading.Thread(target=self.finish_location,args=(token,map_id,boot_id,manifest,warm),daemon=True).start()
    def localization_pose(self,msg):
        if not self.locating or len(self.scan_points)<100:return
        p=msg.pose.pose;q=p.orientation;theta=math.atan2(2*q.w*q.z,1-2*q.z*q.z)
        covariance=msg.pose.covariance
        self.location.update(covariance=[covariance[0],covariance[7],covariance[35]],scan_points=len(self.scan_points),particles=len(self.particles))
        if max(covariance[0],covariance[7])>.01 or covariance[35]>.025:return
        c=math.cos(theta);s=math.sin(theta)
        points=[(p.position.x+c*x-s*y,p.position.y+s*x+c*y) for x,y in self.scan_points]
        distances,_=self.reference.query(points);score=float(sum(distances<.10)/len(distances))
        self.location['score']=score
        if score<.70:return
        total=sum(v.weight for v in self.particles)
        support=sum(v.weight for v in self.particles if math.hypot(v.pose.position.x-p.position.x,v.pose.position.y-p.position.y)<.3 and abs(math.atan2(math.sin(2*math.atan2(v.pose.orientation.z,v.pose.orientation.w)-theta),math.cos(2*math.atan2(v.pose.orientation.z,v.pose.orientation.w)-theta)))<.3)
        self.location['particle_support']=support/total if total else 0
        if total<=0 or support/total<.85:return
        candidate={'x':p.position.x,'y':p.position.y,'theta':theta,'score':score,'sequence':self.scan_sequence}
        if self.candidates:
            last=self.candidates[-1]
            if last['sequence']==candidate['sequence']:return
            if math.hypot(last['x']-candidate['x'],last['y']-candidate['y'])>.08 or abs(math.atan2(math.sin(last['theta']-theta),math.cos(last['theta']-theta)))>.1:self.candidates=[]
        self.candidates.append(candidate);self.candidates=self.candidates[-3:]
    def finish_location(self,token,map_id,boot_id,manifest,warm):
        try:
            time.sleep(.2)
            if warm and manifest.get('pose'):
                prior=refine_seed(self.reference,self.scan_points,manifest['pose']);self.location['seed']=prior
                msg=PoseWithCovarianceStamped();msg.header.frame_id='map';msg.header.stamp=self.node.get_clock().now().to_msg();msg.pose.pose.position.x=prior['x'];msg.pose.pose.position.y=prior['y'];msg.pose.pose.orientation.z=math.sin(prior['theta']/2);msg.pose.pose.orientation.w=math.cos(prior['theta']/2);msg.pose.covariance[0]=.04;msg.pose.covariance[7]=.04;msg.pose.covariance[35]=.1;self.initial_pose.publish(msg)
            else:self.service(self.global_localization,Empty.Request())
            deadline=time.monotonic()+10
            global_at=time.monotonic()+4 if warm and manifest.get('pose') else None
            while token==self.location_token and time.monotonic()<deadline and len(self.candidates)<3:
                if global_at and time.monotonic()>=global_at:
                    global_at=None
                    covariance=self.location.get('covariance',[])
                    # Do not throw away a converging warm estimate just before
                    # it meets the unchanged acceptance thresholds.
                    converging=len(covariance)==3 and max(covariance[:2])<.02 and covariance[2]<.06
                    if converging:self.location.update(message='Confirming the saved position')
                    else:
                        self.candidates=[];self.particles=[]
                        self.location.update(message='Searching the saved map')
                        self.service(self.global_localization,Empty.Request())
                self.nomotion.call_async(Empty.Request());time.sleep(.2)
            if token!=self.location_token:return
            if len(self.candidates)<3:raise RuntimeError('Could not verify position against the saved map; wheels remain stopped.')
            p=self.candidates[-1];self.locating=False
            request=DeserializePoseGraph.Request(filename=str(self.directory(map_id)/manifest['filename']),match_type=2,initial_pose=Pose2D(x=p['x'],y=p['y'],theta=p['theta']))
            started=time.monotonic()
            with self.save_lock:
                if token!=self.location_token:return
                self.service(self.deserialize,request)
                if token!=self.location_token:return
                self.map_id=map_id;self.boot_id=boot_id;self.capture=True;self.grid=manifest['grid'];self.node.last_map=self.grid['sequence']
            # Stationary SLAM can publish only one accepted pose because its
            # travel filter suppresses identical scans. Wait for agreement, not
            # for three accepted movements from a robot that must stay still.
            accepted=None;agrees=False
            while token==self.location_token and time.monotonic()-started<3:
                accepted=self.last_pose
                if self.pose_seen>=started and accepted:
                    agrees=math.hypot(accepted['x']-p['x'],accepted['y']-p['y'])<=.15 and abs(math.atan2(math.sin(accepted['theta']-p['theta']),math.cos(accepted['theta']-p['theta'])))<=.15
                    if agrees:break
                time.sleep(.1)
            self.location.update(candidate=p,confirmed=accepted,pose_seen_after_load=self.pose_seen>=started)
            if token!=self.location_token:return
            if not agrees:raise RuntimeError('Saved graph disagrees with the verified scan position; wheels remain stopped.')
            self.location={'state':'located','score':p['score'],'message':'Position found'}
        except Exception as error:
            if token==self.location_token:self.capture=False;self.locating=False;self.location.update(state='failed',message=str(error))
