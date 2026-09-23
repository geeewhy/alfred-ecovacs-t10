"""Independently count reachable unknown boundaries in the live frontier map.
Run inside mapping container via stdin, like nav2_speed_probe.py.
"""
import json,time,math,collections
import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.qos import QoSProfile,DurabilityPolicy
from tf2_ros import Buffer,TransformListener
rclpy.init();node=rclpy.create_node('alfred_frontier_probe');maps=[];buffer=Buffer();listener=TransformListener(buffer,node)
node.create_subscription(OccupancyGrid,'frontier_map',lambda m:maps.append(m),QoSProfile(depth=1,durability=DurabilityPolicy.TRANSIENT_LOCAL))
start=time.monotonic()
while time.monotonic()-start<3:rclpy.spin_once(node,timeout_sec=.1)
if not maps:raise RuntimeError('No frontier map received')
m=maps[-1];w,h=m.info.width,m.info.height;p=buffer.lookup_transform(m.header.frame_id,'base_link',rclpy.time.Time()).transform.translation
x=int((p.x-m.info.origin.position.x)/m.info.resolution);y=int((p.y-m.info.origin.position.y)/m.info.resolution);seed=y*w+x
if not(0<=x<w and 0<=y<h) or m.data[seed]!=0:raise RuntimeError('Robot is not in a traversable cell; cannot assert completion')
def neighbors(i,diagonal=False):
 x,y=i%w,i//w
 for dx,dy in ([(-1,0),(1,0),(0,-1),(0,1)]+([(-1,-1),(-1,1),(1,-1),(1,1)] if diagonal else [])):
  if 0<=x+dx<w and 0<=y+dy<h:yield (y+dy)*w+x+dx
seen={seed};queue=collections.deque([seed]);boundary=set()
while queue:
 i=queue.popleft()
 for v in neighbors(i):
  if m.data[v]<0:boundary.add(v)
  elif m.data[v]==0 and v not in seen:seen.add(v);queue.append(v)
sizes=[]
while boundary:
 i=boundary.pop();queue=collections.deque([i]);size=0
 while queue:
  i=queue.popleft();size+=1
  for v in neighbors(i,True):
   if v in boundary:boundary.remove(v);queue.append(v)
 sizes.append(size)
import numpy as np
from scipy.ndimage import label,binary_dilation
array=np.array(m.data).reshape(h,w)
labels,count=label(array==0)
component_areas=sorted((np.bincount(labels.ravel())[1:]*m.info.resolution**2).tolist(),reverse=True)
all_boundary=(array<0)&binary_dilation(array==0)
all_labels,all_count=label(all_boundary,structure=np.ones((3,3)))
all_sizes=np.bincount(all_labels.ravel())[1:]
print(json.dumps({'all_free_components_m2':[round(v,2) for v in component_areas if v>.1],'all_frontiers_over_35cm':int(sum(all_sizes*m.info.resolution>=.35)),'map_size':[w,h],'resolution':m.info.resolution,'reachable_free_m2':round(len(seen)*m.info.resolution**2,2),'frontier_components_cells':sorted(sizes,reverse=True),'frontiers_over_35cm':sum(n*m.info.resolution>=.35 for n in sizes)}))
rclpy.shutdown()
