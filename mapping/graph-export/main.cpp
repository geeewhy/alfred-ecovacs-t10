// Export corrected graph observations through Karto's public serialization API.
// Geometry stays in the SLAM map frame; never reconstruct it from HQ history.
#include <karto_sdk/Mapper.h>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>

// Offline trimming changes only the serialized graph; no optimizer or robot.
class ArchiveSolver final : public karto::ScanSolver {
  IdPoseVector poses;
 public:
  void Compute() override {}
  void Configure(rclcpp_lifecycle::LifecycleNode::SharedPtr) override {}
  const IdPoseVector &GetCorrections() const override {return poses;}
};

int main(int argc,char **argv) {
  if(argc!=3 && argc!=5){std::cerr<<"usage: graph_export GRAPH_PREFIX OUTPUT_JSON [KEEP_MAX_ID NEW_GRAPH_PREFIX]\n";return 2;}
  try {
    karto::Mapper mapper;
    karto::Dataset dataset;
    mapper.LoadFromFile(std::string(argv[1])+".posegraph");
    dataset.LoadFromFile(std::string(argv[1])+".data");
    for(auto *object:dataset.GetLasers()) {
      if(auto *sensor=dynamic_cast<karto::Sensor *>(object))karto::SensorManager::GetInstance()->RegisterSensor(sensor,true);
    }
    ArchiveSolver archiveSolver;
    if(argc==5) {
      if(std::string(argv[1])==argv[4])throw std::runtime_error("Recovery output must be a new graph");
      const auto maxId=std::stoul(argv[3]);
      mapper.SetScanSolver(&archiveSolver);
      const auto vertices=mapper.GetGraph()->GetVertices();
      for(const auto &sensor:vertices)for(auto it=sensor.second.rbegin();it!=sensor.second.rend();++it) {
        auto *vertex=it->second;auto *scan=vertex->GetObject();
        if(scan->GetUniqueId()>maxId) {
          if(!mapper.RemoveNodeFromGraph(vertex))throw std::runtime_error("Cannot remove graph vertex");
          mapper.GetMapperSensorManager()->RemoveScan(scan);
        }
      }
      auto *manager=mapper.GetMapperSensorManager();
      for(const auto &name:manager->GetSensorNames()) {
        manager->ClearRunningScans(name);manager->ClearLastScan(name);
      }
      const auto kept=mapper.GetAllProcessedScans();
      if(kept.empty())throw std::runtime_error("Recovery would empty graph");
      for(auto *scan:kept)manager->SetLastScan(scan);
      mapper.SaveToFile(std::string(argv[4])+".posegraph");
      dataset.SaveToFile(std::string(argv[4])+".data");
    }
    std::ofstream out(argv[2]);
    if(!out)throw std::runtime_error("Cannot open graph export");
    out<<std::setprecision(17)<<"{\"keyframes\":[";
    bool first=true;
    const auto scans=mapper.GetAllProcessedScans();
    const size_t stride=std::max<size_t>(1,(scans.size()+1499)/1500);
    for(size_t i=0;i<scans.size();i+=stride) {
      auto *scan=scans[i];const auto pose=scan->GetCorrectedPose();const auto odom=scan->GetOdometricPose();
      // Force cached range points to use the serialized corrected pose.
      scan->SetCorrectedPose(pose);
      if(!first)out<<",";first=false;
      out<<"{\"id\":"<<scan->GetUniqueId()<<",\"stamp\":"<<scan->GetTime()
         <<",\"odom\":{\"x\":"<<odom.GetX()<<",\"y\":"<<odom.GetY()<<",\"theta\":"<<odom.GetHeading()<<"}"
         <<",\"pose\":{\"x\":"<<pose.GetX()<<",\"y\":"<<pose.GetY()<<",\"theta\":"<<pose.GetHeading()<<"},\"points\":[";
      bool firstPoint=true;
      for(const auto &point:scan->GetPointReadings(true)) {
        if(!std::isfinite(point.GetX())||!std::isfinite(point.GetY()))continue;
        if(!firstPoint)out<<",";firstPoint=false;
        out<<"["<<point.GetX()<<","<<point.GetY()<<"]";
      }
      out<<"]}";
    }
    out<<"],\"edges\":[";first=true;
    for(const auto *edge:mapper.GetGraph()->GetEdges()) {
      if(!first)out<<",";first=false;
      out<<"["<<edge->GetSource()->GetObject()->GetUniqueId()<<","<<edge->GetTarget()->GetObject()->GetUniqueId()<<"]";
    }
    out<<"],\"grid\":{";
    std::unique_ptr<karto::OccupancyGrid> grid(karto::OccupancyGrid::CreateFromScans(scans,.05,mapper.getParamMinPassThrough(),mapper.getParamOccupancyThreshold()));
    if(!grid)throw std::runtime_error("Graph has no occupancy");
    const auto offset=grid->GetCoordinateConverter()->GetOffset();
    out<<"\"resolution\":0.05,\"width\":"<<grid->GetWidth()<<",\"height\":"<<grid->GetHeight()<<",\"origin\":["<<offset.GetX()<<","<<offset.GetY()<<"],\"cells\":[";
    first=true;
    for(int y=0;y<grid->GetHeight();y++)for(int x=0;x<grid->GetWidth();x++){
      const auto value=grid->GetValue(karto::Vector2<kt_int32s>(x,y));
      if(value==karto::GridStates_Unknown)continue;
      if(!first)out<<",";first=false;
      out<<"["<<x<<","<<y<<","<<(value==karto::GridStates_Occupied?129:127)<<"]";
    }
    out<<"]}}";out.close();
    if(!out)throw std::runtime_error("Graph export write failed");
  }catch(const karto::Exception &error){std::cerr<<error.GetErrorMessage()<<"\n";return 1;}
  catch(const std::exception &error){std::cerr<<error.what()<<"\n";return 1;}
}
