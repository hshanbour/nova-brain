const INTEGER_FIELDS=new Set(["classAOperations","classBOperations","reservedStorageBytes"]);

export class R2UsageLimitError extends Error{
  constructor(message,{code="social_media_r2_free_limit",statusCode=409,usage=null}={}){super(message);this.name="R2UsageLimitError";this.code=code;this.statusCode=statusCode;this.usage=usage;}
}

export function estimateR2MonthlyCostCents(usage,{freeAllowance,pricing}){
  const storageGb=Math.max(0,Number(usage.reservedStorageBytes||0)-freeAllowance.storageBytes)/1024**3;
  const classAMillions=Math.max(0,Number(usage.classAOperations||0)-freeAllowance.classAOperations)/1_000_000;
  const classBMillions=Math.max(0,Number(usage.classBOperations||0)-freeAllowance.classBOperations)/1_000_000;
  return Math.ceil(storageGb*pricing.storageCentsPerGbMonth+classAMillions*pricing.classACentsPerMillion+classBMillions*pricing.classBCentsPerMillion);
}

export function createR2UsageGuard({storage,ownerId,config,clock=()=>new Date()}={}){
  if(!storage||!ownerId||!config)throw new TypeError("R2 usage guard dependencies are required.");
  const billingMonth=()=>`${clock().toISOString().slice(0,7)}-01`;
  const limits=()=>({classALimit:config.classALimit,classBLimit:config.classBLimit,storageLimitBytes:config.hardQuotaBytes});
  const decorate=usage=>{const current=usage||{ownerId,projectId:null,billingMonth:billingMonth(),classAOperations:0,classBOperations:0,reservedStorageBytes:0,updatedAt:null},ratios={storage:current.reservedStorageBytes/config.hardQuotaBytes,classA:current.classAOperations/config.classALimit,classB:current.classBOperations/config.classBLimit},highest=Math.max(...Object.values(ratios));return{...current,limits:limits(),freeAllowance:config.freeAllowance,warningPercent:config.warningPercent,warning:highest>=config.warningPercent/100,stopped:highest>=1,expectedMonthlyOverageCents:estimateR2MonthlyCostCents(current,config),approvedMonthlyOverageCents:config.approvedOverageCents,pricing:config.pricing};};
  return Object.freeze({
    async status(projectId){const usage=await storage.getR2UsageMonth(ownerId,projectId,billingMonth());return decorate(usage?{...usage,projectId}:{ownerId,projectId,billingMonth:billingMonth(),classAOperations:0,classBOperations:0,reservedStorageBytes:0,updatedAt:null});},
    async reserve(projectId,deltas={}){const clean={};for(const field of INTEGER_FIELDS){const value=Number(deltas[field]||0);if(!Number.isSafeInteger(value)||value<0)throw new TypeError(`${field} must be a non-negative safe integer.`);clean[field]=value;}if(!clean.classAOperations&&!clean.classBOperations&&!clean.reservedStorageBytes)return this.status(projectId);const usage=await storage.reserveR2Usage({ownerId,projectId,billingMonth:billingMonth(),...clean,...limits()});if(!usage){const current=await this.status(projectId);throw new R2UsageLimitError("Nova stopped this R2 operation before it could exceed an application-enforced monthly free-tier quota.",{usage:current});}const decorated=decorate(usage);if(decorated.expectedMonthlyOverageCents>config.approvedOverageCents)throw new R2UsageLimitError(`Nova stopped this R2 operation because its estimated monthly overage would exceed the owner-approved limit of $${(config.approvedOverageCents/100).toFixed(2)}.`,{code:"social_media_r2_spend_limit",usage:decorated});return decorated;}
  });
}
