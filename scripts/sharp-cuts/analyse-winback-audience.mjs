import {readFile} from "node:fs/promises";
import {parseCsvRecords} from "../../src/automation/sharp-cuts-customer-audit.js";
import {analyseSharpCutsWinbackAudience} from "../../src/automation/sharp-cuts-campaign.js";

const args=new Map();for(let index=2;index<process.argv.length;index+=2)args.set(process.argv[index],process.argv[index+1]);
const input=args.get("--profiles"),asOf=args.get("--as-of");
if(!input||!asOf)throw new Error("Usage: --profiles <csv> --as-of <ISO date>");
const rows=parseCsvRecords(await readFile(input,"utf8"));
const audit=analyseSharpCutsWinbackAudience(rows,{asOf:new Date(asOf)});
process.stdout.write(`${JSON.stringify(audit)}\n`);
