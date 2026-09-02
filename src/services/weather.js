// Weather for the HUD — Open-Meteo (free, no API key). Geocodes the place name
// once (cached), then fetches current conditions + today's high/low. Result is
// cached for 30 minutes so the HUD panel can poll cheaply.
import{getSetting,setSetting}from './database';

const DEFAULT_PLACE='Waldorf, MD';
const CACHE_MS=30*60*1000;
let mem=null; // { at, data }

// WMO weather codes -> short label + emoji.
const CODES={
  0:['Clear','☀️'],1:['Mostly clear','🌤️'],2:['Partly cloudy','⛅'],3:['Overcast','☁️'],
  45:['Fog','🌫️'],48:['Rime fog','🌫️'],
  51:['Light drizzle','🌦️'],53:['Drizzle','🌦️'],55:['Heavy drizzle','🌧️'],
  56:['Freezing drizzle','🌧️'],57:['Freezing drizzle','🌧️'],
  61:['Light rain','🌦️'],63:['Rain','🌧️'],65:['Heavy rain','🌧️'],
  66:['Freezing rain','🌧️'],67:['Freezing rain','🌧️'],
  71:['Light snow','🌨️'],73:['Snow','🌨️'],75:['Heavy snow','❄️'],77:['Snow grains','🌨️'],
  80:['Showers','🌦️'],81:['Showers','🌧️'],82:['Violent showers','⛈️'],
  85:['Snow showers','🌨️'],86:['Snow showers','❄️'],
  95:['Thunderstorm','⛈️'],96:['Thunderstorm','⛈️'],99:['Severe thunderstorm','⛈️'],
};
const describe=(c)=>CODES[c]||['—','🌡️'];

async function geo(){
  const place=(await getSetting('weather_place',DEFAULT_PLACE)).trim()||DEFAULT_PLACE;
  const cachedRaw=await getSetting('weather_geo','');
  try{
    const c=JSON.parse(cachedRaw);
    if(c&&c.place===place&&c.lat!=null)return c;
  }catch{}
  const res=await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name='+encodeURIComponent(place));
  if(!res.ok)throw new Error('geocode failed');
  const d=await res.json();
  const g=(d.results||[])[0];
  if(!g)throw new Error('place not found: '+place);
  const out={place,label:[g.name,g.admin1].filter(Boolean).join(', '),lat:g.latitude,lon:g.longitude};
  await setSetting('weather_geo',JSON.stringify(out));
  return out;
}

export function resetWeather(){mem=null;}

export async function getWeather({force=false}={}){
  if(!force&&mem&&Date.now()-mem.at<CACHE_MS)return mem.data;
  try{
    const g=await geo();
    const url=`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}`
      +`&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m`
      +`&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max`
      +`&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&forecast_days=1`;
    const res=await fetch(url);
    if(!res.ok)throw new Error('forecast failed');
    const d=await res.json();
    const cur=d.current||{},day=d.daily||{};
    const[desc,icon]=describe(cur.weather_code);
    const data={
      place:g.label||g.place,
      tempF:Math.round(cur.temperature_2m),
      feelsF:Math.round(cur.apparent_temperature),
      desc,icon,
      hiF:Math.round((day.temperature_2m_max||[])[0]),
      loF:Math.round((day.temperature_2m_min||[])[0]),
      windMph:Math.round(cur.wind_speed_10m),
      rainPct:(day.precipitation_probability_max||[])[0]??null,
      at:Date.now(),
    };
    mem={at:Date.now(),data};
    return data;
  }catch(e){
    return mem?.data||null;
  }
}
