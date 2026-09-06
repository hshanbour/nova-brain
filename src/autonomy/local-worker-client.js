export function createLocalWorkerClient({baseUrl,novaToken,vercelBypassToken,fetchImpl=fetch}={}){
  const origin=String(baseUrl||"").replace(/\/$/,"");
  if(!/^https:\/\//.test(origin))throw new Error("A protected HTTPS Preview URL is required.");
  if(!novaToken||!vercelBypassToken)throw new Error("Both protected Preview credentials are required.");
  if(novaToken===vercelBypassToken)throw new Error("Vercel and Nova credentials must remain separate.");
  return Object.freeze({
    async request(path,body){
      const response=await fetchImpl(`${origin}${path}`,{
        method:"POST",
        headers:{
          Authorization:`Bearer ${novaToken}`,
          "Content-Type":"application/json",
          "x-vercel-protection-bypass":vercelBypassToken,
        },
        body:JSON.stringify(body),
      });
      const value=await response.json().catch(()=>({}));
      if(!response.ok)throw Object.assign(new Error(value.error||`Handoff failed with status ${response.status}.`),{code:value.code||"handoff_failed"});
      return value;
    },
  });
}
