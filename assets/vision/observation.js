const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export function interpret({boxes=[],points=[],time}) {
  const objects=boxes.map(b=>({label:b.name,position:b.x<.36?'image left':b.x>.64?'image right':'centre'}));
  const person=boxes.find(b=>b.name==='person');
  let gesture=null,pointedObject=null;
  if(points.length===21){
    const extended=[8,12,16,20].map(i=>distance(points[i],points[0])>1.14*distance(points[i-2],points[0]));
    if(extended[0]&&extended.slice(1).every(x=>!x)){
      gesture='index finger extended';
      const p=points[8],dx=p.x-points[6].x,dy=p.y-points[6].y,m=Math.hypot(dx,dy);
      if(m>.015){
        const targets=boxes.filter(b=>b.name!=='person').map(b=>{const vx=b.x-p.x,vy=b.y-p.y;return {name:b.name,a:(vx*dx+vy*dy)/m,miss:Math.abs(vx*dy-vy*dx)/m,span:Math.min(.14,Math.max(b.w,b.h)*.5)};})
        .filter(t=>t.a>=0&&t.a<.65&&t.miss<t.span).sort((a,b)=>a.miss-b.miss);
        if(targets.length===1)pointedObject=targets[0].name;
      }
    }else if(extended.every(Boolean))gesture='open palm';
    else gesture='hand visible';
  }
  return {time,objects,gesture,possiblePointingTarget:pointedObject,personPosition:person?person.x:null};
}
export function currentScene(observation,now){return observation&&now-observation.time<2500?{observed:true,objects:observation.objects,gesture:observation.gesture,possiblePointingTarget:observation.possiblePointingTarget}:{observed:false};}
