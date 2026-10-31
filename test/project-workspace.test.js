import test from "node:test";
import assert from "node:assert/strict";
import {parseProjectRoute,platformState,projectRoute,sectionsForProject} from "../assets/project-workspace.js";

test("project workspace routes round trip safely",()=>{const route=projectRoute("sharp-cuts-web","social","instagram");assert.equal(route,"#project/sharp-cuts-web/social/instagram");assert.deepEqual(parseProjectRoute(route),{projectId:"sharp-cuts-web",view:"social",platform:"instagram"});});
test("all current and future projects inherit the reusable business workspace",()=>{assert.equal(sectionsForProject("future-project").length,12);assert.deepEqual(sectionsForProject("future-project").map(item=>item.id),sectionsForProject("sharp-cuts-web").map(item=>item.id));});
test("platform state never invents missing metrics",()=>{assert.deepEqual(platformState({instagram:{connected:true}},{instagram:{followers:10}},"instagram").metrics,[{label:"Followers",value:10},{label:"Media",value:null}]);assert.equal(platformState({},null,"tiktok").label,"Not Connected");});
