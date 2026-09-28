import unittest
import numpy as np
from refinement import observation_goal, frontier_regions

class ObservationGoals(unittest.TestCase):
    def test_viewpoint_stays_in_robot_component_and_moves(self):
        grid=np.full((100,100),-1)
        grid[10:40,10:40]=0
        grid[60:90,60:90]=0
        grid[25:40,38:40]=100
        pose={'x':1.2,'y':1.2,'theta':0.}
        goal=observation_goal(grid,.05,(0.,0.),pose,[])
        self.assertIsNotNone(goal)
        self.assertLess(goal['x'],2.)
        self.assertLess(goal['y'],2.)
        self.assertGreater(np.hypot(goal['x']-1.2,goal['y']-1.2),.45)
        again=observation_goal(grid,.05,(0.,0.),pose,[(goal['x'],goal['y'])])
        if again:self.assertGreater(np.hypot(again['x']-goal['x'],again['y']-goal['y']),.65)
    def test_marker_is_on_the_disconnected_boundary_in_world_coordinates(self):
        grid=np.full((100,100),-1)
        grid[10:30,10:30]=0;grid[60:80,60:80]=0
        origin=(-2.,-3.);resolution=.05
        result=frontier_regions(grid,resolution,origin,{'x':-1.,'y':-2.})
        self.assertEqual(result['disconnected'],1)
        self.assertEqual(result['reachable'],1)
        point=result['markers'][0]
        x=int((point['x']-origin[0])/resolution);y=int((point['y']-origin[1])/resolution)
        self.assertEqual(grid[y,x],-1)
        self.assertTrue(any(grid[y+dy,x+dx]==0 for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]))
        self.assertGreater(x,50)
    def test_unvisited_island_is_excluded_but_visited_room_is_retained(self):
        grid=np.full((100,100),-1);grid[10:30,10:30]=0;grid[60:80,60:80]=0
        pose={'x':1.,'y':1.}
        result=frontier_regions(grid,.05,(0.,0.),pose,[])
        self.assertEqual(result['disconnected'],0)
        self.assertEqual(result['outside_observed'],1)
        result=frontier_regions(grid,.05,(0.,0.),pose,[{'x':3.5,'y':3.5}])
        self.assertEqual(result['disconnected'],1)
    def test_occupied_robot_position_has_no_inspection_route(self):
        self.assertIsNone(observation_goal(np.full((20,20),100),.05,(0.,0.),{'x':.5,'y':.5},[]))
if __name__=='__main__':unittest.main()
