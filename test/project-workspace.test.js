import test from "node:test";
import assert from "node:assert/strict";
import {parseProjectRoute,platformState,projectRoute,sectionsForProject} from "../assets/project-workspace.js";

test("project workspace routes round trip safely",()=>{const route=projectRoute("sharp-cuts-web","social","instagram");assert.equal(route,"#project/sharp-cuts-web/social/instagram");assert.deepEqual(parseProjectRoute(route),{projectId:"sharp-cuts-web",view:"social",platform:"instagram"});});
test("future projects inherit the reusable core workspace",()=>{assert.deepEqual(sectionsForProject("future-project").map(item=>item.id),["overview","social","website","automations","settings"]);assert.equal(sectionsForProject("sharp-cuts-web").length,12);});
test("platform state never invents missing metrics",()=>{assert.deepEqual(platformState({instagram:{connected:true}},{instagram:{followers:10}},"instagram").metrics,[{label:"Followers",value:10},{label:"Media",value:null}]);assert.equal(platformState({},null,"tiktok").label,"Not Connected");});
