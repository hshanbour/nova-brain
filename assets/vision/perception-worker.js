// Classic worker: the WASM loader uses importScripts. Frames never leave the browser.
let hand, objects;
async function initialise() {
  const {FilesetResolver, HandLandmarker, ObjectDetector}=await import('./vision_bundle.mjs');
  const wasm=await FilesetResolver.forVisionTasks('/assets/vision/wasm');
  const options=(model, task)=>({baseOptions:{modelAssetPath:'/assets/vision/'+model,delegate:'CPU'},runningMode:'VIDEO',...task});
  hand=await HandLandmarker.createFromOptions(wasm,options('hand.task',{numHands:1}));
  objects=await ObjectDetector.createFromOptions(wasm,options('object.tflite',{scoreThreshold:.52,maxResults:6}));
}
self.onmessage=async({data})=>{
  try {
    if(data.type==='init'){await initialise();postMessage({type:'ready'});return;}
    const {frame,time}=data;
    try {
      const {landmarks}=hand.detectForVideo(frame,time);
      const {detections}=objects.detectForVideo(frame,time);
      const boxes=detections.map(({categories,boundingBox:b})=>({name:categories[0].categoryName,score:categories[0].score,x:(b.originX+b.width/2)/frame.width,y:(b.originY+b.height/2)/frame.height,w:b.width/frame.width,h:b.height/frame.height}));
      postMessage({type:'observation',time,boxes,points:landmarks[0]?.map(p=>({x:p.x,y:p.y}))||[]});
    } finally {frame.close();}
  }catch{postMessage({type:'error'});}
};
