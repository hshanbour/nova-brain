import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AUTHORIZED_NEW_SOURCE_PATHS,
  authorizeNewSourcePath,
  deriveSourceCreationAuthorities,
  verifySourceCreationRecord,
} from "../src/autonomy/source-creation-authority.js";

const SHA="a".repeat(40);
const authorize=(path,paths,goal)=>{
  const authorities=deriveSourceCreationAuthorities(paths,{userGoal:goal});
  return authorizeNewSourcePath(path,{authorities,userGoal:goal,existingPaths:paths});
};

test("repository-grounded source creation certifies common frontend backend and integration layouts",()=>{
  for(const item of [
    {goal:"Add a profile component",paths:["src/components/nav-component.js","src/components/search-component.js"],path:"src/components/profile-component.js"},
    {goal:"Add an audit route",paths:["src/routes/user-route.js","src/routes/billing-route.js"],path:"src/routes/audit-route.js"},
    {goal:"Add a Twilio integration adapter",paths:["src/integrations/stripe-adapter.js","src/integrations/gmail-adapter.js"],path:"src/integrations/twilio-adapter.js"},
  ]){
    const result=authorize(item.path,item.paths,item.goal);
    assert.equal(result.authorized,true);
    assert.equal(result.record.path,item.path);
    assert.deepEqual(result.record.evidencePaths,[...item.paths].sort());
    assert.equal(verifySourceCreationRecord({...result.record,baselineCommit:SHA}),true);
  }
});

test("the same contract supports repository-grounded pages automations services and bots",()=>{
  for(const item of [
    {goal:"Add a contact page",paths:["src/pages/home-page.js","src/pages/about-page.js"],path:"src/pages/contact-page.js"},
    {goal:"Add a cleanup automation",paths:["src/automations/email-automation.js","src/automations/report-automation.js"],path:"src/automations/cleanup-automation.js"},
    {goal:"Add a notification service",paths:["src/services/auth-service.js","src/services/billing-service.js"],path:"src/services/notification-service.js"},
    {goal:"Add a triage bot",paths:["src/bots/support-bot.js","src/bots/release-bot.js"],path:"src/bots/triage-bot.js"},
  ])assert.equal(authorize(item.path,item.paths,item.goal).authorized,true,item.path);
});

test("source creation fails closed for ambiguity arbitrary locations sensitive paths overwrites and naming violations",()=>{
  const goal="Add a profile component",paths=[
    "src/components/nav-component.js","src/components/search-component.js",
    "assets/components/nav-component.js","assets/components/search-component.js",
  ];
  assert.deepEqual(deriveSourceCreationAuthorities(paths,{userGoal:goal}),[]);
  assert.equal(authorize("src/components/profile-component.js",paths,goal).authorized,false);
  assert.equal(authorize("random/profile-component.js",paths.slice(0,2),goal).reason,"location_unproven");
  assert.equal(authorize("src/secrets/profile-component.js",paths.slice(0,2),goal).reason,"invalid_or_sensitive_path");
  assert.equal(authorize("src/components/nav-component.js",paths.slice(0,2),goal).reason,"existing_path");
  assert.equal(authorize("src/components/profile-widget.js",paths.slice(0,2),goal).reason,"naming_convention_mismatch");
});

test("source creation authority is tamper evident and has a fixed blast-radius ceiling",()=>{
  assert.equal(MAX_AUTHORIZED_NEW_SOURCE_PATHS,4);
  const paths=["src/integrations/stripe-adapter.js","src/integrations/gmail-adapter.js"],goal="Add a Twilio integration adapter",result=authorize("src/integrations/twilio-adapter.js",paths,goal);
  assert.equal(result.authorized,true);
  assert.equal(verifySourceCreationRecord({...result.record,baselineCommit:SHA,path:"src/integrations/signal-adapter.js"}),false);
  const authority=deriveSourceCreationAuthorities(paths,{userGoal:goal})[0];
  assert.equal(authorizeNewSourcePath("src/integrations/twilio-adapter.js",{authorities:[{...authority,directory:"src/other"}],userGoal:goal,existingPaths:paths}).authorized,false);
});
