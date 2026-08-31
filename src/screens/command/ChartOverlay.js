// A chart a persona put on the orb screen. Fills the visualization area; the
// orb comes back when this is dismissed. Hand-rolled react-native-svg so it
// carries no new dependency and matches the dark-gold look.
import React,{useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView}from 'react-native';
import Svg,{Polyline,Path,Rect,Line,Circle,Text as SvgText,G}from 'react-native-svg';

const EXTRA=['#5B8DEF','#5FA779','#D9A441','#C77DBB','#E0555F'];

export default function ChartOverlay({spec,accent='#E8C98A',onClose}){
  const[box,setBox]=useState({w:320,h:240});
  const type=spec?.type||'line';
  const series=spec?.series||[];

  return(
    <View style={s.wrap}>
      <View style={s.head}>
        <Text style={[s.title,{color:accent}]} numberOfLines={1}>{spec?.title||'CHART'}</Text>
        <TouchableOpacity style={s.close} onPress={onClose}><Text style={s.closeT}>CLOSE ✕</Text></TouchableOpacity>
      </View>
      <View style={s.canvas} onLayout={e=>{const{width,height}=e.nativeEvent.layout;setBox({w:width,h:height});}}>
        {series.length?(
          type==='pie'
            ? <Pie series={series} box={box} accent={accent}/>
            : <XY type={type} series={series} box={box} accent={accent}/>
        ):(
          <Text style={s.empty}>No chart data.</Text>
        )}
      </View>
      {series.length>1&&(
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.legend}>
          {series.map((se,i)=>(
            <View key={se.name+i} style={s.legItem}>
              <View style={[s.legDot,{backgroundColor:i===0?accent:EXTRA[(i-1)%EXTRA.length]}]}/>
              <Text style={s.legT}>{se.name}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function niceBounds(min,max){
  if(min===max){return[min-1,max+1];}
  const pad=(max-min)*0.08;
  return[min-pad,max+pad];
}

function XY({type,series,box,accent}){
  const PAD={l:44,r:12,t:12,b:26};
  const w=Math.max(80,box.w),h=Math.max(80,box.h);
  const iw=w-PAD.l-PAD.r,ih=h-PAD.t-PAD.b;
  const n=Math.max(...series.map(se=>se.points.length));
  const allV=series.flatMap(se=>se.points.map(p=>p.value));
  let lo=Math.min(...allV),hi=Math.max(...allV);
  if(type==='bar'||type==='area')lo=Math.min(lo,0);
  [lo,hi]=niceBounds(lo,hi);
  const x=i=>PAD.l+(n<=1?iw/2:(i/(n-1))*iw);
  const y=v=>PAD.t+ih-((v-lo)/(hi-lo))*ih;
  const color=i=>i===0?accent:EXTRA[(i-1)%EXTRA.length];
  const labels=(series[0]?.points||[]).map(p=>p.label);
  const grid=[0,0.25,0.5,0.75,1];

  return(
    <Svg width={w} height={h}>
      {grid.map((g,i)=>{
        const gy=PAD.t+ih*g,val=hi-(hi-lo)*g;
        return(
          <G key={i}>
            <Line x1={PAD.l} y1={gy} x2={w-PAD.r} y2={gy} stroke="#1c1c1c" strokeWidth={1}/>
            <SvgText x={PAD.l-6} y={gy+3} fill="#555" fontSize={8} fontFamily="monospace" textAnchor="end">{fmt(val)}</SvgText>
          </G>
        );
      })}
      {labels.map((lb,i)=>((i===0||i===labels.length-1||labels.length<=6)&&
        <SvgText key={'x'+i} x={x(i)} y={h-8} fill="#555" fontSize={8} fontFamily="monospace" textAnchor="middle">{lb}</SvgText>
      ))}

      {series.map((se,si)=>{
        const c=color(si);
        if(type==='bar'){
          const bw=Math.max(2,(iw/Math.max(1,n))/series.length*0.7);
          return se.points.map((p,i)=>{
            const bx=x(i)-((series.length*bw)/2)+si*bw;
            const by=y(p.value),base=y(Math.max(lo,0));
            return <Rect key={si+'-'+i} x={bx} y={Math.min(by,base)} width={bw} height={Math.abs(base-by)||1} fill={c} opacity={0.9}/>;
          });
        }
        const pts=se.points.map((p,i)=>`${x(i)},${y(p.value)}`).join(' ');
        if(type==='area'){
          const d=`M ${x(0)},${y(Math.max(lo,0))} L ${se.points.map((p,i)=>`${x(i)},${y(p.value)}`).join(' L ')} L ${x(se.points.length-1)},${y(Math.max(lo,0))} Z`;
          return <G key={si}><Path d={d} fill={c} opacity={0.16}/><Polyline points={pts} fill="none" stroke={c} strokeWidth={2}/></G>;
        }
        return(
          <G key={si}>
            <Polyline points={pts} fill="none" stroke={c} strokeWidth={2}/>
            {se.points.map((p,i)=><Circle key={i} cx={x(i)} cy={y(p.value)} r={2.4} fill={c}/>)}
          </G>
        );
      })}
    </Svg>
  );
}

function Pie({series,box,accent}){
  const pts=series[0]?.points||[];
  const w=Math.max(80,box.w),h=Math.max(80,box.h);
  const cx=w/2,cy=h/2,r=Math.min(w,h)/2-16;
  const total=pts.reduce((a,p)=>a+Math.max(0,p.value),0)||1;
  let a0=-Math.PI/2;
  const colors=[accent,...EXTRA];
  return(
    <Svg width={w} height={h}>
      {pts.map((p,i)=>{
        const frac=Math.max(0,p.value)/total;
        const a1=a0+frac*Math.PI*2;
        const large=frac>0.5?1:0;
        const d=`M ${cx},${cy} L ${cx+r*Math.cos(a0)},${cy+r*Math.sin(a0)} A ${r},${r} 0 ${large} 1 ${cx+r*Math.cos(a1)},${cy+r*Math.sin(a1)} Z`;
        const mid=(a0+a1)/2;a0=a1;
        return(
          <G key={i}>
            <Path d={d} fill={colors[i%colors.length]} opacity={0.9}/>
            {frac>0.05&&<SvgText x={cx+(r*0.65)*Math.cos(mid)} y={cy+(r*0.65)*Math.sin(mid)+3} fill="#000" fontSize={8} fontFamily="monospace" textAnchor="middle">{p.label}</SvgText>}
          </G>
        );
      })}
    </Svg>
  );
}

function fmt(v){
  const a=Math.abs(v);
  if(a>=1e6)return(v/1e6).toFixed(1)+'M';
  if(a>=1e3)return(v/1e3).toFixed(1)+'k';
  if(a>=100)return v.toFixed(0);
  if(a>=1)return v.toFixed(1);
  return v.toFixed(2);
}

const s=StyleSheet.create({
  wrap:{flex:1,padding:12},
  head:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',marginBottom:8},
  title:{fontFamily:'monospace',fontSize:11,fontWeight:'700',letterSpacing:2,flex:1},
  close:{borderWidth:1,borderColor:'#333',borderRadius:4,paddingHorizontal:8,paddingVertical:4},
  closeT:{fontFamily:'monospace',fontSize:8,color:'#888',letterSpacing:1},
  canvas:{flex:1,borderWidth:1,borderColor:'#141210',borderRadius:8,backgroundColor:'#060504',overflow:'hidden'},
  empty:{fontFamily:'monospace',fontSize:10,color:'#333',textAlign:'center',marginTop:40},
  legend:{flexDirection:'row',gap:14,paddingVertical:8,paddingHorizontal:2},
  legItem:{flexDirection:'row',alignItems:'center',gap:5},
  legDot:{width:8,height:8,borderRadius:4},
  legT:{fontFamily:'monospace',fontSize:8,color:'#888',letterSpacing:1},
});
