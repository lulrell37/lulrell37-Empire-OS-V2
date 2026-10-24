// Rich Telegram output for the persona bots: clickable links and formatting in
// text, plus photos, generated images, diagrams, charts and files.
//
// Text: replies are written in light markdown and sent as Telegram HTML
// (parse_mode HTML) — [label](url) becomes a tappable link, **bold**, _italic_,
// `code` and ``` blocks render. A chunk Telegram rejects is resent as plain text.
//
// Media tags (a persona emits them in its reply; they're stripped from the text
// and sent after it, in order):
//   [SEND_PHOTO: url | caption]        an image from the web
//   [SEND_FILE: url | caption]         any file (PDF, CSV, zip…) as a document
//   [SEND_VIDEO: url | caption] / [SEND_AUDIO: url | caption]
//   [GENERATE_IMAGE: prompt]           AI image (OpenAI gpt-image-1, xAI fallback)
//   [DIAGRAM: mermaid source]          flowchart / sequence / mind map… as a PNG
//   [CHART: Chart.js config JSON]      bar / line / pie… as a PNG (QuickChart)
//   [SEND_LOCATION: lat | lon]         a map pin
// A markdown image in the reply — ![alt](url) — is sent as a photo too.

const MEDIA_TAGS = new Set(['SEND_PHOTO', 'SEND_IMAGE', 'SEND_FILE', 'SEND_DOCUMENT', 'SEND_VIDEO', 'SEND_AUDIO',
  'GENERATE_IMAGE', 'DIAGRAM', 'CHART', 'SEND_LOCATION']);

// --- text -------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// Light markdown -> Telegram HTML. Code is pulled out first so nothing inside it
// gets formatted; everything else is escaped before tags are added back.
function toTelegramHtml(text) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = String(text || '');
  s = s.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_, code) => hold(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => hold(`<a href="${escAttr(url)}">${esc(label)}</a>`));
  s = esc(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

// What the voice note reads: link labels instead of markdown, no raw URLs, no
// markdown punctuation.
function forSpeech(text) {
  return String(text || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_~`#]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Markdown images in the reply become photos; returns the text without them.
function pullMarkdownImages(text) {
  const media = [];
  const out = String(text || '').replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt, url) => {
    media.push({ name: 'SEND_PHOTO', url, caption: alt });
    return '';
  });
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), media };
}

// --- media ------------------------------------------------------------------

const splitArg = (arg) => {
  const i = String(arg).indexOf('|');
  return i < 0 ? [String(arg).trim(), ''] : [arg.slice(0, i).trim(), arg.slice(i + 1).trim()];
};

// Tags from a reply -> media items, deduped, in order.
function mediaFromTags(tags) {
  const out = [];
  const seen = new Set();
  for (const { name, arg } of tags) {
    if (!MEDIA_TAGS.has(name) || !arg) continue;
    const key = `${name}:${arg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (name === 'GENERATE_IMAGE' || name === 'DIAGRAM' || name === 'CHART') out.push({ name, arg });
    else {
      const [url, caption] = splitArg(arg);
      out.push({ name, url, caption });
    }
  }
  return out;
}

async function generateImage(prompt) {
  const errs = [];
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const d = await res.json();
      const img = (d.data || [])[0] || {};
      if (img.b64_json) return Buffer.from(img.b64_json, 'base64');
      if (img.url) return img.url;
      throw new Error('openai: no image returned');
    } catch (e) { errs.push(e.message); }
  }
  if (process.env.XAI_API_KEY) {
    try {
      const res = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.XAI_API_KEY}` },
        body: JSON.stringify({ model: 'grok-2-image', prompt, n: 1, response_format: 'b64_json' }),
      });
      if (!res.ok) throw new Error(`xai ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const d = await res.json();
      const img = (d.data || [])[0] || {};
      if (img.b64_json) return Buffer.from(img.b64_json, 'base64');
      if (img.url) return img.url;
      throw new Error('xai: no image returned');
    } catch (e) { errs.push(e.message); }
  }
  throw new Error(errs.length ? errs.join(' | ') : 'no image provider (set OPENAI_API_KEY or XAI_API_KEY)');
}

