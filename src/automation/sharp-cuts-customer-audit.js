import {createHash,createHmac} from "node:crypto";

const DAY_MS=24*60*60*1000;
const DELIVERY_STATES=new Set(["delivered","sent","failed","undelivered","unknown","none"]);

export class SharpCutsCustomerAuditError extends Error{
  constructor(message,{code="sharp_cuts_customer_audit_error",statusCode=400}={}){super(message);this.name="SharpCutsCustomerAuditError";this.code=code;this.statusCode=statusCode;}
}

const iso=value=>{if(value===null||value===undefined||value==="")return null;const parsed=new Date(value);if(Number.isNaN(parsed.getTime()))throw new SharpCutsCustomerAuditError("A customer date is invalid.",{code:"sharp_cuts_customer_data_invalid"});return parsed.toISOString();};
const text=value=>String(value??"").trim();
const normaliseEmail=value=>text(value).toLowerCase();
const normalisePhone=value=>{const source=text(value);if(!source)return"";const plus=source.startsWith("+")?"+":"",digits=source.replace(/\D/g,"");return plus+digits;};
const keyBuffer=value=>{const key=Buffer.isBuffer(value)?value:Buffer.from(String(value||""),"utf8");if(key.length<32)throw new SharpCutsCustomerAuditError("A 32-byte customer identity key is required.",{code:"sharp_cuts_identity_key_required",statusCode:500});return key;};
const fingerprint=(key,purpose,value)=>createHmac("sha256",key).update(`${purpose}:${value}`).digest("hex");
const contentHash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const marketingBasis=value=>new Set(["consent","soft_opt_in_verified"]).has(text(value))?text(value):"unknown";

