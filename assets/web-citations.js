const citationPattern=/\[([^\]\r\n]{1,300})\]\((https:\/\/[^)\s]+)\)/g;

export function appendSafeLinkedText(container,text){
  const document=container.ownerDocument||globalThis.document,value=String(text||"");
  let offset=0;
  for(const match of value.matchAll(citationPattern)){
    if(match.index>offset)container.append(document.createTextNode(value.slice(offset,match.index)));
    let url;
    try{url=new URL(match[2]);}catch{url=null;}
    if(url?.protocol==="https:"&&!url.username&&!url.password){
      const anchor=document.createElement("a");anchor.href=url.href;anchor.textContent=match[1];anchor.target="_blank";anchor.rel="noopener noreferrer";anchor.className="message-citation";container.append(anchor);
    }else container.append(document.createTextNode(match[1]));
    offset=match.index+match[0].length;
  }
  if(offset<value.length)container.append(document.createTextNode(value.slice(offset)));
}
