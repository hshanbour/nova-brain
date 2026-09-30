const headingPattern=/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const unorderedPattern=/^\s{0,3}[-+*]\s+(.+)$/;
const orderedPattern=/^\s{0,3}\d+[.)]\s+(.+)$/;
const tableDividerPattern=/^\s*:?-{3,}:?\s*$/;
const inlinePattern=/\[([^\]\r\n]{1,300})\]\((https:\/\/[^)\s]+)\)|\*\*([^*\r\n]+)\*\*|`([^`\r\n]+)`|\*([^*\r\n]+)\*/g;
const maximumHeadingCharacters=240;
const headingSpec=(line)=>String(line||"").length<=maximumHeadingCharacters?String(line||"").match(headingPattern):null;

function safeHttpsUrl(value){
  try{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password?url:null;}catch{return null;}
}

function directional(node){node.setAttribute("dir","auto");return node;}

function appendInline(container,value){
  const document=container.ownerDocument||globalThis.document,text=String(value||"");let offset=0;
  for(const match of text.matchAll(inlinePattern)){
    if(match.index>offset)container.append(document.createTextNode(text.slice(offset,match.index)));
    if(match[1]!==undefined){
      const url=safeHttpsUrl(match[2]);
      if(url){const anchor=document.createElement("a");anchor.href=url.href;anchor.textContent=match[1];anchor.target="_blank";anchor.rel="noopener noreferrer";anchor.className="message-citation";container.append(anchor);}
      else container.append(document.createTextNode(match[1]));
    }else if(match[3]!==undefined){const strong=document.createElement("strong");strong.textContent=match[3];container.append(strong);}
    else if(match[4]!==undefined){const code=document.createElement("code");code.textContent=match[4];container.append(code);}
    else{const emphasis=document.createElement("em");emphasis.textContent=match[5];container.append(emphasis);}
    offset=match.index+match[0].length;
  }
  if(offset<text.length)container.append(document.createTextNode(text.slice(offset)));
}

function splitTableRow(line){
  const value=String(line||"").trim().replace(/^\|/u,"").replace(/\|$/u,"");
  const cells=[];let cell="",escaped=false,code=false;
  for(const character of value){
    if(escaped){cell+=character;escaped=false;continue;}
    if(character==="\\"){escaped=true;continue;}
    if(character==="`"){code=!code;cell+=character;continue;}
    if(character==="|"&&!code){cells.push(cell.trim());cell="";continue;}
    cell+=character;
  }
  if(escaped)cell+="\\";cells.push(cell.trim());return cells;
}

function tableSpec(lines,index){
  if(index+1>=lines.length||!lines[index].includes("|")||!lines[index+1].includes("|"))return null;
  const headers=splitTableRow(lines[index]),dividers=splitTableRow(lines[index+1]);
  if(headers.length<2||headers.length!==dividers.length||!dividers.every(cell=>tableDividerPattern.test(cell)))return null;
  return{headers,alignments:dividers.map(cell=>cell.startsWith(":")&&cell.endsWith(":")?"center":cell.endsWith(":")?"right":"left")};
}

function startsBlock(lines,index){
  const line=lines[index]||"";
  return !line.trim()||Boolean(headingSpec(line))||/^\s*```/.test(line)||/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)||unorderedPattern.test(line)||orderedPattern.test(line)||/^\s{0,3}>\s?/.test(line)||Boolean(tableSpec(lines,index));
}

export function renderSafeMarkdown(container,text){
  const document=container.ownerDocument||globalThis.document,lines=String(text||"").replace(/\r\n?/g,"\n").split("\n");
  container.replaceChildren();container.classList?.add("message-markdown");container.setAttribute("dir","auto");
  for(let index=0;index<lines.length;){
    const line=lines[index];if(!line.trim()){index+=1;continue;}
    const fence=line.match(/^\s*```([^\s`]*)\s*$/);
    if(fence){const content=[];index+=1;while(index<lines.length&&!/^\s*```\s*$/.test(lines[index]))content.push(lines[index++]);if(index<lines.length)index+=1;const pre=document.createElement("pre"),code=document.createElement("code");if(fence[1])code.className=`language-${fence[1].toLowerCase().replace(/[^a-z0-9_-]/g,"")}`;code.textContent=content.join("\n");pre.append(code);container.append(pre);continue;}
    const heading=headingSpec(line);
    if(heading){const node=directional(document.createElement(`h${heading[1].length}`));appendInline(node,heading[2]);container.append(node);index+=1;continue;}
    if(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)){container.append(document.createElement("hr"));index+=1;continue;}
    const table=tableSpec(lines,index);
    if(table){const wrap=document.createElement("div"),node=document.createElement("table"),head=document.createElement("thead"),headRow=document.createElement("tr"),body=document.createElement("tbody");wrap.className="markdown-table-wrap";wrap.setAttribute("role","region");wrap.setAttribute("aria-label","Scrollable comparison table");wrap.setAttribute("tabindex","0");table.headers.forEach((value,column)=>{const cell=directional(document.createElement("th"));cell.setAttribute("scope","col");cell.dataset.align=table.alignments[column];appendInline(cell,value);headRow.append(cell);});head.append(headRow);index+=2;while(index<lines.length&&lines[index].trim()&&lines[index].includes("|")){const values=splitTableRow(lines[index]);if(values.length!==table.headers.length)break;const row=document.createElement("tr");values.forEach((value,column)=>{const cell=directional(document.createElement("td"));cell.dataset.align=table.alignments[column];appendInline(cell,value);row.append(cell);});body.append(row);index+=1;}node.append(head,body);wrap.append(node);container.append(wrap);continue;}
    const unordered=line.match(unorderedPattern),ordered=line.match(orderedPattern);
    if(unordered||ordered){const node=document.createElement(ordered?"ol":"ul"),pattern=ordered?orderedPattern:unorderedPattern;while(index<lines.length){const item=lines[index].match(pattern);if(!item)break;const child=directional(document.createElement("li"));appendInline(child,item[1]);node.append(child);index+=1;}container.append(node);continue;}
    if(/^\s{0,3}>\s?/.test(line)){const node=directional(document.createElement("blockquote")),parts=[];while(index<lines.length&&/^\s{0,3}>\s?/.test(lines[index]))parts.push(lines[index++].replace(/^\s{0,3}>\s?/,""));appendInline(node,parts.join(" "));container.append(node);continue;}
    const parts=[];while(index<lines.length&&!startsBlock(lines,index))parts.push(lines[index++].trim());const paragraph=directional(document.createElement("p"));appendInline(paragraph,parts.join(" "));container.append(paragraph);
  }
  return container;
}