export function auditCustomerProfiles(records,{asOf=new Date(),identityKey,expectedCount}={}){
  if(!Array.isArray(records))throw new SharpCutsCustomerAuditError("Customer records must be an array.",{code:"sharp_cuts_customer_data_invalid"});
  if(expectedCount!==undefined&&records.length!==expectedCount)throw new SharpCutsCustomerAuditError(`Expected ${expectedCount} customer profiles but received ${records.length}.`,{code:"sharp_cuts_customer_export_incomplete",statusCode:409});
  const key=keyBuffer(identityKey),now=new Date(asOf);if(Number.isNaN(now.getTime()))throw new SharpCutsCustomerAuditError("asOf is invalid.",{code:"sharp_cuts_customer_data_invalid"});
  const emailGroups=new Map(),phoneGroups=new Map(),profileKeys=new Set(),profiles=[];
  const counts={profiles:records.length,missingEmail:0,missingMobile:0,missingBoth:0,upcomingBooking:0,inactive30:0,inactive45:0,inactive60:0,inactive90:0,noVisitHistory:0,emailEligible:0,smsEligible:0,blockedSuppression:0,blockedUnknownBasis:0};
  const delivery={email:{delivered:0,sent:0,failed:0,undelivered:0,unknown:0,none:0},sms:{delivered:0,sent:0,failed:0,undelivered:0,unknown:0,none:0},whatsapp:{delivered:0,sent:0,failed:0,undelivered:0,unknown:0,none:0}};
  for(const [index,record] of records.entries()){
    const sourceRef=text(record?.sourceRef);if(!sourceRef)throw new SharpCutsCustomerAuditError(`Customer record ${index+1} has no source reference.`,{code:"sharp_cuts_customer_data_invalid"});
    const profileKey=fingerprint(key,"profile",sourceRef);if(profileKeys.has(profileKey))throw new SharpCutsCustomerAuditError("The customer export contains a repeated source profile identifier.",{code:"sharp_cuts_customer_source_duplicate",statusCode:409});profileKeys.add(profileKey);
    const email=normaliseEmail(record.email),mobile=normalisePhone(record.mobile),lastVisitAt=iso(record.lastVisitAt),nextBookingAt=iso(record.nextBookingAt),suppressed=record.suppressed===true,basis=marketingBasis(record.marketingBasis);
    if(!email)counts.missingEmail+=1;if(!mobile)counts.missingMobile+=1;if(!email&&!mobile)counts.missingBoth+=1;if(suppressed)counts.blockedSuppression+=1;if(basis==="unknown")counts.blockedUnknownBasis+=1;
    const emailKey=email?fingerprint(key,"email",email):null,phoneKey=mobile?fingerprint(key,"mobile",mobile):null;
    if(emailKey)emailGroups.set(emailKey,[...(emailGroups.get(emailKey)||[]),profileKey]);if(phoneKey)phoneGroups.set(phoneKey,[...(phoneGroups.get(phoneKey)||[]),profileKey]);
    const hasUpcoming=Boolean(nextBookingAt&&new Date(nextBookingAt)>=now);if(hasUpcoming)counts.upcomingBooking+=1;
    let inactivitySegment="no_visit_history",daysInactive=null;
    if(lastVisitAt){daysInactive=Math.max(0,Math.floor((now-new Date(lastVisitAt))/DAY_MS));inactivitySegment=daysInactive>=90?"inactive_90":daysInactive>=60?"inactive_60":daysInactive>=45?"inactive_45":daysInactive>=30?"inactive_30":"active_under_30";}else counts.noVisitHistory+=1;
    if(inactivitySegment==="inactive_30")counts.inactive30+=1;else if(inactivitySegment==="inactive_45")counts.inactive45+=1;else if(inactivitySegment==="inactive_60")counts.inactive60+=1;else if(inactivitySegment==="inactive_90")counts.inactive90+=1;
    const eligibleBasis=basis!=="unknown"&&!suppressed;if(email&&eligibleBasis)counts.emailEligible+=1;if(mobile&&eligibleBasis)counts.smsEligible+=1;
    const evidence={};for(const channel of ["email","sms","whatsapp"]){const state=text(record.deliveryEvidence?.[channel]||"none").toLowerCase();if(!DELIVERY_STATES.has(state))throw new SharpCutsCustomerAuditError("Delivery evidence contains an unsupported status.",{code:"sharp_cuts_customer_data_invalid"});delivery[channel][state]+=1;evidence[channel]=state;}
    profiles.push({profileKey,emailKey,phoneKey,lastVisitAt,nextBookingAt,daysInactive,inactivitySegment,hasUpcomingBooking:hasUpcoming,marketingBasis:basis,suppressed,emailEligible:Boolean(email&&eligibleBasis),smsEligible:Boolean(mobile&&eligibleBasis),deliveryEvidence:evidence});
  }
  const duplicateClusters=(kind,groups)=>[...groups].filter(([,members])=>members.length>1).map(([contactKey,members])=>({kind,contactKey,profileKeys:[...members].sort(),profileCount:members.length})).sort((a,b)=>a.contactKey.localeCompare(b.contactKey));
  const duplicates=[...duplicateClusters("email",emailGroups),...duplicateClusters("mobile",phoneGroups)],duplicateProfiles=new Set(duplicates.flatMap(item=>item.profileKeys)).size;
  const safe={version:1,asOf:now.toISOString(),counts:{...counts,duplicateClusters:duplicates.length,duplicateProfiles},duplicates,deliveryEvidence:delivery,profiles};
  return{...safe,auditHash:contentHash(safe),rawContactDataRetained:false,identifiers:"hmac_sha256"};
}

export function buildMigrationReadyCustomerRows(audit){
  if(!audit||audit.rawContactDataRetained!==false||audit.identifiers!=="hmac_sha256")throw new SharpCutsCustomerAuditError("Only a privacy-safe customer audit can be staged.",{code:"sharp_cuts_customer_audit_required",statusCode:409});
  return audit.profiles.map(profile=>({profileKey:profile.profileKey,emailKey:profile.emailKey,phoneKey:profile.phoneKey,lastVisitAt:profile.lastVisitAt,nextBookingAt:profile.nextBookingAt,marketingBasis:profile.marketingBasis,suppressed:profile.suppressed,deliveryEvidence:profile.deliveryEvidence,sourceAuditHash:audit.auditHash}));
}

