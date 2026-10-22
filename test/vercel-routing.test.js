import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("Vercel routes the exact root Meta callback before static assets",async()=>{
  const config=JSON.parse(await readFile(new URL("../vercel.json",import.meta.url),"utf8"));
  assert.deepEqual(config.routes[0],{
    src:"/",
    has:[{type:"query",key:"meta_oauth_callback",value:"1"}],
    dest:"/api/index",
  });
  assert.deepEqual(config.routes[1],{handle:"filesystem"});
  assert.deepEqual(config.routes[2],{src:"/(.*)",dest:"/api/index"});
  assert.equal(config.rewrites,undefined);
});
