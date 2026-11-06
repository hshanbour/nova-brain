import * as T from './vendor/three.module.min.js';
// Paired landmarks traced along fine locks in the original and frontal artwork.
// Each station gives oblique x, frontal x, shared image y, and half width.
// Solve its depth in the same orthographic cameras as the bust. Eight-sided
// bevels have a real rear surface and turn with the same pivot as the skull.
const paths=[
 [[586,586,473,8],[585,522,611,18],[597,478,710,20],[579,426,821,20],[511,372,884,23],[420,282,903,27],[323,186,837,17],[220,129,768,3]],
 [[437,455,480,2],[420,429,524,4],[396,386,571,4],[355,328,616,6],[295,261,665,10],[208,168,704,13],[112,71,728,18],[-5,-28,765,4]],
 [[276,258,414,6],[251,231,493,10],[245,208,532,13],[278,231,579,9],[330,284,609,8],[418,368,650,5],[512,453,686,4],[600,540,739,1]],
 [[190,153,683,2],[203,157,743,5],[241,183,801,9],[301,237,848,15],[366,293,882,20],[470,388,920,18],[595,515,944,11],[684,599,971,4],[792,690,1041,1]],
 [[29,40,109,2],[86,100,132,12],[149,165,148,12],[217,236,157,6],[287,301,166,2]],
 [[1088,1035,115,2],[1147,1089,179,5],[1220,1164,237,8],[1247,1208,301,5],[1234,1218,359,12],[1197,1183,390,12],[1132,1123,428,4],[1083,1070,470,1]],
];
export function prismLocks(){
 const C=Math.cos(34*Math.PI/180),S=Math.sin(34*Math.PI/180),group=new T.Group();
 for(const keys of paths){
  const path=new T.CatmullRomCurve3(keys.map(([o,x,y])=>new T.Vector3(x,y,(o-760-C*(x-760))/S)),false,'centripetal');
  const pos=[],uv=[],front=[],seen=[],idx=[],N=(keys.length-1)*6,K=8;
  for(let i=0;i<=N;i++){const u=i/N,p=path.getPoint(u),d=path.getTangent(u),l=Math.hypot(d.x,d.y)||1;
   const j=Math.min(keys.length-2,Math.floor(u*(keys.length-1))),t=u*(keys.length-1)-j;
   const width=T.MathUtils.lerp(keys[j][3],keys[j+1][3],t);
   for(let k=0;k<K;k++){const theta=k*2*Math.PI/K,side=width*Math.cos(theta);const x=p.x-d.y/l*side,y=p.y+d.x/l*side,z=p.z+width*.18*Math.sin(theta)+side*.18;
    pos.push((x-760)/400,(600-y)/400,z/400);
    uv.push((760+C*(x-760)+S*z)/1312,y/1199);front.push(x/1312,y/1199);seen.push(1,1);
    if(i<N){let a=i*K+k,b=i*K+(k+1)%K;idx.push(a,b,b+K,a,b+K,a+K);}
   }
  }
  const g=new T.BufferGeometry();for(const [key,a,size] of [['position',pos,3],['uv',uv,2],['uv1',front,2],['uv2',seen,2]])g.setAttribute(key,new T.Float32BufferAttribute(a,size));g.setIndex(idx);g.computeVertexNormals();group.add(new T.Mesh(g));
 }
 return group;
}
