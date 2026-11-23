// R.O.G.U.E.'s auto clips: the YouTube channels he picks are watched, and every
// new upload is run through the clip scan (server/clipScan.js) on its own; the
// finished clips reach him on Telegram from A.R.A. like an app-started scan.
//   - new uploads come off each channel's public RSS feed (no key, no quota),
//     checked every 20 min
//   - a channel added now starts from its NEXT upload, never its back catalog
//   - skipped: Shorts and anything under AUTO_CLIP_MIN_MIN (3) minutes, a stream
//     that is still live (tried again once it's over), anything past the clip
//     scan's own length cap
//   - YouTube blocking the server as a bot doesn't drop the video: it stays
//     queued (told once, not counted toward the day), up to BLOCK_HOLD_MS, and
//     goes as soon as YOUTUBE_COOKIES is set; ones that failed that way earlier
//     are put back too
//   - AUTO_CLIP_MAX_PER_DAY (3) scans a day at most, since each one bills
//     Whisper and Claude; the rest wait for the next day, oldest first
//   - topic filter (owner, 2026-11-22): [AUTO_CLIP: channel | topic] watches a channel
//     for one subject only (e.g. GTA); an upload whose title or tags don't mention it
//     is skipped as "off topic" (not counted toward the day). [AUTO_CLIP_TOPIC:
//     channel | topic] changes it, "any" clears it. Known topics expand to aliases
//     (`ALIASES`); several can be given with commas, any one matches.
// Tags: [AUTO_CLIP: channel or video link (| topic)], [AUTO_CLIP_TOPIC], [AUTO_CLIP_OFF: channel],
// [AUTO_CLIP_LIST] (R.O.G.U.E., A.R.A., J.A.R.V.I.S.). AUTO_CLIP=off stops it.
// State: app_settings.auto_clip. node server/scripts/test-auto-clip.js.
const { getSetting, setSetting } = require('./syncStore');
const clip = require('./clipScan');

const KEY = 'auto_clip';
const MAX_PER_DAY = Number(process.env.AUTO_CLIP_MAX_PER_DAY || 3);
const MIN_SEC = Number(process.env.AUTO_CLIP_MIN_MIN || 3) * 60;
const MAX_CHANNELS = 10;
const BLOCK_HOLD_MS = 3 * 864e5;

function enabled() { return String(process.env.AUTO_CLIP || '').toLowerCase() !== 'off'; }

async function load() {
  const raw = await getSetting(KEY, '{}').catch(() => '{}');
  let s; try { s = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw; } catch { s = {}; }
  return { channels: [], queue: [], done: [], day: '', ranToday: 0, ...(s || {}) };
}
const save = (s) => setSetting(KEY, JSON.stringify(s));
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// --- the feed (pure parsing) ---------------------------------------------------

// YouTube's channel RSS -> [{ id, title, published (ms), url }], newest first.
function parseFeed(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = (/<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(e) || [])[1];
    if (!id) continue;
    const title = ((/<title>([\s\S]*?)<\/title>/.exec(e) || [])[1] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    const published = Date.parse((/<published>([^<]+)<\/published>/.exec(e) || [])[1] || '') || 0;
    const link = (/<link rel="alternate" href="([^"]+)"/.exec(e) || [])[1] || `https://www.youtube.com/watch?v=${id}`;
    out.push({ id, title, published, url: link, short: /\/shorts\//.test(link) });
  }
  return out.sort((a, b) => b.published - a.published);
}

// Uploads newer than the channel's mark that aren't queued or done yet.
function newUploads(feed, ch, s) {
  const seen = new Set([...s.queue.map((q) => q.id), ...s.done.map((d) => d.id)]);
  return feed.filter((v) => v.published > (ch.since || 0) && !seen.has(v.id) && !v.short);
}

async function fetchFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'user-agent': 'Mozilla/5.0 (EmpireOS auto clip)' } });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  return parseFeed(await res.text());
}

