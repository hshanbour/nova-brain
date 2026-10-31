const DAY=86400000;
const numeric=value=>Number.isFinite(Number(value))?Number(value):null;
const dateOf=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?null:date;};

export function filterMetricSnapshots(snapshots,{days=30,now=new Date()}={}){
  const values=(Array.isArray(snapshots)?snapshots:[]).filter(item=>dateOf(item?.capturedAt));
  if(days==="all")return values.toSorted((a,b)=>new Date(a.capturedAt)-new Date(b.capturedAt));
  const cutoff=new Date(now).getTime()-Math.max(1,Number(days)||30)*DAY;
  return values.filter(item=>new Date(item.capturedAt).getTime()>=cutoff).toSorted((a,b)=>new Date(a.capturedAt)-new Date(b.capturedAt));
}

export function metricSeries(snapshots,platform,metric){
  return (Array.isArray(snapshots)?snapshots:[]).map(item=>({date:item.capturedAt,value:numeric(item?.metrics?.[platform]?.[metric])})).filter(item=>item.value!==null);
}

export function compareMetricSeries(series){
  const values=Array.isArray(series)?series:[],first=values[0]?.value,last=values.at(-1)?.value;
  if(values.length<2||first===null||last===null||first===undefined||last===undefined)return{available:false,delta:null,percent:null};
  return{available:true,delta:last-first,percent:first===0?null:((last-first)/first)*100};
}

export function calendarWindow(entries,{anchor=new Date(),view="month"}={}){
  const current=new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth(),anchor.getUTCDate()));
  let start,end;
  if(view==="week"){
    start=new Date(current);start.setUTCDate(current.getUTCDate()-((current.getUTCDay()+6)%7));
    end=new Date(start);end.setUTCDate(start.getUTCDate()+6);
  }else{
    start=new Date(Date.UTC(current.getUTCFullYear(),current.getUTCMonth(),1));
    start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
    end=new Date(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()+1,0));
    end.setUTCDate(end.getUTCDate()+((7-end.getUTCDay())%7));
  }
  const byDate=new Map();for(const item of Array.isArray(entries)?entries:[]){const date=String(item?.eventDate||"");if(date>=iso(start)&&date<=iso(end)){if(!byDate.has(date))byDate.set(date,[]);byDate.get(date).push(item);}}
  const days=[];for(let cursor=new Date(start);cursor<=end;cursor=new Date(cursor.getTime()+DAY)){const date=iso(cursor);days.push({date,inMonth:cursor.getUTCMonth()===current.getUTCMonth(),entries:byDate.get(date)||[]});}
  return{start:iso(start),end:iso(end),days};
}

export function shiftCalendarAnchor(anchor,view,direction){
  const date=new Date(anchor),step=direction<0?-1:1;if(view==="week")date.setUTCDate(date.getUTCDate()+7*step);else date.setUTCMonth(date.getUTCMonth()+step);return date;
}

const iso=value=>value.toISOString().slice(0,10);
