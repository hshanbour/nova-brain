import {createHash} from "node:crypto";

export const SHARP_CUTS_WEB_PROJECT_ID="sharp-cuts-web";
export const SHARP_CUTS_RETENTION_DEMO_ID="sharp-cuts-retention-demo-v1";

const DAY_MS=24*60*60*1000;
const hash=value=>createHash("sha256").update(String(value)).digest("hex");
const iso=value=>{const parsed=new Date(value);if(Number.isNaN(parsed.getTime()))throw new SharpCutsAutomationError("A fixture date is invalid.",{code:"sharp_cuts_fixture_invalid"});return parsed.toISOString();};

export class SharpCutsAutomationError extends Error{
  constructor(message,{code="sharp_cuts_automation_error",statusCode=400}={}){super(message);this.name="SharpCutsAutomationError";this.code=code;this.statusCode=statusCode;}
}

export function classifyRetentionRecords(records,{asOf=new Date()}={}){
  const now=new Date(asOf);if(Number.isNaN(now.getTime()))throw new SharpCutsAutomationError("asOf is invalid.",{code:"sharp_cuts_fixture_invalid"});
  const output=[],counts={inactive30:0,inactive45:0,inactive60:0,notDue:0,alreadyBooked:0,blocked:0,eligibleForOwnerReview:0};
  for(const record of records){
    const customerRef=String(record?.customerRef||"").trim();if(!/^demo-customer-\d{3}$/.test(customerRef))throw new SharpCutsAutomationError("Synthetic customer reference is invalid.",{code:"sharp_cuts_fixture_invalid"});
    const lastVisitAt=iso(record.lastVisitAt),daysInactive=Math.max(0,Math.floor((now.getTime()-new Date(lastVisitAt).getTime())/DAY_MS));
    const nextBookingAt=record.nextBookingAt?iso(record.nextBookingAt):null,suppressed=record.suppressed===true,marketingBasis=String(record.marketingBasis||"unknown");
    let segment="not_due",recommendedAction="none",eligible=false,reason="Customer is below the first inactivity threshold.";
    if(nextBookingAt&&new Date(nextBookingAt)>=now){segment="already_booked";reason="A future booking already exists; no retention contact is recommended.";}
    else if(daysInactive>=60){segment="inactive_60";recommendedAction="prepare_rebooking_recommendation";reason="No future booking and at least 60 inactive days.";}
    else if(daysInactive>=45){segment="inactive_45";recommendedAction="prepare_rebooking_recommendation";reason="No future booking and at least 45 inactive days.";}
    else if(daysInactive>=30){segment="inactive_30";recommendedAction="prepare_rebooking_recommendation";reason="No future booking and at least 30 inactive days.";}
    const retentionCandidate=segment.startsWith("inactive_");
    if(retentionCandidate&&suppressed){recommendedAction="blocked";reason="Suppression preference blocks promotional follow-up.";}
    else if(retentionCandidate&&!new Set(["consent","soft_opt_in_verified"]).has(marketingBasis)){recommendedAction="blocked";reason="No verified electronic-marketing basis is present.";}
    else if(retentionCandidate){eligible=true;reason+=" Sending still requires owner approval.";}
    if(segment==="inactive_30")counts.inactive30+=1;else if(segment==="inactive_45")counts.inactive45+=1;else if(segment==="inactive_60")counts.inactive60+=1;else if(segment==="already_booked")counts.alreadyBooked+=1;else counts.notDue+=1;
    if(retentionCandidate&&!eligible)counts.blocked+=1;if(eligible)counts.eligibleForOwnerReview+=1;
    output.push({customerRef,lastVisitAt,nextBookingAt,daysInactive,segment,marketingBasis,suppressed,recommendedAction,eligibleForOwnerReview:eligible,reason});
  }
  return{asOf:now.toISOString(),counts,records:output};
}

