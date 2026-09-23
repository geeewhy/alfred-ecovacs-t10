import json,math,time
import rclpy
from rclpy.qos import QoSProfile,DurabilityPolicy
from nav_msgs.msg import Path, OccupancyGrid
from geometry_msgs.msg import PolygonStamped
from tf2_ros import Buffer,TransformListener
rclpy.init();n=rclpy.create_node('alfred_costmap_probe');buffer=Buffer();listener=TransformListener(buffer,n);maps={}
for topic in ['local_costmap/costmap','global_costmap/costmap']:
 n.create_subscription(OccupancyGrid,topic,lambda msg,t=topic:maps.update({t:msg}),QoSProfile(depth=1,durability=DurabilityPolicy.TRANSIENT_LOCAL))
n.create_subscription(PolygonStamped,'local_costmap/published_footprint',lambda m:maps.update({'footprint':m}),10)
n.create_subscription(Path,'lookahead_collision_arc',lambda m:maps.update({'arc':m}),10)
start=time.monotonic()
while time.monotonic()-start<3:rclpy.spin_once(n,timeout_sec=.1)
for topic,m in maps.items():
 try:
  if topic=='footprint':
   print(json.dumps({'topic':topic,'points':[[p.x,p.y] for p in m.polygon.points]}));continue
  if topic=='arc':
   print(json.dumps({'topic':topic,'points':[[p.pose.position.x,p.pose.position.y] for p in m.poses]}));continue
  p=buffer.lookup_transform(m.header.frame_id,'base_link',rclpy.time.Time()).transform.translation
  x=int((p.x-m.info.origin.position.x)/m.info.resolution);y=int((p.y-m.info.origin.position.y)/m.info.resolution)
  rows=[[int(m.data[(y+dy)*m.info.width+x+dx]) for dx in range(-8,9)] for dy in range(8,-9,-1)]
  print(json.dumps({'topic':topic,'frame':m.header.frame_id,'robot':[p.x,p.y],'center':[x,y],'resolution':m.info.resolution,'rows':rows,'nearest_lethal':sorted([[math.hypot(m.info.origin.position.x+(i%m.info.width+.5)*m.info.resolution-p.x,m.info.origin.position.y+(i//m.info.width+.5)*m.info.resolution-p.y),m.info.origin.position.x+(i%m.info.width+.5)*m.info.resolution-p.x,m.info.origin.position.y+(i//m.info.width+.5)*m.info.resolution-p.y] for i,v in enumerate(m.data) if v==100])[:12]}))
 except Exception as e:print(str(e))
rclpy.shutdown()