// A channel link (@handle, /channel/UC…, /c/…, /user/…) or any of its video
// links -> { id, name, url }, read with yt-dlp.
async function resolveChannel(link) {
  const u = String(link || '').trim();
  const direct = /youtube\.com\/channel\/(UC[\w-]{22})/.exec(u);
  const isVideo = clip.isYouTube(u);
  const target = direct ? `https://www.youtube.com/channel/${direct[1]}/videos`
    : isVideo ? u
      : /youtube\.com\/(@[\w.-]+|c\/[\w.-]+|user\/[\w.-]+)/.test(u) ? `${u.replace(/\/+$/, '').replace(/\/(videos|streams|shorts|featured)$/, '')}/videos` : null;
  if (!target) throw new Error('needs a YouTube channel link (youtube.com/@name) or one of its videos');
  const args = ['--no-warnings', '--skip-download', '--print', '%(channel_id)s\n%(channel)s\n%(channel_url)s'];
  if (!isVideo) args.push('--playlist-items', '1');
  const out = (await clip.ytdlp([...args, target])).split('\n').map((x) => x.trim());
  if (!/^UC[\w-]{22}$/.test(out[0] || '')) throw new Error("couldn't find that channel");
  return { id: out[0], name: out[1] || out[0], url: out[2] && out[2] !== 'NA' ? out[2] : `https://www.youtube.com/channel/${out[0]}` };
}

// --- the topic filter (pure) ---------------------------------------------------

const ALIASES = {
  gta: ['gta', 'grand theft auto', 'gta5', 'gta 5', 'gta v', 'gta online', 'gta rp', 'nopixel'],
  'call of duty': ['call of duty', 'cod', 'warzone', 'modern warfare', 'black ops'],
  minecraft: ['minecraft'],
  fortnite: ['fortnite'],
  valorant: ['valorant'],
  roblox: ['roblox'],
};
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ANY = /^(any|all|everything|none|off|clear|no topic|no filter)?$/i;

// "GTA" / "gta, fortnite" -> ['gta','grand theft auto',…]; '' = no filter.
function topicTerms(topic) {
  const t = String(topic || '').trim();
  if (ANY.test(t)) return [];
  const out = new Set();
  for (const part of t.split(/[,;]|\bor\b/i).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    for (const a of ALIASES[part] || [part]) out.add(a);
  }
  return [...out];
}

// Does a video (title + tags) belong to the topic? No topic = everything.
function matchesTopic(topic, v) {
  const terms = topicTerms(topic);
  if (!terms.length) return true;
  const hay = ` ${[v.title, ...(v.tags || [])].join(' \n ').toLowerCase()} `;
  return terms.some((x) => new RegExp(`(^|[^a-z0-9])${esc(x)}([^a-z0-9]|$)`).test(hay));
}

function splitArg(arg) {
  const i = String(arg || '').lastIndexOf('|');
  return i < 0 ? { link: String(arg || '').trim(), topic: '' } : { link: arg.slice(0, i).trim(), topic: arg.slice(i + 1).trim() };
}

// --- tags ---------------------------------------------------------------------

const topicNote = (topic) => (topicTerms(topic).length ? ` Only videos about "${topic}" (title or tags) are clipped; everything else is skipped.` : '');

async function addChannel(arg) {
  const { link, topic: rawTopic } = splitArg(arg);
  const topic = topicTerms(rawTopic).length ? rawTopic : '';
  const s = await load();
  const ch = await resolveChannel(link);
  const have = s.channels.find((c) => c.id === ch.id);
  if (have) {
    if (!rawTopic) return `already watching ${ch.name}${have.topic ? ` (topic: ${have.topic})` : ''}`;
    have.topic = topic; await save(s);
    return topic ? `already watching ${ch.name}; now only "${topic}" videos get clipped.` : `already watching ${ch.name}; topic filter cleared, every video over ${MIN_SEC / 60} minutes gets clipped.`;
  }
  if (s.channels.length >= MAX_CHANNELS) return `already watching ${MAX_CHANNELS} channels — turn one off first`;
  // Start from the newest upload already out, so the back catalog isn't clipped.
  const feed = await fetchFeed(ch.id).catch(() => []);
  s.channels.push({ ...ch, since: feed.length ? feed[0].published : Date.now(), addedAt: Date.now(), ...(topic ? { topic } : {}) });
  await save(s);
  return `watching ${ch.name} (${ch.url}). Starting from its next upload: every new video over ${MIN_SEC / 60} minutes gets clipped and sent to him, ${MAX_PER_DAY} a day at most.${topicNote(topic)}`;
}

async function setTopic(arg) {
  const { link, topic: rawTopic } = splitArg(arg);
  const s = await load();
  const q = link.toLowerCase();
  const hit = s.channels.find((c) => c.name.toLowerCase() === q || c.id.toLowerCase() === q) || s.channels.find((c) => q && (c.name.toLowerCase().includes(q) || c.url.toLowerCase().includes(q.replace(/^https?:\/\/(www\.)?/, ''))));
  if (!hit) return `not watching anything matching "${link}"`;
  const topic = topicTerms(rawTopic).length ? rawTopic : '';
  if (topic) hit.topic = topic; else delete hit.topic;
  await save(s);
  return topic ? `${hit.name}: now only "${topic}" videos get clipped.` : `${hit.name}: topic filter cleared, every video over ${MIN_SEC / 60} minutes gets clipped.`;
}

