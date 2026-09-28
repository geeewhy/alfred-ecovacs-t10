import yaml,json,os
p=yaml.safe_load(open('/alfred/nav2-upstream.yaml'));amcl=p['amcl']
keep=['controller_server','local_costmap','global_costmap','planner_server','bt_navigator']
p={k:v for k,v in p.items() if k in keep}
b=p['bt_navigator']['ros__parameters'];b['navigators']=['navigate_to_pose'];b['default_nav_to_pose_bt_xml']='/alfred/navigation.xml'
c=p['controller_server']['ros__parameters'];c['controller_frequency']=10.;c['progress_checker'].update(required_movement_radius=.08,movement_time_allowance=10.);c['general_goal_checker'].update(xy_goal_tolerance=.15,yaw_goal_tolerance=3.14)
c['FollowPath']={
 'plugin':'dwb_core::DWBLocalPlanner',
 'min_vel_x':0.,'min_vel_y':0.,'max_vel_x':.12,'max_vel_y':0.,'max_vel_theta':.5,
 'min_speed_xy':0.,'max_speed_xy':.12,'min_speed_theta':0.,
 'acc_lim_x':.2,'acc_lim_y':0.,'acc_lim_theta':.8,'decel_lim_x':-.3,'decel_lim_y':0.,'decel_lim_theta':-.8,
 'vx_samples':10,'vy_samples':1,'vtheta_samples':24,'sim_time':3.,'linear_granularity':.02,'angular_granularity':.03,
 'transform_tolerance':.3,'xy_goal_tolerance':.15,'trans_stopped_velocity':.01,'short_circuit_trajectory_evaluation':True,'stateful':True,
 'critics':['RotateToGoal','Oscillation','BaseObstacle','GoalAlign','PathAlign','PathDist','GoalDist'],
 'BaseObstacle.scale':.02,'PathAlign.scale':16.,'GoalAlign.scale':8.,'PathAlign.forward_point_distance':.15,'GoalAlign.forward_point_distance':.15,
 'PathDist.scale':16.,'GoalDist.scale':12.,'RotateToGoal.scale':16.,'RotateToGoal.slowing_factor':5.,'RotateToGoal.lookahead_time':-1.
}

for name in ['local_costmap','global_costmap']:
 c=p[name][name]['ros__parameters'];c['robot_radius']=.18;c['footprint_padding']=.005
 if name=='local_costmap':c['resolution']=.02;c['plugins']=(['static_layer'] if name=='global_costmap' else [])+['obstacle_layer','inflation_layer'];c['transform_tolerance']=.3
 c['static_layer']={'plugin':'nav2_costmap_2d::StaticLayer','map_subscribe_transient_local':True,'map_topic':'/navigation_map'}
 c['obstacle_layer']={'plugin':'nav2_costmap_2d::ObstacleLayer','enabled':True,'combination_method':0,'footprint_clearing_enabled':True,'observation_sources':'scan contacts','contacts':{'topic':'/bumper_contacts','data_type':'PointCloud2','marking':True,'clearing':False,'observation_persistence':30.,'max_obstacle_height':1.},'scan':{'topic':'/obstacle_scan','max_obstacle_height':2.,'clearing':True,'marking':True,'data_type':'LaserScan','raytrace_max_range':8.,'raytrace_min_range':.06,'obstacle_max_range':5.,'obstacle_min_range':.195}}
 c['inflation_layer']={'plugin':'nav2_costmap_2d::InflationLayer','cost_scaling_factor':5.,'inflation_radius':.28}
p['planner_server']['ros__parameters']['GridBased'].update(tolerance=.3,use_astar=True,allow_unknown=False)
p['lifecycle_manager_navigation']={'ros__parameters':{'autostart':False,'node_names':['controller_server','planner_server','bt_navigator'],'bond_timeout':3.}}
if os.path.exists('/alfred/state/settings.json'):
 settings=json.load(open('/alfred/state/settings.json'));p['controller_server']['ros__parameters']['FollowPath'].update(max_vel_x=settings['cruise_mm_s']/1000,max_speed_xy=settings['cruise_mm_s']/1000)
amcl['ros__parameters'].update(base_frame_id='base_link',tf_broadcast=False,scan_topic='localization_scan',max_particles=5000,min_particles=1000,max_beams=120,update_min_d=0.,update_min_a=0.,laser_max_range=12.,laser_min_range=.195,sigma_hit=.1,pf_err=.01)
p['alfred_localizer']=amcl
p['alfred_localization_lifecycle']={'ros__parameters':{'autostart':True,'node_names':['alfred_localizer'],'bond_timeout':3.}}
yaml.safe_dump(p,open('/tmp/alfred-nav2.yaml','w'))

slam=yaml.safe_load(open('/alfred/slam-upstream.yaml'))
slam['slam_toolbox']['ros__parameters'].update(base_frame='base_link',transform_publish_period=0.,map_update_interval=1.,minimum_time_interval=.15,minimum_travel_distance=.1,minimum_travel_heading=.15,scan_buffer_size=30,loop_match_minimum_chain_size=10,max_laser_range=12.,min_laser_range=.195,transform_timeout=.3,enable_interactive_mode=False,check_min_dist_and_heading_precisely=True,restamp_tf=True,correlation_search_space_dimension=.2,coarse_search_angle_offset=.15,use_response_expansion=False)
yaml.safe_dump(slam,open('/tmp/alfred-slam.yaml','w'))
