import unittest
import numpy as np
from refinement import observation_goal

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
    def test_occupied_robot_position_has_no_inspection_route(self):
        self.assertIsNone(observation_goal(np.full((20,20),100),.05,(0.,0.),{'x':.5,'y':.5},[]))
if __name__=='__main__':unittest.main()
