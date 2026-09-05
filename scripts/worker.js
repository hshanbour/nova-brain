import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {createApp} from "../src/app.js";

const interval=Math.max(1000,Math.min(60000,Number(process.env.NOVA_WORKER_POLL_MS)||5000));
const app=createApp({environment:process.env});await app.initialize();
let stopping=false;process.on("SIGINT",()=>{stopping=true;});process.on("SIGTERM",()=>{stopping=true;});
while(!stopping){try{await app.workerRuntime.tick({idempotencyKey:randomUUID()});}catch(error){console.error("Nova worker iteration failed safely.",{code:error.code||"unexpected_error"});}if(!stopping)await delay(interval);}
