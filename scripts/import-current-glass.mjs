// Reproducible local port of the approved renderer. No install or model conversion.
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
const source=process.argv[2];
if(!source)throw new Error('Provide the existing Playground directory');
const require=createRequire(path.join(source,'package.json'));
const ts=require('typescript');
const output=new URL('../assets/current-glass/',import.meta.url);
await fs.mkdir(output,{recursive:true});
for(const name of ['coreScene','opalInterior','moltenInterior','contourLighting']){
 let input=await fs.readFile(path.join(source,'src/components/goldenCore',name+'.ts'),'utf8');
 input=input.replaceAll('from "three"','from "../vendor/three.module.min.js"')
  .replaceAll('from "three/addons/loaders/GLTFLoader.js"','from "../vendor/loaders/GLTFLoader.js"')
  .replace(/from "\.\/(opalInterior|moltenInterior|contourLighting)"/g,'from "./$1.js"')
  .replace('loader.load("/glb/nova.glb"','loader.load("/assets/current-glass/nova.glb"');
 const result=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});
 await fs.writeFile(new URL(name+'.js',output),result.outputText);
}
await fs.copyFile(path.join(source,'public/glb/nova.glb'),new URL('nova.glb',output));
console.log('Copied approved Current Glass renderer and unchanged GLB.');
