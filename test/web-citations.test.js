import test from "node:test";
import assert from "node:assert/strict";
import {appendSafeLinkedText} from "../assets/web-citations.js";
import {renderTerminalTaskReport} from "../src/autonomy/terminal-task-reporter.js";

function fixture(){
  const children=[];
  const document={createTextNode:text=>({type:"text",text}),createElement:tag=>({type:tag})};
  return{container:{ownerDocument:document,append(...items){children.push(...items);}},children};
}

test("Console renders bounded HTTPS citations as clickable safe links while leaving other text literal",()=>{
  const {container,children}=fixture();appendSafeLinkedText(container,"Evidence [Official source](https://example.com/a) remains cited.");
  const anchor=children.find(item=>item.type==="a");assert.equal(anchor.href,"https://example.com/a");assert.equal(anchor.textContent,"Official source");assert.equal(anchor.target,"_blank");assert.equal(anchor.rel,"noopener noreferrer");
});

test("Console does not turn non-HTTPS or malformed source syntax into active content",()=>{
  const {container,children}=fixture();appendSafeLinkedText(container,"[unsafe](http://127.0.0.1) <script>alert(1)</script>");
  assert.equal(children.some(item=>item.type==="a"),false);assert.match(children.map(item=>item.text||"").join(""),/<script>/);
});

test("Console renders a completed browser terminal answer's retained evidence as one clickable link",()=>{
  const url="https://developers.cloudflare.com/browser-run/get-started/",hash="c".repeat(64),message=renderTerminalTaskReport({id:"web_"+"c".repeat(32),taskType:"public_web_browser",status:"completed",metadata:{browserJob:{version:2,allowedDomains:["developers.cloudflare.com"]},browserPresentation:{version:1,requestedFields:["destination_title"]},browserResult:{status:"completed",finalUrl:url,domain:"developers.cloudflare.com",title:"Get started · Cloudflare Browser Run docs",contentHash:hash,evidence:[{text:"Prerequisites Sign up for a Cloudflare account.",source:{url,domain:"developers.cloudflare.com",title:"Cloudflare Browser Run docs",contentHash:hash}}]}}},[]),{container,children}=fixture();
  appendSafeLinkedText(container,message);const anchors=children.filter(item=>item.type==="a");assert.equal(anchors.length,1);assert.equal(anchors[0].href,url);assert.equal(anchors[0].textContent,"Cloudflare Browser Run docs");
});
