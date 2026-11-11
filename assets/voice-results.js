import {renderSafeMarkdown} from './message-markdown.js';

const text=(value,max=500)=>typeof value==='string'?value.slice(0,max):'';
function sourceUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}

// Deliberately project display fields, never dump arbitrary tool arguments/results.
export function projectVoiceResult(result,conversationId){
  if(!result?.runId||!conversationId||result.conversationId!==conversationId)return null;
  const tools=(result.toolCalls||[]).map(t=>({name:text(t.name,100),status:text(t.status,60)}));
  const sources=[];
  for(const tool of result.toolCalls||[]){
    if(tool.status!=='completed')continue;
    for(const s of (Array.isArray(tool.result?.sources)?tool.result.sources:[]).slice(0,30)){
      const source={id:text(s.id||s.sourceId,160),label:text(s.label||s.title||s.id||'Source'),url:sourceUrl(s.url||s.locator),at:text(s.retrievedAt||s.updatedAt,80),status:text(s.status,60)};
      if(!sources.some(v=>v.id===source.id&&v.url===source.url&&v.label===source.label))sources.push(source);
    }
  }
  return {conversationId,runId:text(result.runId,160),status:text(result.runStatus||'unknown',80),message:text(result.message,24000),approvalRequired:Boolean(result.approval),tools,sources};
}

export function createVoiceResults({panel,button,getConversationId}){
  let current=null;
  const doc=panel.ownerDocument,body=panel.querySelector('[data-results-body]');
  const setOpen=open=>{panel.hidden=!open;button.setAttribute('aria-expanded',String(open));};
  const add=(tag,value)=>{const el=doc.createElement(tag);el.textContent=value;body.append(el);return el;};
  function clear(){current=null;body.replaceChildren();button.textContent='Results';setOpen(false);}
  function show(result,{open=false}={}){
    const projected=projectVoiceResult(result,getConversationId());if(!projected)return false;
    current=projected;body.replaceChildren();
    add('p',`Execution receipt: ${current.runId} · ${current.status}`).className='voice-results-receipt';
    if(current.approvalRequired)add('p','Owner approval is still required. This panel does not approve or execute actions.');
    const summary=doc.createElement('div');summary.dir='auto';renderSafeMarkdown(summary,current.message);body.append(summary);
    add('h3','Executed tools');
    add('p',current.tools.length?current.tools.map(t=>`${t.name}: ${t.status}`).join(' · '):'No tools were executed for this answer.');
    add('h3','Sources returned by tools');
    if(!current.sources.length)add('p','No structured sources were returned. Any citations in the answer remain visible above.');
    for(const s of current.sources){const p=add('p','');if(s.url){const a=doc.createElement('a');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=s.label;p.append(a);}else p.textContent=s.label;
      const small=doc.createElement('small');small.textContent=[s.id,s.at,s.status].filter(Boolean).join(' · ');p.append(small);}
    button.textContent='Results · ready';if(open)setOpen(true);return true;
  }
  button.addEventListener('click',()=>{
    if(current?.conversationId!==getConversationId())clear();
    if(!current){body.replaceChildren();add('p','Ask Nova to analyse a project. Its completed result, sources and execution receipt will appear here. No example data is shown.');}
    setOpen(panel.hidden);
  });
  panel.querySelector('[data-results-close]').addEventListener('click',()=>{setOpen(false);button.focus();});
  panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();setOpen(false);button.focus();}});
  return {show,clear};
}
