import {mkdir,copyFile,cp,access} from 'node:fs/promises';
import {continuityPreviewEnvironment} from '../src/identity/continuity-preview.js';
import {syntheticPreviewEnvironment} from '../src/identity/synthetic-preview.js';
const continuity=continuityPreviewEnvironment(process.env);
const config=syntheticPreviewEnvironment(continuity.environment);
if(!config.synthetic&&!continuity.continuity)throw new Error('A verified Preview branch is required.');
await mkdir('preview-public',{recursive:true});
for(const file of ['index.html','signin.html','manifest.webmanifest'])await copyFile(file,`preview-public/${file}`);
await cp('assets','preview-public/assets',{recursive:true});
// Source, tests, reports, local evidence, auth files and environment files are
// deliberately absent from the static output directory.
console.log('Authenticated Preview static shell built; no database initialization performed.');
