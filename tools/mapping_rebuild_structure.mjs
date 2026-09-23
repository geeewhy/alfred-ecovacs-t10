#!/usr/bin/env node
// Rebuild presentation walls from the saved corrected graph, keeping edits/maps.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {MapService} from '../hq/src/maps/map-service.mjs';
import {GraphScanner} from '../hq/src/maps/native-scanner.mjs';
import {structuralPlan} from '../hq/src/maps/walls.mjs';
const id=process.argv[2],service=new MapService({});
const state=await fetch('http://127.0.0.1:4173/api/maps/active',{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
if(JSON.stringify(state).includes('"state":"scanning"'))throw Error('Pause capture before rebuilding saved structure.');
const map=await service.load(id),directory=new URL(`../mapping/state/maps/${id}/`,import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
const graph=JSON.parse(await readFile(new URL(manifest.filename+'.json',directory),'utf8'));
const scanner=new GraphScanner();scanner.acceptStructure({...graph,sequence:manifest.filename});
const snapshot=scanner.structuralSnapshot,before=map.structure?.walls.length||0;
await mkdir(new URL('../artifacts/hq/map-backups/',import.meta.url),{recursive:true});
await writeFile(new URL(`../artifacts/hq/map-backups/${id}-${Date.now()}.json`,import.meta.url),JSON.stringify(map));
map.structure=structuralPlan(snapshot.cells,{...map.structure,sequence:null},snapshot.sequence,snapshot.keyframes);
await service.save(map);
console.log(JSON.stringify({id,name:map.name,before,after:map.structure.walls.length,keyframes:graph.keyframes.length}));