export function syntheticRetentionFixture(asOf=new Date("2026-10-17T09:00:00.000Z")){
  const at=days=>new Date(new Date(asOf).getTime()-days*DAY_MS).toISOString(),future=days=>new Date(new Date(asOf).getTime()+days*DAY_MS).toISOString();
  return[
    {customerRef:"demo-customer-001",lastVisitAt:at(31),marketingBasis:"consent",suppressed:false},
    {customerRef:"demo-customer-002",lastVisitAt:at(47),marketingBasis:"soft_opt_in_verified",suppressed:false},
    {customerRef:"demo-customer-003",lastVisitAt:at(67),marketingBasis:"unknown",suppressed:false},
    {customerRef:"demo-customer-004",lastVisitAt:at(72),marketingBasis:"consent",suppressed:true},
    {customerRef:"demo-customer-005",lastVisitAt:at(61),nextBookingAt:future(3),marketingBasis:"consent",suppressed:false},
    {customerRef:"demo-customer-006",lastVisitAt:at(12),marketingBasis:"consent",suppressed:false},
  ];
}

export function createSharpCutsAutomationService({storage,ownerId,clock=()=>new Date()}={}){
  if(!storage||!ownerId)throw new TypeError("Sharp Cuts automation dependencies are required.");
  const project=async()=>{const value=(await storage.listProjects(ownerId)).find(item=>item.id===SHARP_CUTS_WEB_PROJECT_ID);if(!value)throw new SharpCutsAutomationError("Import Sharp Cuts Web through Project Onboarding before running its automation demo.",{code:"sharp_cuts_project_required",statusCode:409});return value;};
  const activity=async()=> (await storage.listActivity(ownerId,{projectId:SHARP_CUTS_WEB_PROJECT_ID,limit:100})).filter(item=>item.tool?.startsWith("sharp_cuts_automation"));
  return Object.freeze({
    async dashboard(){
      const exists=(await storage.listProjects(ownerId)).some(item=>item.id===SHARP_CUTS_WEB_PROJECT_ID),events=exists?await activity():[],latest=events.find(item=>item.action==="sharp_cuts_retention_demo_completed")||null;
      return{projectId:SHARP_CUTS_WEB_PROJECT_ID,projectReady:exists,liveEnabled:false,source:{system:"Fresha",mode:"not_connected",lastRefresh:latest?.createdAt||null,dataClass:latest?"synthetic_fixture":"none",publicApiAssumed:false},sections:{bookings:{status:"awaiting_authorised_source",count:null},customers:{status:"awaiting_authorised_source",count:null},retention:{status:latest?"demo_complete":"demo_ready",counts:latest?.metadata?.counts||null},noShows:{status:"planned",count:null},campaigns:{status:"approval_required",count:0},followUps:{status:"approval_required",count:latest?.metadata?.counts?.eligibleForOwnerReview||0},socialMedia:{status:"available_in_social_command_centre"},automationActivity:{status:events.length?"available":"empty",count:events.length},pendingApprovals:{status:"none",count:0}},latestDemo:latest?{id:latest.id,status:latest.status,createdAt:latest.createdAt,counts:latest.metadata?.counts,sourceHash:latest.metadata?.sourceHash}:null,activity:events.slice(0,20),safeguards:{promotionalSend:"owner_approval_required",liveMessagesSent:false,rawCustomerDataStored:false,suppressionRequired:true,marketingBasisRequired:true,duplicateFreshaReminders:false}};
    },
    async runSyntheticRetentionDemo(){
      await project();const existing=(await activity()).find(item=>item.id===SHARP_CUTS_RETENTION_DEMO_ID);if(existing)return{created:false,event:existing,analysis:existing.metadata?.analysis||null};
      const asOf=clock(),fixture=syntheticRetentionFixture(asOf),analysis=classifyRetentionRecords(fixture,{asOf}),sourceHash=hash(JSON.stringify(fixture));
      const event=await storage.appendActivity({id:SHARP_CUTS_RETENTION_DEMO_ID,ownerId,projectId:SHARP_CUTS_WEB_PROJECT_ID,action:"sharp_cuts_retention_demo_completed",tool:"sharp_cuts_automation_retention_monitor",status:"completed",summary:"Processed a synthetic Fresha-style retention fixture; no customer data was imported and no message was sent.",metadata:{version:1,source:"synthetic_fixture",sourceHash,recordCount:fixture.length,counts:analysis.counts,analysis,liveMessagesSent:false,rawCustomerDataStored:false,ownerApprovalRequired:true}});
      return{created:true,event,analysis};
    }
  });
}
