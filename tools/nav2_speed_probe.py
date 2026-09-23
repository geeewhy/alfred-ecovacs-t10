"""Read DWB candidate scores for five seconds; never sends motion commands.
Run: docker exec -i alfred-mapping bash -c '. /opt/ros/jazzy/setup.bash; python3 -' < tools/nav2_speed_probe.py
"""
import json,time,collections
import rclpy
from dwb_msgs.msg import LocalPlanEvaluation
rclpy.init();node=rclpy.create_node('alfred_speed_probe');samples=[]
def receive(msg):
    if not msg.twists:return
    best=msg.twists[msg.best_index]
    feasible=[t for t in msg.twists if t.total>=0]
    fastest=max(feasible,key=lambda t:t.traj.velocity.x) if feasible else best
    def describe(t):return {'speed_mm_s':round(t.traj.velocity.x*1000,1),'yaw':round(t.traj.velocity.theta,2),'total':round(t.total,2),'critics':{s.name:round(s.raw_score*s.scale,2) for s in t.scores}}
    samples.append({'best':describe(best),'fastest':describe(fastest),'feasible':len(feasible)})
node.create_subscription(LocalPlanEvaluation,'evaluation',receive,10)
start=time.monotonic()
while time.monotonic()-start<5:rclpy.spin_once(node,timeout_sec=.1)
print(json.dumps({'samples':len(samples),'speed_counts':dict(collections.Counter(s['best']['speed_mm_s'] for s in samples)),'comparisons':samples[::max(1,len(samples)//4)][:4]}))
rclpy.shutdown()