async function removeChannel(arg) {
  const s = await load();
  const q = String(arg || '').trim().toLowerCase();
  const hit = s.channels.find((c) => c.name.toLowerCase() === q || c.id.toLowerCase() === q || (q && c.url.toLowerCase().includes(q.replace(/^https?:\/\/(www\.)?/, ''))))
    || s.channels.find((c) => q && c.name.toLowerCase().includes(q));
  if (!hit) return `not watching anything matching "${arg}"`;
  s.channels = s.channels.filter((c) => c.id !== hit.id);
  s.queue = s.queue.filter((v) => v.channelId !== hit.id);
  await save(s);
  return `stopped watching ${hit.name}`;
}

async function listText() {
  const s = await load();
  if (!s.channels.length) return 'not watching any channels';
  const lines = s.channels.map((c) => `- ${c.name} (${c.url})${c.topic ? ` — only "${c.topic}"` : ''}, watched since ${new Date(c.addedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`);
  const q = s.queue.length ? `\nWaiting to be clipped: ${s.queue.map((v) => `"${v.title}"`).join(', ')}` : '';
  const last = s.done.slice(-3).reverse().map((d) => `"${d.title}" (${d.status}${d.why ? `: ${d.why}` : ''})`).join('; ');
  return `${lines.join('\n')}${q}${last ? `\nLatest: ${last}` : ''}\n${s.day === todayET() ? s.ranToday : 0} of ${MAX_PER_DAY} scans used today.`;
}

async function tag(name, arg) {
  if (!enabled()) return 'auto clips are switched off on this server (AUTO_CLIP=off)';
  if (name === 'AUTO_CLIP') return addChannel(arg);
  if (name === 'AUTO_CLIP_TOPIC') return setTopic(arg);
  if (name === 'AUTO_CLIP_OFF') return removeChannel(arg);
  return listText();
}

// --- the tick -----------------------------------------------------------------

async function deliver(v, r, err) {
  const telegram = require('./telegram');
  const ara = telegram.botFor('ara');
  if (!ara || !ara.isConfigured()) return;
  if (err) return ara.sendMessage(telegram.OWNER_ID, `🎬 R.O.G.U.E.'s auto clip of ${v.channel}'s new video "${v.title}" didn't work: ${err}`, { remember: true }).catch(() => {});
  await ara.sendMessage(telegram.OWNER_ID, `🎬 **R.O.G.U.E. → A.R.A.** ${v.channel} just posted "${v.title}" — clipped automatically.\n${r.text}`, { remember: true });
  for (const m of r.media) await ara.sendFile(telegram.OWNER_ID, 'video', m.buffer, { filename: m.filename, caption: m.caption }).catch((e) => console.error('auto clip send failed:', e.message));
  await require('./pushSender').pushAlert('auto-clip', `New clips: ${v.channel}`, v.title, {}).catch(() => {});
}

