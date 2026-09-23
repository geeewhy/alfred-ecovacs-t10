"""Read-only full navigation costmap snapshot, for route/clearance diagnosis."""
import json,time
import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.qos import QoSProfile,DurabilityPolicy
rclpy.init();node=rclpy.create_node('alfred_costmap_snapshot');maps={}
for topic in ['global_costmap/costmap','local_costmap/costmap']:
    node.create_subscription(OccupancyGrid,topic,lambda m,t=topic:maps.update({t:m}),QoSProfile(depth=1,durability=DurabilityPolicy.TRANSIENT_LOCAL))
start=time.monotonic()
while time.monotonic()-start<2:rclpy.spin_once(node,timeout_sec=.1)
print(json.dumps({t:{'width':m.info.width,'height':m.info.height,'resolution':m.info.resolution,'origin':[m.info.origin.position.x,m.info.origin.position.y],'cells':list(m.data)} for t,m in maps.items()}))
rclpy.shutdown()
