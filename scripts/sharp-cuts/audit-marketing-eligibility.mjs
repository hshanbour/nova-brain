import {readFile,writeFile} from "node:fs/promises";
import {parseCsvRecords} from "../../src/automation/sharp-cuts-customer-audit.js";

const args=new Map();for(let index=2;index<process.argv.length;index+=2)args.set(process.argv[index],process.argv[index+1]);
const input=args.get("--profiles"),output=args.get("--output"),asOf=new Date(args.get("--as-of")||"");
if(!input||!output||Number.isNaN(asOf.getTime()))throw new Error("Usage: --profiles <csv> --output <json> --as-of <ISO date>");
const rows=parseCsvRecords(await readFile(input,"utf8")),headers=Object.keys(rows[0]||{}),required=["Mobile number","Email","Last appt."];
for(const header of required)if(!headers.includes(header))throw new Error(`Required Fresha field is missing: ${header}`);
const consentFields=headers.filter(header=>/consent|marketing|opt.?in|subscription/i.test(header)),suppressionFields=headers.filter(header=>/opt.?out|suppress|unsubscribe/i.test(header)),deliveryFields=headers.filter(header=>/deliver|bounce|reachable|invalid/i.test(header));
const month={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
const date=value=>{const text=String(value||"").trim();if(!text)return null;const match=text.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})(?:,.*)?$/);if(!match||month[match[2]]===undefined)throw new Error("A Last appt. value is not in the expected Fresha format.");return new Date(Date.UTC(Number(match[3]),month[match[2]],Number(match[1])));};
const fresh=()=>({profiles:0,emailPresent:0,mobilePresent:0,bothPresent:0,verifiedEligible:{email:0,sms:0,whatsapp:0},unknownEligibility:{email:0,sms:0,whatsapp:0},blockedMissingChannel:{email:0,sms:0,whatsapp:0}});
const groups={active_under_30:fresh(),inactive_30_44:fresh(),inactive_45_59:fresh(),inactive_60_89:fresh(),inactive_90_plus:fresh(),no_visit_history:fresh(),future_or_upcoming:fresh()};
for(const row of rows){
  const last=date(row["Last appt."]),days=last?Math.floor((asOf.getTime()-last.getTime())/86400000):null,group=!last?"no_visit_history":days<0?"future_or_upcoming":days>=90?"inactive_90_plus":days>=60?"inactive_60_89":days>=45?"inactive_45_59":days>=30?"inactive_30_44":"active_under_30",value=groups[group],email=Boolean(String(row.Email||"").trim()),mobile=Boolean(String(row["Mobile number"]||"").trim());
  value.profiles+=1;if(email)value.emailPresent+=1;if(mobile)value.mobilePresent+=1;if(email&&mobile)value.bothPresent+=1;
  if(email)value.unknownEligibility.email+=1;else value.blockedMissingChannel.email+=1;
  if(mobile){value.unknownEligibility.sms+=1;value.unknownEligibility.whatsapp+=1;}else{value.blockedMissingChannel.sms+=1;value.blockedMissingChannel.whatsapp+=1;}
}
const result={version:1,asOf:asOf.toISOString(),sourceRows:rows.length,fields:{consent:consentFields.length?"present":"unavailable",suppression:suppressionFields.length?"present":"unavailable",deliveryEvidence:deliveryFields.length?"present":"unavailable",upcomingBooking:"last_appointment_future_date_only"},groups,policy:{contactPresenceIsNotConsent:true,unknownIsNotEligible:true,verifiedEligibleTotal:0,sendAuthorised:false},rawIdentifiersRetained:false};
await writeFile(output,JSON.stringify(result,null,2)+"\n",{encoding:"utf8",flag:"wx"});
process.stdout.write(JSON.stringify({status:"completed",sourceRows:rows.length,verifiedEligibleTotal:0,rawIdentifiersRetained:false})+"\n");
