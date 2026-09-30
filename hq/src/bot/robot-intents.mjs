export class RobotIntents {
  constructor(maps,engine,status,stop){Object.assign(this,{maps,engine,status,stop});}
  async context(){
    const [catalog,robot]=await Promise.all([this.maps.sectionCatalog(),this.status.current()]);
    return {sections:catalog.filter(m=>m.sections.length).map(m=>({mapId:m.mapId,mapName:m.mapName,sections:m.sections.map(s=>({name:s.name,aliases:s.aliases}))})),robot};
  }
  async execute(intent,active=()=>true){
    const check=()=>{if(!active())throw Error('Command cancelled.');};
    check();
    if(intent.action==='none'||intent.action==='status')return {state:'answered'};
    if(intent.action==='stop'){await this.stop();return {state:'stopped'};}
    if(intent.action==='navigate'){
      const resolved=await this.maps.resolveSection(intent.section,intent.mapId||undefined);
      if(resolved.status!=='resolved')throw Error(resolved.status==='ambiguous'?'Which map do you mean?':'That section could not be resolved.');
      if(!resolved.section.target)throw Error('That section has no navigable destination.');
      check();
      const result=await this.maps.navigateTo(resolved.section.mapId,resolved.section.target);
      if(!active()){await this.stop();throw Error('Command cancelled.');}
      if(!result.active&&result.state!=='arrived')throw Error(result.message||'Navigation did not start.');
      return {state:result.state,active:result.active,message:result.message};
    }
    if(intent.action==='return'){
      let id=intent.mapId;
      const maps=await this.maps.list();
      if(!id){
        const current=await this.engine.onboardReturn();
        id=current.map_id;
        if(!id){const primary=maps.filter(m=>m.name.toLowerCase()==='primary');if(primary.length===1)id=primary[0].id;}
      }
      if(!id||!maps.some(m=>m.id===id))throw Error('Which map should I return on?');
      check();
      const result=await this.maps.returnOnboard(id);
      if(!active()){await this.stop();throw Error('Command cancelled.');}
      if(!result.active&&!['charged','charging','docked','complete'].includes(result.state))throw Error(result.message||'Return did not start.');
      return {state:result.state,active:result.active,message:result.message};
    }
    throw Error('Unsupported robot action.');
  }
}
