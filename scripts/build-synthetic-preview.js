import {mkdir,copyFile,cp,access} from 'node:fs/promises';
import {syntheticPreviewEnvironment} from '../src/identity/synthetic-preview.js';
const config=syntheticPreviewEnvironment(process.env);
if(!config.synthetic)throw new Error('This branch builds only the isolated synthetic Preview.');
await mkdir('preview-public',{recursive:true});
for(const file of ['index.html','signin.html','manifest.webmanifest'])await copyFile(file,`preview-public/${file}`);
await cp('assets','preview-public/assets',{recursive:true});
// Source, tests, reports, local evidence, auth files and environment files are
// deliberately absent from the static output directory.
console.log('Synthetic Preview static shell built; no database initialization performed.');
