export const UNIVERSAL_SECTIONS=Object.freeze([
  {id:"overview",label:"Overview",icon:"⌂"},{id:"social",label:"Social Media",icon:"◌"},{id:"marketing",label:"Marketing",icon:"◎"},{id:"customers",label:"Customers",icon:"◇"},{id:"bookings",label:"Bookings",icon:"▣"},{id:"messages",label:"Messages",icon:"✦"},{id:"media",label:"Media",icon:"▤"},{id:"website",label:"Website",icon:"↗"},{id:"calendar",label:"Calendar",icon:"□"},{id:"reports",label:"Reports",icon:"▥"},{id:"automations",label:"Automations",icon:"⚡"},{id:"settings",label:"Settings",icon:"⚙"}
]);

export function sectionsForProject(){return UNIVERSAL_SECTIONS;}

export function projectRoute(projectId,view="overview",platform=""){const parts=["project",encodeURIComponent(projectId),encodeURIComponent(view)];if(platform)parts.push(encodeURIComponent(platform));return`#${parts.join("/")}`;}
export function parseProjectRoute(hash){const parts=String(hash||"").replace(/^#/,"").split("/");if(parts[0]!=="project"||!parts[1])return null;return{projectId:decodeURIComponent(parts[1]),view:decodeURIComponent(parts[2]||"overview"),platform:parts[3]?decodeURIComponent(parts[3]):""};}

export function platformState(status,metrics,platform){
  if(platform==="tiktok")return{connected:false,label:"Not Connected",metrics:[]};
  const connection=status?.[platform]||{},values=metrics?.[platform]||null;
  const rows=platform==="instagram"?[["Followers",values?.followers],["Media",values?.mediaCount]]:[["Followers",values?.followers],["Page likes",values?.pageLikes]];
  return{connected:connection.connected===true,label:connection.connected?"Connected":"Not Connected",metrics:rows.map(([label,value])=>({label,value:value??null}))};
}