let busy = false;
async function tick() {
  if (!enabled() || busy) return { skipped: busy ? 'busy' : 'off' };
  busy = true;
  try {
    const s = await load();
    if (!s.channels.length) return { skipped: 'no channels' };
    if (s.day !== todayET()) { s.day = todayET(); s.ranToday = 0; }
    // 1. New uploads onto the queue.
    for (const ch of s.channels) {
      try {
        const feed = await fetchFeed(ch.id);
        for (const v of newUploads(feed, ch, s).reverse()) s.queue.push({ id: v.id, title: v.title, url: v.url, published: v.published, channel: ch.name, channelId: ch.id, tries: 0 });
        if (feed.length) ch.since = Math.max(ch.since || 0, feed[0].published);
      } catch (e) { console.error(`auto clip failed: ${ch.name} feed — ${e.message}`); }
    }
    // Videos YouTube refused as a bot, once there are cookies to try: back on the queue.
    if (clip.hasYouTubeCookies()) {
      const back = s.done.filter((d) => d.status === 'failed' && clip.isBotCheck(d.why) && Date.now() - d.at < BLOCK_HOLD_MS && !s.queue.some((q) => q.id === d.id));
      for (const d of back) s.queue.unshift({ id: d.id, title: d.title, url: `https://www.youtube.com/watch?v=${d.id}`, channel: d.channel, tries: 0, blockedAt: d.at });
      if (back.length) s.done = s.done.filter((d) => !back.includes(d));
    }
    await save(s);
    // 2. One scan per tick, oldest first, within the daily cap.
    for (let n = 0; n < 15; n++) {
    const v = s.queue[0];
    if (!v || s.ranToday >= MAX_PER_DAY) return { queued: s.queue.length };
    const meta = await clip.videoInfo(v.url).catch((e) => ({ error: e.message }));
    const finish = async (status, why) => {
      const st = await load();
      st.queue = st.queue.filter((q) => q.id !== v.id);
      st.done = [...st.done, { id: v.id, title: v.title, channel: v.channel, status, why, at: Date.now() }].slice(-50);
      if (status === 'clipped' || status === 'failed') { const t = todayET(); st.ranToday = (st.day === t ? st.ranToday || 0 : 0) + 1; st.day = t; }
      await save(st);
    };
    // YouTube refused the server as a bot: hold it (told once) rather than burn it.
    const blocked = async (why) => {
      const st = await load();
      const q = st.queue.find((x) => x.id === v.id);
      if (!q) return;
      q.blockedAt = q.blockedAt || Date.now();
      if (Date.now() - q.blockedAt > BLOCK_HOLD_MS) { await finish('failed', why.slice(0, 200)); return; }
      const tell = !q.blockedTold;
      q.blockedTold = true;
      await save(st);
      if (tell) await deliver(v, null, `${why}. I'm holding it in the queue and will clip it as soon as that's sorted.`);
    };
    if (meta.error && clip.isBotCheck(meta.error)) { console.error(`auto clip failed: "${v.title}" — ${meta.error}`); await blocked(meta.error); return { blocked: v.id }; }
    if (meta.live) { v.tries++; if (v.tries > 72) await finish('skipped', 'still live after a day'); else await save(s); return { waiting: 'still live' }; }
    if (meta.error) {
      v.tries++;
      if (v.tries >= 3) { await finish('failed', meta.error); await deliver(v, null, meta.error); } else await save(s);
      return { error: meta.error };
    }
    // Topic filter: off-topic uploads are skipped (no scan, not counted) and the next one is looked at.
    const watched = s.channels.find((c) => c.id === v.channelId);
    if (watched && watched.topic && !matchesTopic(watched.topic, { title: v.title, tags: meta.tags })) {
      await finish('skipped', `off topic (only "${watched.topic}")`);
      Object.assign(s, await load());
      continue;
    }
    if (meta.duration && meta.duration < MIN_SEC) { await finish('skipped', `only ${Math.round(meta.duration / 60)} min`); return { skipped: 'short' }; }
    console.log(`auto clip: scanning ${v.channel} — "${v.title}"`);
    try {
      const r = await clip.clipScan(v.url, '', { title: `Auto clip: ${String(v.title || v.url).slice(0, 50)}` });
      await finish('clipped');
      await deliver(v, r);
    } catch (e) {
      if (/already running/.test(e.message)) return { waiting: 'another scan running' };
      if (clip.isBotCheck(e.message)) { console.error(`auto clip failed: "${v.title}" — ${e.message}`); await blocked(e.message); return { blocked: v.id }; }
      console.error(`auto clip failed: "${v.title}" — ${e.message}`);
      await finish('failed', e.message.slice(0, 200));
      await deliver(v, null, e.message);
    }
    return { scanned: v.id };
    }
    return { queued: s.queue.length };
  } finally { busy = false; }
}

const AUTO_CLIP_TOOLS = ` - [AUTO_CLIP: YouTube channel link, or any video of theirs] — watch that channel: every new upload over ${MIN_SEC / 60} minutes is clip-scanned on its own (viewer signals, the 3-5 best moments, finished 9:16 clips) and sent to him on Telegram from A.R.A., ${MAX_PER_DAY} scans a day at most. Starts from the channel's NEXT upload. To clip only one subject from a channel (e.g. GTA), add it after a pipe: [AUTO_CLIP: channel link | GTA] — uploads whose title or tags don't mention it are skipped; [AUTO_CLIP_TOPIC: channel | topic] changes it ("any" clears it). [AUTO_CLIP_OFF: channel name] stops one; [AUTO_CLIP_LIST] shows what's watched and the latest runs. Report only what the result says.`;

module.exports = { topicTerms, matchesTopic, splitArg, setTopic, tick, tag, addChannel, removeChannel, listText, parseFeed, newUploads, resolveChannel, AUTO_CLIP_TOOLS, enabled };
