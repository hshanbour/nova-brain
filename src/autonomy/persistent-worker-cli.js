const value=(argv,name)=>{const index=argv.indexOf(name);return index>=0?argv[index+1]||"":"";};
export function parsePersistentWorkerArguments(argv=process.argv){return Object.freeze({previewUrl:value(argv,"--preview-url"),gitExecutable:value(argv,"--git-executable"),credentialHelper:value(argv,"--credential-helper"),probeOnly:argv.includes("--probe-only")});}
