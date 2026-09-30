import test from "node:test";
import assert from "node:assert/strict";
import {renderSafeMarkdown} from "../assets/message-markdown.js";

class Node{
  constructor(type,ownerDocument,text=""){this.type=type;this.ownerDocument=ownerDocument;this.text=text;this.children=[];this.attributes={};this.dataset={};this.className="";this.textContent=text;this.classList={add:value=>{this.className=[this.className,value].filter(Boolean).join(" ");}};}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=[...items];}
  setAttribute(name,value){this.attributes[name]=String(value);}
}
function fixture(){const document={createTextNode:text=>new Node("#text",document,String(text)),createElement:tag=>new Node(tag,document)};return{document,container:new Node("div",document)};}
function descendants(node,type){return node.children.flatMap(child=>[...(child.type===type?[child]:[]),...descendants(child,type)]);}
function text(node){return node.type==="#text"?node.text:String(node.textContent||"")+node.children.map(text).join("");}

test("assistant Markdown renders semantic headings, paragraphs, lists, emphasis and safe citations",()=>{
  const {container}=fixture();renderSafeMarkdown(container,"# Market report\n\nA **clear** answer with [Official evidence](https://example.com/report).\n\n- First\n- Second\n\n1. One\n2. Two");
  assert.equal(descendants(container,"h1").length,1);assert.equal(descendants(container,"p").length,1);assert.equal(descendants(container,"strong").length,1);assert.equal(descendants(container,"ul").length,1);assert.equal(descendants(container,"ol").length,1);
  const link=descendants(container,"a")[0];assert.equal(link.href,"https://example.com/report");assert.equal(link.target,"_blank");assert.equal(link.rel,"noopener noreferrer");assert.equal(link.className,"message-citation");
});

test("comparison tables render as accessible responsive tables",()=>{
  const {container}=fixture();renderSafeMarkdown(container,"| Product | Price |\n| --- | ---: |\n| Nova | **£10** |");
  const wrap=descendants(container,"div")[0],table=descendants(container,"table")[0],headers=descendants(container,"th"),cells=descendants(container,"td");
  assert.equal(wrap.className,"markdown-table-wrap");assert.equal(wrap.attributes.role,"region");assert.equal(wrap.attributes.tabindex,"0");assert.ok(table);assert.equal(headers.length,2);assert.equal(headers[1].dataset.align,"right");assert.equal(cells.length,2);assert.equal(descendants(cells[1],"strong").length,1);
});

test("Arabic and mixed-language blocks use automatic bidi direction without changing content",()=>{
  const {container}=fixture();renderSafeMarkdown(container,"## مقارنة الأسعار\n\nأفضل خطة هي Fresha بسعر £10 عبر https://example.com.\n\n- إدارة الفريق Team management");
  for(const node of [...descendants(container,"h2"),...descendants(container,"p"),...descendants(container,"li")])assert.equal(node.attributes.dir,"auto");
  assert.match(text(container),/Fresha/);assert.match(text(container),/£10/);assert.match(text(container),/Team management/);
});

test("raw HTML, scripts and unsafe links remain inert text",()=>{
  const {container}=fixture();renderSafeMarkdown(container,"<script>alert(1)</script> [unsafe](javascript:alert(1)) [local](http://127.0.0.1)");
  assert.equal(descendants(container,"script").length,0);assert.equal(descendants(container,"a").length,0);assert.match(text(container),/<script>alert\(1\)<\/script>/);assert.match(text(container),/javascript:alert/);
});

test("long persisted-report shape remains structured instead of one raw text block",()=>{
  const {container}=fixture(),report="# UK business software research report\n\n## Barber booking systems\n\nThe comparison is based on **current public evidence**.\n\n| System | Pricing | Reminders |\n| --- | --- | --- |\n| Booksy | Public plan | Included |\n\n## Missed-call recovery\n\n- Competitor one\n- Competitor two\n\n[Official source](https://example.com/source)";renderSafeMarkdown(container,report);
  assert.equal(descendants(container,"h1").length,1);assert.equal(descendants(container,"h2").length,2);assert.equal(descendants(container,"table").length,1);assert.equal(descendants(container,"li").length,2);assert.equal(descendants(container,"a").length,1);assert.doesNotMatch(text(descendants(container,"h2")[0]),/^##/);
});

test("legacy flattened Markdown report cannot turn the entire message into one giant heading",()=>{
  const {container}=fixture(),legacy=`# UK business software research report ${"pricing and evidence ".repeat(80)} ## Missed-call recovery | Product | Price |`;
  renderSafeMarkdown(container,legacy);
  assert.equal(descendants(container,"h1").length,0);assert.equal(descendants(container,"p").length,1);assert.equal(text(container),legacy);
});
