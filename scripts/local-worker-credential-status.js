import {createWindowsCredentialStore,createLocalWorkerCredentialManager} from "../src/autonomy/local-worker-credentials.js";
const manager=createLocalWorkerCredentialManager({store:createWindowsCredentialStore()});
console.log(JSON.stringify(await manager.status()));
