// Parses a persona's [SHOW_CHART: type | title | data] payload.
//
//   type  — line | area | bar | pie
//   title — heading text
//   data  — "label:value, label:value, ..."  (single series)
//           or "A=x:1,y:2; B=x:3,y:4"        (multi series)

function parsePoints(s){
  const out=[];
  for(const pair of String(s||'').split(',')){
    const i=pair.lastIndexOf(':');
    if(i<0)continue;
    const label=pair.slice(0,i).trim();
    const v=parseFloat(pair.slice(i+1).replace(/[^0-9.eE+-]/g,''));
    if(!isNaN(v))out.push({label,value:v});
  }
  return out;
}

export function parseChartSpec(raw){
  const parts=String(raw||'').split('|');
  const type=(parts[0]||'line').trim().toLowerCase();
  const title=(parts[1]||'').trim();
  const dataStr=parts.slice(2).join('|').trim();
  const series=[];
  const firstSeg=dataStr.split(';')[0]||'';
  const multi=dataStr.includes(';')||/^[^,:]+=/.test(firstSeg);
  if(multi){
    for(const seg of dataStr.split(';')){
      const eq=seg.indexOf('=');
      if(eq<0)continue;
      const pts=parsePoints(seg.slice(eq+1));
      if(pts.length)series.push({name:seg.slice(0,eq).trim(),points:pts});
    }
  }
  if(!series.length){
    const pts=parsePoints(dataStr);
    if(pts.length)series.push({name:title||'series',points:pts});
  }
  return{
    type:['line','area','bar','pie'].includes(type)?type:'line',
    title,
    series,
    valid:series.length>0,
  };
}