export function inspectCsvHeaders(csvText){
  if(typeof csvText!=="string"||!csvText.trim())throw new SharpCutsCustomerAuditError("CSV content is empty.",{code:"sharp_cuts_customer_export_invalid"});
  const firstRecord=[];let value="",quoted=false;for(let index=0;index<csvText.length;index+=1){const char=csvText[index];if(char==='"'){if(quoted&&csvText[index+1]==='"'){value+='"';index+=1;}else quoted=!quoted;}else if(char===","&&!quoted){firstRecord.push(value.replace(/^\uFEFF/,"").trim());value="";}else if((char==="\n"||char==="\r")&&!quoted){firstRecord.push(value.trim());break;}else value+=char;}if(!firstRecord.length)firstRecord.push(value.trim());if(quoted||firstRecord.some(header=>!header))throw new SharpCutsCustomerAuditError("CSV headers are malformed.",{code:"sharp_cuts_customer_export_invalid"});return{headers:firstRecord,headerHash:contentHash(firstRecord),rowsRead:0,personalDataRead:false};
}

export function parseCsvRecords(csvText){
  if(typeof csvText!=="string"||!csvText.trim())throw new SharpCutsCustomerAuditError("CSV content is empty.",{code:"sharp_cuts_customer_export_invalid"});
  const rows=[];let row=[],value="",quoted=false;const pushValue=()=>{row.push(value);value="";},pushRow=()=>{pushValue();if(row.some(cell=>cell!==""))rows.push(row);row=[];};
  for(let index=0;index<csvText.length;index+=1){const char=csvText[index];if(char==='"'){if(quoted&&csvText[index+1]==='"'){value+='"';index+=1;}else quoted=!quoted;}else if(char===","&&!quoted)pushValue();else if((char==="\n"||char==="\r")&&!quoted){if(char==="\r"&&csvText[index+1]==="\n")index+=1;pushRow();}else value+=char;}
  if(quoted)throw new SharpCutsCustomerAuditError("CSV quoting is malformed.",{code:"sharp_cuts_customer_export_invalid"});if(value||row.length)pushRow();if(rows.length<2)throw new SharpCutsCustomerAuditError("CSV contains no customer rows.",{code:"sharp_cuts_customer_export_invalid"});
  const headers=rows.shift().map((header,index)=>index===0?header.replace(/^\uFEFF/,"").trim():header.trim());if(headers.some(header=>!header)||new Set(headers).size!==headers.length)throw new SharpCutsCustomerAuditError("CSV headers are missing or duplicated.",{code:"sharp_cuts_customer_export_invalid"});
  return rows.map((cells,index)=>{if(cells.length!==headers.length)throw new SharpCutsCustomerAuditError(`CSV row ${index+2} does not match the header width.`,{code:"sharp_cuts_customer_export_invalid"});return Object.fromEntries(headers.map((header,column)=>[header,cells[column].trim()]));});
}

export function mapFreshaCustomerRows(rows,columnMap){
  if(!Array.isArray(rows)||!columnMap||typeof columnMap!=="object")throw new SharpCutsCustomerAuditError("A versioned Fresha column map is required.",{code:"sharp_cuts_customer_mapping_required"});
  const allowed=new Set(["sourceRef","email","mobile","lastVisitAt","nextBookingAt","marketingBasis","suppressed","deliveryEmail","deliverySms","deliveryWhatsapp"]),required=["sourceRef","lastVisitAt"];
  for(const key of Object.keys(columnMap))if(!allowed.has(key))throw new SharpCutsCustomerAuditError(`Unsupported column mapping ${key}.`,{code:"sharp_cuts_customer_mapping_invalid"});for(const key of required)if(!text(columnMap[key]))throw new SharpCutsCustomerAuditError(`Column mapping ${key} is required.`,{code:"sharp_cuts_customer_mapping_required"});
  const get=(row,key)=>columnMap[key]?row[columnMap[key]]:undefined,bool=value=>/^(?:true|yes|1|opted in)$/i.test(text(value));
  return rows.map(row=>({sourceRef:get(row,"sourceRef"),email:get(row,"email"),mobile:get(row,"mobile"),lastVisitAt:get(row,"lastVisitAt"),nextBookingAt:get(row,"nextBookingAt"),marketingBasis:get(row,"marketingBasis"),suppressed:bool(get(row,"suppressed")),deliveryEvidence:{email:get(row,"deliveryEmail")||"none",sms:get(row,"deliverySms")||"none",whatsapp:get(row,"deliveryWhatsapp")||"none"}}));
}

