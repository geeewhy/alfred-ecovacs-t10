FROM ros:jazzy-ros-base@sha256:c3706ef0a0aa45413c07803cf433602f543b22e45b4855f6fca955c2d8ecc4e8
RUN apt-get update && apt-get install -y --no-install-recommends \
    ros-jazzy-nav2-planner ros-jazzy-nav2-controller ros-jazzy-nav2-bt-navigator \
    ros-jazzy-nav2-behaviors ros-jazzy-nav2-lifecycle-manager ros-jazzy-nav2-map-server \
    ros-jazzy-nav2-amcl ros-jazzy-nav2-navfn-planner \
    ros-jazzy-nav2-regulated-pure-pursuit-controller ros-jazzy-nav2-mppi-controller python3-numpy python3-scipy python3-yaml \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /alfred
RUN apt-get update && apt-get install -y --no-install-recommends ros-jazzy-dwb-core ros-jazzy-dwb-plugins ros-jazzy-dwb-critics && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends ros-jazzy-slam-toolbox && rm -rf /var/lib/apt/lists/*
COPY vendor /alfred/vendor
RUN . /opt/ros/jazzy/setup.sh && colcon build --base-paths vendor/m-explore-ros2/explore vendor/m-explore-ros2/explore_lite_msgs --cmake-args -DBUILD_TESTING=OFF

COPY graph-export /alfred/graph-export
RUN . /opt/ros/jazzy/setup.sh && cmake -S graph-export -B /tmp/graph-build -DCMAKE_BUILD_TYPE=Release && cmake --build /tmp/graph-build -j2 && cmake --install /tmp/graph-build
COPY . /alfred
