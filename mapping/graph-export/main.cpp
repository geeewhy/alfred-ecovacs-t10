// Export corrected graph observations through Karto's public serialization API.
// Geometry stays in the SLAM map frame; never reconstruct it from HQ history.
#include <karto_sdk/Mapper.h>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>

int main(int argc,char **argv) {
  if(argc!=3){std::cerr<<"usage: graph_export GRAPH_PREFIX OUTPUT_JSON\n";return 2;}
  try {
    karto::Mapper mapper;
    karto::Dataset dataset;
    mapper.LoadFromFile(std::string(argv[1])+".posegraph");
    dataset.LoadFromFile(std::string(argv[1])+".data");
    for(auto *object:dataset.GetLasers()) {
      if(auto *sensor=dynamic_cast<karto::Sensor *>(object))karto::SensorManager::GetInstance()->RegisterSensor(sensor,true);
    }
    std::ofstream out(argv[2]);
    if(!out)throw std::runtime_error("Cannot open graph export");
    out<<std::setprecision(9)<<"{\"keyframes\":[";
    bool first=true;
    const auto scans=mapper.GetAllProcessedScans();
    const size_t stride=std::max<size_t>(1,(scans.size()+1499)/1500);
    for(size_t i=0;i<scans.size();i+=stride) {
      auto *scan=scans[i];const auto pose=scan->GetCorrectedPose();
      // Force cached range points to use the serialized corrected pose.
      scan->SetCorrectedPose(pose);
      if(!first)out<<",";first=false;
      out<<"{\"id\":"<<scan->GetUniqueId()<<",\"stamp\":"<<scan->GetTime()
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