// Mermaid -> PNG. Kroki first, mermaid.ink as the fallback.
async function renderDiagram(src) {
  const code = String(src).replace(/^```(?:mermaid)?\s*|\s*```$/g, '').trim();
  const errs = [];
  try {
    const res = await fetch('https://kroki.io/mermaid/png', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: code });
    if (!res.ok) throw new Error(`kroki ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) { errs.push(e.message); }
  try {
    const b64 = Buffer.from(code, 'utf8').toString('base64url');
    const res = await fetch(`https://mermaid.ink/img/${b64}?type=png&bgColor=white`);
    if (!res.ok) throw new Error(`mermaid.ink ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) { errs.push(e.message); }
  throw new Error(`couldn't render the diagram (${errs.join(' | ')})`);
}

async function renderChart(config) {
  let chart;
  try { chart = JSON.parse(config); } catch { chart = String(config); } // QuickChart also takes JS-ish config strings
  const res = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chart, width: 900, height: 540, format: 'png', backgroundColor: 'white', version: '4' }),
  });
  if (!res.ok) throw new Error(`quickchart ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return Buffer.from(await res.arrayBuffer());
}

// Send each item; returns a warning line per failure (nothing for successes —
// the media itself is the receipt).
async function sendMedia(bot, chatId, items) {
  const warnings = [];
  for (const it of items) {
    try {
      switch (it.name) {
        case 'GENERATE_IMAGE':
          await bot.sendChatAction(chatId, 'upload_photo');
          await bot.sendFile(chatId, 'photo', await generateImage(it.arg), { caption: it.arg.slice(0, 1000) });
          break;
        case 'DIAGRAM':
          await bot.sendChatAction(chatId, 'upload_photo');
          await bot.sendFile(chatId, 'photo', await renderDiagram(it.arg), { filename: 'diagram.png' });
          break;
        case 'CHART':
          await bot.sendChatAction(chatId, 'upload_photo');
          await bot.sendFile(chatId, 'photo', await renderChart(it.arg), { filename: 'chart.png' });
          break;
        case 'SEND_LOCATION': {
          const lat = parseFloat(it.url);
          const lon = parseFloat(it.caption);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('needs "lat | lon"');
          await bot.tg('sendLocation', { chat_id: chatId, latitude: lat, longitude: lon });
          break;
        }
        default: {
          const kind = { SEND_PHOTO: 'photo', SEND_IMAGE: 'photo', SEND_VIDEO: 'video', SEND_AUDIO: 'audio' }[it.name] || 'document';
          if (!/^https?:\/\//i.test(it.url)) throw new Error(`not a link: ${it.url.slice(0, 80)}`);
          await bot.sendChatAction(chatId, kind === 'photo' ? 'upload_photo' : kind === 'video' ? 'upload_video' : 'upload_document');
          await bot.sendFile(chatId, kind, it.url, { caption: it.caption });
        }
      }
    } catch (e) {
      console.error(`tg ${bot.personaId} ${it.name}:`, e.message);
      warnings.push(`${it.name.toLowerCase().replace(/_/g, ' ')} failed: ${e.message.slice(0, 200)}`);
    }
  }
  return warnings;
}

// Prompt block, shared by A.R.A. and every other persona's tool list.
const MEDIA_TOOLS = ` LINKS, PHOTOS, DIAGRAMS, FILES — there's no limit on what you can show him here:
 - Links: write [label](https://…) and it's a tappable link; bare URLs are tappable too. Give him the real link whenever you mention a site, article, product, place or source — from a search result, never a made-up URL. **bold**, _italic_ and \`code\` render.
 - [SEND_PHOTO: image url | caption] — a real image from the web (a product, a place, a person, a screenshot). Use direct image URLs from search results.
 - [GENERATE_IMAGE: detailed prompt] — create an image (concept art, a logo idea, a mockup, a visual, anything he asks to see).
 - [DIAGRAM: mermaid source] — a flowchart, sequence, org chart, mind map, timeline or gantt, rendered as an image. Write valid Mermaid (e.g. "flowchart TD; A[Lead] --> B[Call] --> C[Close]"); no literal ] closing the tag early — use quotes or () in labels when needed.
 - [CHART: Chart.js config as JSON] — a bar/line/pie/doughnut chart rendered as an image, e.g. {"type":"bar","data":{"labels":["Jan","Feb"],"datasets":[{"label":"Revenue","data":[1200,1900]}]}}.
 - [SEND_FILE: file url | caption] / [SEND_VIDEO: url | caption] / [SEND_AUDIO: url | caption] — send a document (PDF, CSV…), video or audio by link.
 - [SEND_LOCATION: latitude | longitude] — drop a map pin.
 Several in one reply is fine; they arrive right after your text. Don't say "I can't send images/links" — you can.`;

module.exports = { MEDIA_TAGS, MEDIA_TOOLS, toTelegramHtml, forSpeech, pullMarkdownImages, mediaFromTags, sendMedia };
