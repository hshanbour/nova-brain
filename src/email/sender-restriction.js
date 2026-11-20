// Derive a conservative hold from retained evidence; never infer plan allowance
// or permission to send from a successful read endpoint or an elapsed timer.
export function senderRestriction(receipt){
  if(!receipt||Number(receipt.upstreamStatus??receipt.transport?.httpStatus)!==429)return null;
  const transport=receipt.transport||{}, times=[];
  const add=(source,value)=>{if(Number.isFinite(value)&&value>0&&value<=8.64e15)times.push({source,at:new Date(value).toISOString()});};
  const checked=Date.parse(receipt.checkedAt), responseDate=Date.parse(transport.responseDate);
  const anchor=Math.max(...[checked,responseDate].filter(Number.isFinite));
  const retry=transport.retryAfter??receipt.retryAfterSeconds;
  if(retry!==null&&retry!==undefined){
    if(/^\d+$/.test(String(retry)))add('Retry-After',anchor+Number(retry)*1000);
    else add('Retry-After',Date.parse(retry));
  }
  const reset=(transport.rateLimit||receipt.rateLimit)?.['X-RateLimit-Reset'];
  if(reset!==null&&reset!==undefined&&/^\d+$/.test(String(reset))&&Number(reset)<1e12)add('X-RateLimit-Reset',Number(reset)*1000);
  const bodyDate=receipt.providerResponse?.message?.match(/Retry after\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i)?.[1];
  if(bodyDate)add('response message',Date.parse(bodyDate));
  const values=times.map(t=>Date.parse(t.at));
  const plan=receipt.providerResponse?.type==='plan';
  return {kind:plan?'provider_plan_restriction':'provider_rate_limit',scope:'unconfirmed',allowance:'unconfirmed',
    notBefore:values.length?new Date(Math.max(...values)).toISOString():null,
    conflictingDeadlines:values.length>1&&Math.max(...values)-Math.min(...values)>5000,
    deadlines:times,requiresProviderClarification:plan,automaticRetry:false,
    explanation:plan?'Sender rejected this sending request with type=plan. The exact counter and scope are not established; the monthly campaign allowance does not establish permission for this request.':'Sender rejected this request with HTTP 429.',
    nextAction:plan?'Await Sender clarification before another test. The displayed deadline is a conservative hold, not a guarantee that sending will be permitted.':'Respect every supplied cooldown and reconcile the previous outcome before an authorised retry.'};
}
export const withSenderRestriction=receipt=>receipt?{...receipt,restriction:senderRestriction(receipt)}:null;
