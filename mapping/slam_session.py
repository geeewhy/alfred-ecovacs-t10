"""SLAM Toolbox lifecycle, corrected geometry and durable graph snapshots."""
import json,math,os,re,threading,time,subprocess
from collections import OrderedDict
from pathlib import Path
from localization_seed import advance_pose
import rclpy
from geometry_msgs.msg import PoseWithCovarianceStamped, Pose2D
from nav2_msgs.srv import ManageLifecycleNodes
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid
from visualization_msgs.msg import MarkerArray
from slam_toolbox.srv import Reset,SerializePoseGraph,DeserializePoseGraph
from tf2_ros import Buffer,TransformListener
from rclpy.qos import qos_profile_sensor_data

class SlamSession:
    def __init__(self,node,qos):
        self.node=node;self.capture=False;self.map_id=None;self.grid=None;self.structure=None;self.sequence=0;self.pose_seen=0.;self.last_pose=None;self.graph_nodes=[];self.graph_edges=0
        self.boot_id=None;self.saved_pose=None;self.structure=None;self.last_save=0.;self.save_lock=threading.RLock()
        self.locating=False;self.location={'state':'idle'};self.location_token=0;self.candidates=[];self.particles=[];self.scan_points=[];self.scan_sequence=0;self.scan_seen=0.;self.scan_snapshot=None
        self.engine_location=None;self.engine_location_seen=0.;self.engine_enabled=False
        self.reflection_grid=None
        self.reference_manifest=None;self.quality_hold=False;self.tracking_evidence=None;self.recovery_count=0;self.scan_odometry=OrderedDict()
        self.navigation_map=node.create_publisher(OccupancyGrid,'navigation_map',qos)
        self.location_map=node.create_publisher(OccupancyGrid,'localization_map',qos)
        self.location_scan=node.create_publisher(LaserScan,'localization_scan',10)
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
        if not self.capture or self.quality_hold:return
        if self.engine_enabled:
            pose=self.pose()
            if pose is None or not self.builder_agrees(pose,self.node.odom):return
        self.sequence+=1
        cells=[[i%msg.info.width,i//msg.info.width,127 if v<50 else 129] for i,v in enumerate(msg.data) if v>=0]
        self.grid={'sequence':self.sequence,'width':msg.info.width,'height':msg.info.height,'resolution':msg.info.resolution,'origin':[msg.info.origin.position.x,msg.info.origin.position.y],'cells':cells,'age_ms':0}
        if self.reflection_grid is not None:self.grid={**self.reflection_grid,'sequence':self.sequence}
        self.publish_navigation_grid(self.grid)
        self.node.last_map=self.sequence
        if time.monotonic()-self.last_save>15:
            self.last_save=time.monotonic()
            threading.Thread(target=self.checkpoint,daemon=True).start()
        if not self.navigation_started:
            self.navigation_started=True
            threading.Thread(target=self.start_navigation,daemon=True).start()
    def publish_navigation_grid(self,grid):
        m=OccupancyGrid();m.header.frame_id='map';m.header.stamp=self.node.get_clock().now().to_msg()
        m.info.width=grid['width'];m.info.height=grid['height'];m.info.resolution=grid['resolution'];m.info.origin.position.x=grid['origin'][0];m.info.origin.position.y=grid['origin'][1];m.info.origin.orientation.w=1.
        data=[-1]*(grid['width']*grid['height'])
        for x,y,v in grid['cells']:data[y*grid['width']+x]=100 if v>127 else 0
        m.data=data;self.navigation_map.publish(m)

    def start_navigation(self):
        try:
            self.service(self.navigation_lifecycle,ManageLifecycleNodes.Request(command=0))
            self.node.update_settings(self.node.settings,apply=True)
            self.navigation_ready=True
        except Exception as error:self.navigation_started=False;self.navigation_ready=False;self.node.update(message=str(error))
    def pose_update(self,msg):
        stamp=msg.header.stamp.sec*10**9+msg.header.stamp.nanosec
        odom=self.scan_odometry.get(stamp)
        if odom is None:return
        p=msg.pose.pose;q=p.orientation
        self.last_pose={'x':p.position.x,'y':p.position.y,'theta':math.atan2(2*q.w*q.z,1-2*q.z*q.z),'age_ms':0}
        self.pose_seen=time.monotonic();self.odom_at_pose=list(odom)
    def graph_update(self,msg):
        self.graph_nodes=[{'id':m.id,'x':m.pose.position.x,'y':m.pose.position.y} for m in msg.markers if m.ns=='slam_toolbox' and m.action==0]
        self.graph_edges=sum(len(m.points)//2 for m in msg.markers if m.ns=='slam_toolbox_edges' and m.id==0)
    def pose(self):
        self.pose_error=None
        if self.engine_enabled:
            location=self.engine_location or {}
            if time.monotonic()-self.engine_location_seen>1 or location.get('map_id')!=self.map_id or location.get('state')!='located' or not location.get('pose'):
                self.pose_error=location.get('message','Waiting for engine position');return None
            at=self.node.scan_geometry.at(location.get('source_stamp',float('nan')))
            if at is None:self.pose_error='Waiting for engine pose odometry';return None
            return dict(advance_pose(location['pose'],at,self.node.odom),age_ms=location.get('age_ms',0))
        if not self.pose_seen:self.pose_error='Waiting for first matched scan';return None
        prior=getattr(self,'odom_at_pose',None)
        if prior:
            odom=self.node.odom
            distance=math.hypot(odom[0]-prior[0],odom[1]-prior[1])
            angle=abs(math.atan2(math.sin(odom[2]-prior[2]),math.cos(odom[2]-prior[2])))
            if distance>.25 or angle>.5:
                self.pose_error='SLAM stopped matching motion (%.0f mm / %.0f degrees)'%(distance*1000,math.degrees(angle));return None
        if self.last_pose and prior:
            return dict(advance_pose(self.last_pose,prior,self.node.odom),age_ms=max(0,int((time.monotonic()-self.pose_seen)*1000)))
        return None
    def builder_agrees(self,pose,odom):
        if not self.last_pose or not getattr(self,'odom_at_pose',None):return False
        builder=advance_pose(self.last_pose,self.odom_at_pose,odom)
        return math.hypot(builder['x']-pose['x'],builder['y']-pose['y'])<.2 and abs(math.atan2(math.sin(builder['theta']-pose['theta']),math.cos(builder['theta']-pose['theta'])))<.2
    def status(self):
        return {'backend':'slam_toolbox','map_id':self.map_id,'capture':self.capture,'graph_nodes':len(self.graph_nodes),'graph_edges':self.graph_edges,'graph':self.graph_nodes,'boot_id':self.boot_id,'pose':self.pose(),'location':self.location,'tracking_error':self.pose_error,'tracking_evidence':self.tracking_evidence,'map_updates_held':self.quality_hold,'matched_pose':self.last_pose,'matched_age_ms':int((time.monotonic()-self.pose_seen)*1000) if self.pose_seen else None}
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
        if self.quality_hold or not self.map_id or self.grid is None or self.location.get("state") in ("locating","failed"):return
        pose=self.pose() if self.engine_enabled else (self.pose() or self.last_pose)
        if pose is None:raise RuntimeError('No verified pose to save')
        directory=self.directory(self.map_id);filename='graph-'+str(time.time_ns())
        self.service(self.serialize,SerializePoseGraph.Request(filename=str(directory/filename)))
        for extension in ['.posegraph','.data']:
            if not (directory/(filename+extension)).is_file():raise RuntimeError('SLAM graph snapshot incomplete')
        structure_file=directory/(filename+'.json')
        try:
            subprocess.run(['/usr/local/bin/graph_export',str(directory/filename),str(structure_file)],check=True,timeout=5,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            exported=json.loads(structure_file.read_text())
            exported.update(map_id=self.map_id,sequence=filename)
            raw_file=directory/(filename+'.raw.json');raw_file.write_text(json.dumps(exported))
            # Inference runs in the native engine binary on HQ. Its proposal is
            # evidence for validation, not permission to replace a navigable map.
            proposal_file=directory/(filename+'.reflectance.json')
            try:
                subprocess.run(['/alfred/alfred-engine','--reflectance-rebuild',str(raw_file),str(proposal_file)],check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
                proposal=json.loads(proposal_file.read_text())
                self.node.update(reflectance_rebuild={**proposal['metrics'],'mode':'proposal','revision':filename},reflectance_error=None)
            except Exception as error:
                proposal_file.unlink(missing_ok=True)
                self.node.update(reflectance_error=str(error))
            # Preserve the corrected measured graph even if proposal generation
            # fails. A classifier failure must not discard a valid SLAM snapshot.
            exported['grid'].update(sequence=self.sequence,age_ms=0)
            self.structure={**exported,'map_id':self.map_id,'sequence':filename}
            self.node.update(structure_error=None)
        except Exception as error:
            structure_file.unlink(missing_ok=True);self.node.update(structure_error=str(error))
        manifest={'filename':filename,'pose':pose,'boot_id':self.boot_id,'grid':self.structure['grid'] if self.structure and self.structure['sequence']==filename else self.grid,'saved_at':time.time(),'reflectance_revision':self.structure.get('reflectance',{}).get('revision') if self.structure and self.structure['sequence']==filename else None}
        if self.quality_hold:return
        temp=directory/'manifest.new';temp.write_text(json.dumps(manifest));os.replace(temp,directory/'manifest.json')
        # Keep current and previous complete snapshots; clean only our own files.
        protected=(self.reference_manifest or {}).get('filename')
        for old in sorted(directory.glob('graph-*.posegraph'))[:-2]:
            if old.stem==protected:continue
            old.unlink();old.with_suffix('.data').unlink(missing_ok=True);old.with_suffix('.json').unlink(missing_ok=True);old.with_suffix('.raw.json').unlink(missing_ok=True);old.with_suffix('.reflectance.json').unlink(missing_ok=True)
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
            self.node.engine_request('/v1/mapping/reflectance/model',{'map_id':map_id,'revision':'new-map','cells':[],'blocked_bins':[]},method='PUT')
            self.engine_enabled=False
            self.reference_manifest=None;self.quality_hold=False;self.recovery_count=0
            self.capture=False;self.service(self.reset,Reset.Request(pause_new_measurements=False))
            self.grid=None;self.reflection_grid=None;self.structure=None;self.node.last_map=None;self.graph_nodes=[];self.graph_edges=0
            self.map_id=map_id;self.boot_id=body['boot_id'];self.pose_seen=0.;self.location={'state':'idle'};self.capture=True
        elif action in ('resume','locate'):
            # Carrying the robot does not advance wheel counters or change boot
            # ID, so every resume verifies the saved frame before navigation.
            self.node.reset_explorer();self.recovery_count=0
            self.begin_location(map_id,body['boot_id'],warm=True,station_prior=body.get('station_prior'),docked=body.get('docked',False),allow_motion=body.get('allow_motion',False))
        else:raise ValueError('Unknown mapping action')
        return self.status()

    def scan(self,laser,sequence,scan_pose=None,scan_odom=None):
        self.scan_seen=time.monotonic()
        self.scan_sequence=sequence
        self.scan_points=[(r*math.cos(laser.angle_min+i*laser.angle_increment),r*math.sin(laser.angle_min+i*laser.angle_increment)) for i,r in enumerate(laser.ranges) if math.isfinite(r) and laser.range_min<r<laser.range_max]
        if scan_odom is None:return
        stamp=laser.header.stamp.sec*10**9+laser.header.stamp.nanosec
        self.scan_odometry[stamp]=tuple(scan_odom)
        while len(self.scan_odometry)>150:self.scan_odometry.popitem(last=False)
        self.scan_snapshot=(self.scan_points,tuple(scan_odom))
        if self.locating:return
        elif self.capture:
            if self.reference_manifest and self.location.get('state')=='located':
                if self.engine_enabled and self.pose() is None:
                    self.capture=False;self.quality_hold=True;self.locating=True
                    self.location={'state':'locating','message':'Engine is recovering position','source':'engine'}
                    threading.Thread(target=self.recover_tracking,args=(self.location_token,),daemon=True).start()
                    return
                if scan_pose is None and self.last_pose is not None and getattr(self,'odom_at_pose',None) is not None:
                    # TF/display validity cannot gate the scans needed to recover
                    # TF itself. A wheel-projected pose is only an admission
                    # hypothesis; the independent native map check still applies.
                    scan_pose=advance_pose(self.last_pose,self.odom_at_pose,scan_odom)
                if scan_pose is None:
                    self.capture=False;self.quality_hold=True;self.locating=True
                    self.location={'state':'locating','message':'Recovering the map position','recovery':True}
                    threading.Thread(target=self.recover_tracking,args=(self.location_token,),daemon=True).start()
                    return
                evidence=self.map_evidence(self.map_id,scan_pose,self.scan_points)
                self.tracking_evidence=evidence
                if evidence['tracking_lost'] or (self.engine_enabled and not self.builder_agrees(scan_pose,scan_odom)):
                    # Stop insertion immediately. Recovery loads the protected
                    # graph, never the graph containing these suspect scans.
                    self.capture=False;self.quality_hold=True;self.locating=True
                    self.grid=self.reference_manifest['grid'];self.structure=None
                    self.location={'state':'locating','message':'Tracking diverged; recovering against the saved map','recovery':True}
                    threading.Thread(target=self.recover_tracking,args=(self.location_token,),daemon=True).start()
                    return
            self.node.scan_pub.publish(laser)
    def recover_tracking(self,token):
        try:
            if token!=self.location_token:return
            self.node.control('pause',{})
            self.node.engine_request('/v1/drive/stop',method='POST')
            if token!=self.location_token:return
            self.recovery_count+=1
            self.begin_location(self.map_id,self.boot_id,warm=False,allow_motion=False,reference=self.reference_manifest)
        except Exception as error:
            self.capture=False;self.locating=False;self.location={'state':'failed','message':str(error),'recovery':True}

    def map_evidence(self,map_id,pose,points):
        body={'map_id':map_id,'pose':pose,'points':points}
        try:return self.node.engine_request('/v1/mapping/evidence',body)
        except Exception as error:
            if 'reference not installed' not in str(error).lower():raise
            manifest=self.reference_manifest
            self.node.engine_request('/v1/mapping/reference',{'map_id':map_id,'revision':manifest['filename'],'grid':manifest['grid']},method='PUT')
            return self.node.engine_request('/v1/mapping/evidence',body)
    def begin_location(self,map_id,boot_id,warm=False,station_prior=None,docked=False,allow_motion=False,reference=None):
        manifest=dict(reference) if reference else json.loads((self.directory(map_id)/'manifest.json').read_text())
        self.capture=False;self.locating=True;self.quality_hold=True;self.location_token+=1;token=self.location_token
        self.map_id=map_id;self.boot_id=boot_id;self.engine_enabled=True
        self.reference_manifest=manifest
        self.location={'state':'locating','message':'Engine is finding Alfred in the saved map','source':'engine'}
        self.node.engine_request('/v1/mapping/reference',{'map_id':map_id,'revision':manifest['filename'],'grid':manifest['grid']},method='PUT')
        self.node.engine_request('/v1/localization/map',{'map_id':map_id,'revision':manifest['filename'],'grid':manifest['grid']},method='PUT')
        # The engine keeps tracking through HQ pauses. Do not reset an already
        # verified estimate merely because the user resumes recording.
        self.grid=manifest['grid'];self.publish_navigation_grid(self.grid)
        threading.Thread(target=self.finish_engine_location,args=(token,map_id,boot_id,manifest),daemon=True).start()

    def localization_pose(self,msg):
        # AMCL is not a position authority. Kept inert for old ROS publishers.
        return

    def finish_engine_location(self,token,map_id,boot_id,manifest):
        try:
            while token==self.location_token:
                location=self.node.engine_request('/v1/localization',method='GET')
                self.engine_location=location;self.engine_location_seen=time.monotonic()
                self.location.update(message=location['message'],score=location.get('score'),hypotheses=location.get('hypotheses',[]))
                if location.get('map_id')==map_id and location['state']=='located' and location.get('pose'):break
                time.sleep(.2)
            if token!=self.location_token:return
            p=dict(location['pose'],odom=tuple(self.node.odom))
            request=DeserializePoseGraph.Request(filename=str(self.directory(map_id)/manifest['filename']),match_type=2,initial_pose=Pose2D(x=p['x'],y=p['y'],theta=p['theta']))
            started=time.monotonic()
            with self.save_lock:
                if token!=self.location_token:return
                self.service(self.deserialize,request)
                if token!=self.location_token:return
                self.locating=False;self.capture=True;self.node.last_map=self.grid['sequence']
            # Graph builder must agree before map writes resume. Engine position
            # remains usable independently of the builder and its lifecycle.
            agrees=False
            while token==self.location_token and time.monotonic()-started<5:
                if self.pose_seen>=started and self.last_pose:
                    expected=advance_pose(p,p['odom'],self.odom_at_pose)
                    agrees=math.hypot(self.last_pose['x']-expected['x'],self.last_pose['y']-expected['y'])<.2 and abs(math.atan2(math.sin(self.last_pose['theta']-expected['theta']),math.cos(self.last_pose['theta']-expected['theta'])))<.2
                    if agrees:break
                time.sleep(.1)
            if token!=self.location_token:return
            if not agrees:raise RuntimeError('Map builder disagrees with engine position; map updates held')
            self.quality_hold=False;self.location={'state':'located','message':'Position tracked by engine','score':location['score'],'source':'engine'}
        except Exception as error:
            if token==self.location_token:self.capture=False;self.locating=False;self.quality_hold=True;self.location={'state':'failed','message':str(error),'source':'engine'}
