// Model-space pigment and contour fields; no extra face meshes or floating lines.
// Coordinates are for the existing normalized (height 3) Meshy bust only.
export const CONTOUR_LIGHTING = /* glsl */ `
if(uContour>.5){
  float ax=abs(vP.x);
  float faceFront=smoothstep(.30,.56,vP.z)*(1.-smoothstep(.54,.68,ax));
  float eyeX=(ax-.265)/.185;
  float eyeMid=2.135+(ax-.265)*.15;
  float almond=pow(max(0.,1.-eyeX*eyeX),.72);
  float upper=eyeMid+.091*almond;
  float lower=eyeMid-.055*almond;
  float eyeEnds=1.-smoothstep(.91,1.04,abs(eyeX));
  float interiorEye=smoothstep(lower-.006,lower+.014,vP.y)*
    (1.-smoothstep(upper-.012,upper+.006,vP.y))*eyeEnds*faceFront;
  float upperLid=exp(-pow((vP.y-upper)/.0085,2.))*eyeEnds*faceFront;
  float lowerLid=exp(-pow((vP.y-lower)/.0055,2.))*eyeEnds*faceFront;

  // Bend rows around the orbital openings; lift the same cheek-to-cheek
  // contours over the projecting nose, not a screen-space stripe overlay.
  float dy=vP.y-eyeMid;
  float orbitBend=.068*(dy/(abs(dy)+.048))*exp(-pow(eyeX/.98,4.))*exp(-pow(dy/.235,2.));
  float noseLift=.085*exp(-pow(vP.x/.14,2.))*exp(-pow((vP.y-1.97)/.36,2.));
  float collar=.035*cos(vP.x*3.2)*exp(-pow((vP.y-.75)/.29,2.));
  float chestFall=.075*exp(-pow(vP.x/.52,2.))*(1.-smoothstep(.94,1.36,vP.y));
  float contourH=vP.y-vP.z*.18-faceFront*(noseLift+orbitBend)-collar+chestFall;
  float field=contourH*30.5+sin(contourH*5.4)*.15;
  float band=floor(field);
  float edgeAA=max(fwidth(field)*.55,.025);
  float line=1.-smoothstep(.058-edgeAA,.058+edgeAA,abs(fract(field)-.5));
  float brightness=.40+.60*pow(.5+.5*sin(band*2.399),2.);
  // Soft irregular interruptions leave quieter stretches, rather than a stack
  // of identically bright rings. Everything is fixed to model coordinates.
  float breaks=.70+.30*smoothstep(-.35,.4,sin(vP.x*23.+vP.z*15.+band*1.73));
  float contour=line*brightness*breaks*(1.-interiorEye);
  float jaw=exp(-pow((vP.y-(1.40+.28*ax))/.075,2.))*faceFront;
  float collarBone=exp(-pow((vP.y-(.80-.19*ax))/.075,2.))*smoothstep(.06,.40,vP.z);
  float definition=1.+jaw*.48+collarBone*.38;
  float breathing=1.+uEnergy*.10;
  vec3 contourRGB=emerald*(contour*1.85*definition+fine*1.65)*breathing;
  float contourAlpha=.025+contour*.66+rim*.36;
  float goldRows=exp(-pow((band-53.)/.26,2.))+exp(-pow((band-55.)/.26,2.))+exp(-pow((band-57.)/.26,2.));
  float cheeks=faceFront*smoothstep(1.68,1.78,vP.y)*(1.-smoothstep(2.08,2.16,vP.y));
  float bodyAccent=(1.-smoothstep(.8,1.15,vP.y))*smoothstep(.80,.97,.5+.5*sin(band*2.399));
  float warmZone=min(1.,goldRows*cheeks+bodyAccent*.26)*(1.-interiorEye);
  float warm=line*breaks*warmZone;
  contourRGB=mix(contourRGB,champagne*line*breaks*(2.0+uEnergy*.22),warmZone*.93);
  contourAlpha+=warm*.34;

  // An abstract dark opening with distinct upper/lower edges. The existing
  // surface provides perspective and occlusion in the three-quarter view.
  contourRGB*=1.-interiorEye*.97;
  contourAlpha=mix(contourAlpha,.965,interiorEye);
  contourRGB+=emerald*(upperLid*1.45+lowerLid*.67);
  contourAlpha=max(contourAlpha,upperLid*.76+lowerLid*.48);
  rgb=mix(contourRGB,rgb,hairZone);
  alpha=mix(contourAlpha,alpha,hairZone);

  // Pigment is sampled from the original lock texture. Gold stays inside the
  // solid hairstyle envelope; loose outer mesh loops receive emerald only.
  float envelope=length(vec3(vP.x/.65,(vP.y-2.43)/.68,(vP.z-.04)/.79));
  float embedded=1.-smoothstep(.94,1.10,envelope);
  // Thin flyaway loops sweep through normals across only a pixel or two.
  // Keep their silhouette emerald instead of lighting them as gold wires.
  float solidLock=1.-smoothstep(.12,.40,length(fwidth(n)));
  float hairPigment=smoothstep(.048,.105,lockTone)*embedded*uHair*solidLock*(1.-smoothstep(.24,.65,rim));
  vec3 lockEmerald=emerald*(.075+.30*crownLight+.12*fill);
  vec3 lockGold=amber*(.40+.60*crownLight)+champagne*(.28*warmBody+.65*gloss+.18*broadGloss);
  vec3 lockColour=mix(lockEmerald,lockGold,hairPigment*.88)+emerald*fine*.55;
  rgb=mix(rgb,lockColour,hairZone);
  alpha=mix(alpha,.23+crownLight*.14+hairPigment*.37+rim*.19,hairZone);
}
`;
