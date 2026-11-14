import {renderSafeMarkdown} from './message-markdown.js';

const text=(value,max=500)=>typeof value==='string'?value.slice(0,max):'';
function sourceUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}

// Deliberately project display fields, never dump arbitrary tool arguments/results.
export function projectVoiceResult(result,conversationId){
  if(!result?.runId||!conversationId||result.conversationId!==conversationId)return null;
  const tools=(result.toolCalls||[]).map(t=>({name:text(t.name,100),status:text(t.status,60),verification:text(t.result?.verification,60)}));
  const task=result.taskControl||result.durableTask;
  const sources=[];
  for(const tool of result.toolCalls||[]){
    if(tool.status!=='completed')continue;
    for(const s of (Array.isArray(tool.result?.sources)?tool.result.sources:[]).slice(0,30)){
      const source={id:text(s.id||s.sourceId,160),label:text(s.label||s.title||s.id||'Source'),url:sourceUrl(s.url||s.locator),at:text(s.retrievedAt||s.updatedAt,80),status:text(s.status,60)};
      if(!sources.some(v=>v.id===source.id&&v.url===source.url&&v.label===source.label))sources.push(source);
    }
  }
  const charts=[];
  for(const tool of result.toolCalls||[]){
    if(tool.status!=='completed')continue;
    for(const chart of (Array.isArray(tool.result?.charts)?tool.result.charts:[]).slice(0,4)){
      if(chart.type!=='bar'||!Array.isArray(chart.points)||!chart.points.length||!Array.isArray(chart.sourceIds)||!chart.sourceIds.length||!chart.sourceIds.every(id=>sources.some(s=>s.id===id)))continue;
      if(!chart.points.every(p=>typeof p.label==='string'&&Number.isFinite(p.value)&&p.value>=0))continue;
      charts.push({title:text(chart.title,160),unit:text(chart.unit,40),observedAt:text(chart.observedAt,80),sourceIds:chart.sourceIds,points:chart.points.slice(0,30).map(p=>({label:text(p.label,100),value:p.value}))});
    }
  }
  return {conversationId,runId:text(result.runId,160),status:text(result.runStatus||'unknown',80),taskStatus:text(task?.status,80),message:text(result.message,24000),approvalRequired:Boolean(result.approval),tools,sources,...(charts.length?{charts}:{})};
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
    add('p',`Request receipt: ${current.runId} · ${current.status}`).className='voice-results-receipt';
    if(current.taskStatus)add('p',`Background task at the time of this receipt: ${current.taskStatus}`);
    if(current.approvalRequired)add('p','Owner approval is still required. This panel does not approve or execute actions.');
    const summary=doc.createElement('div');summary.dir='auto';renderSafeMarkdown(summary,current.message);body.append(summary);
    add('h3','Executed tools');
    add('p',current.tools.length?current.tools.map(t=>`${t.name}: ${t.status}${t.verification?' · evidence '+t.verification:''}`).join(' · '):'No tools were executed for this answer.');
    add('h3','Sources returned by tools');
    for(const chart of current.charts||[]){
      add('h3',chart.title);add('p',`${chart.unit} · observed ${chart.observedAt}`);
      const maximum=Math.max(1,...chart.points.map(p=>p.value));
      for(const point of chart.points){const row=add('div',`${point.label}: ${point.value} ${chart.unit}`);const bar=doc.createElement('div');bar.className='voice-result-bar';bar.style.width=`${point.value/maximum*100}%`;row.append(bar);}
      add('small',`Source: ${chart.sourceIds.join(', ')}`);
    }
    if(!current.charts?.length)add('p','No structured chart data was returned; no chart has been invented.');
    if(!current.sources.length)add('p','No structured sources were returned. Any citations in the answer remain visible above.');
    for(const s of current.sources){const p=add('p','');if(s.url){const a=doc.createElement('a');a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=s.label;p.append(a);}else p.textContent=s.label;
      const small=doc.createElement('small');small.textContent=[s.id,s.at,s.status].filter(Boolean).join(' · ');p.append(small);}
    button.textContent='View receipt';if(open)setOpen(true);return true;
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
