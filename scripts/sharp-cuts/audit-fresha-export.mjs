import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {auditCustomerProfiles,mapFreshaCustomerRows,parseCsvRecords} from "../../src/automation/sharp-cuts-customer-audit.js";

const args=new Map();for(let index=2;index<process.argv.length;index+=2)args.set(process.argv[index],process.argv[index+1]);
const input=args.get("--profiles"),mappingPath=args.get("--mapping"),output=args.get("--output"),asOf=args.get("--as-of"),expectedCount=Number(args.get("--expected-count")||1991),identityKey=process.env.NOVA_SHARP_CUTS_CUSTOMER_IDENTITY_KEY;
if(!input||!mappingPath||!output||!asOf)throw new Error("Usage: --profiles <csv> --mapping <json> --output <json> --as-of <ISO date> [--expected-count 1991]");
if(!Number.isInteger(expectedCount)||expectedCount<1)throw new Error("--expected-count must be a positive integer.");
const [csv,mappingText]=await Promise.all([readFile(resolve(input),"utf8"),readFile(resolve(mappingPath),"utf8")]),mapping=JSON.parse(mappingText),records=mapFreshaCustomerRows(parseCsvRecords(csv),mapping),audit=auditCustomerProfiles(records,{asOf:new Date(asOf),identityKey,expectedCount});
await writeFile(resolve(output),JSON.stringify(audit,null,2)+"\n",{encoding:"utf8",flag:"wx"});
process.stdout.write(JSON.stringify({status:"completed",profiles:audit.counts.profiles,auditHash:audit.auditHash,rawContactDataRetained:false})+"\n");

