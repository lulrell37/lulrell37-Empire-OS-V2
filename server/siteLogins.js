// YouTube and Instagram logins for the downloads (yt-dlp: R.O.G.U.E.'s clips and
// edits, transcripts, style learning), kept alive without him. J.A.R.V.I.S.'s
// browser signs in with the account in the server's secrets, and its cookies are
// written out as the cookies.txt yt-dlp reads (cookieArgs in clipScan.js uses it
// when YOUTUBE_COOKIES / INSTAGRAM_COOKIES aren't set).
// When a download is refused (bot check, login required), ensureLogin signs in
// again and the download is retried once. R.O.G.U.E. -> J.A.R.V.I.S. hand-off is
// shown in the Empire group; when it needs him (a code, a phone approval, a
// checkpoint) J.A.R.V.I.S. hands it to A.R.A. and she tells him what to do.
// Secrets: YOUTUBE_LOGIN_EMAIL + YOUTUBE_LOGIN_PASSWORD (a spare Google account),
// INSTAGRAM_LOGIN_USER + INSTAGRAM_LOGIN_PASSWORD. The passwords never reach the
// model: the browser's brain types {{PASSWORD}} and the code fills it in.
// [SITE_LOGIN: youtube|instagram] (J.A.R.V.I.S.) signs in now. SITE_LOGINS=off stops it.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SITES = {
  youtube: {
    name: 'YouTube', user: 'YOUTUBE_LOGIN_EMAIL', pass: 'YOUTUBE_LOGIN_PASSWORD',
    domains: /(^|\.)(youtube\.com|google\.com|youtu\.be)$/,
    task: 'Sign in to YouTube. Go to https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/ . If it already shows the account signed in, open https://www.youtube.com and finish. Otherwise type {{USER}} as the email, go Next, type {{PASSWORD}} as the password, go Next. If Google asks for a code, a phone approval, or anything else only the owner can give, stop and say exactly what it asks for. When youtube.com shows the account avatar (signed in), open any video page and finish with "signed in".',
  },
  instagram: {
    name: 'Instagram', user: 'INSTAGRAM_LOGIN_USER', pass: 'INSTAGRAM_LOGIN_PASSWORD',
    domains: /(^|\.)instagram\.com$/,
    task: 'Sign in to Instagram. Go to https://www.instagram.com/accounts/login/ . If it already shows the feed, finish. Otherwise allow the cookie banner if there is one, type {{USER}} as the username, {{PASSWORD}} as the password and log in. Answer "Save your login info?" with Save and "Turn on notifications" with Not now. If it asks for a code, a phone approval or a checkpoint only the owner can pass, stop and say exactly what it asks for. Finish with "signed in" when the feed shows.',
  },
};
// Consent/continue buttons on a sign-in he authorized go through without asking.
const ALLOW = /^(allow( all)?( cookies)?|accept( all)?|i agree|agree|save( info)?|continue|confirm|yes|not now)$/i;
const RETRY_GAP = 30 * 60e3;

const enabled = () => String(process.env.SITE_LOGINS || '').toLowerCase() !== 'off';
const dir = () => path.join(process.env.EMPIRE_BIN || path.join(os.homedir(), '.empire-bin'), 'cookies');
const cookiePath = (site) => path.join(dir(), `${site}.txt`);
function cookieFor(site) {
  const f = cookiePath(site);
  try { return fs.statSync(f).size > 0 ? f : null; } catch { return null; }
}
const hasAccount = (site) => !!(SITES[site] && process.env[SITES[site].user] && process.env[SITES[site].pass]);

// Chrome cookies -> Netscape cookies.txt, only this site's domains. (pure)
function toNetscape(cookies, domains) {
  const rows = cookies.filter((c) => domains.test(String(c.domain || '').replace(/^\./, ''))).map((c) => [
    c.domain.startsWith('.') ? c.domain : (c.hostOnly === false ? `.${c.domain}` : c.domain),
    c.domain.startsWith('.') ? 'TRUE' : 'FALSE',
    c.path || '/', c.secure ? 'TRUE' : 'FALSE',
    String(c.expires && c.expires > 0 ? Math.floor(c.expires) : 0),
    c.name, c.value,
  ].join('\t'));
  return rows.length ? `# Netscape HTTP Cookie File\n# Written by Empire OS from J.A.R.V.I.S.'s browser\n${rows.join('\n')}\n` : '';
}

async function exportCookies(site) {
  const browser = require('./browserAgent');
  const b = await browser.browserFor('jarvis');
  const { cookies } = await b.cdp.send('Storage.getCookies', {});
  const text = toNetscape(cookies || [], SITES[site].domains);
  if (!text) return 0;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(cookiePath(site), text, { mode: 0o600 });
  return text.split('\n').length - 4;
}

// A code the site emailed: A.R.A.'s Gmail (the same inbox she reads), newest
// message from that site in the last 15 min, its first 6-8 digit code. (pure part: codeIn)
const SENDERS = { youtube: 'from:(google.com OR accounts.google.com)', instagram: 'from:(instagram.com OR mail.instagram.com)' };
function codeIn(text) { const m = String(text || '').match(/(?<![\d#])(\d{6,8})(?!\d)/); return m ? m[1] : null; }
const wantsEmailCode = (text) => /e-?mail|inbox|sent (a|the) code|check your email/i.test(String(text || '')) && /code|verif/i.test(String(text || ''));
async function emailCode(site) {
  const g = require('./google');
  for (let i = 0; i < 6; i++) { // the email can take a minute
    const list = await g.gmailList({ q: `${SENDERS[site]} newer_than:1h`, max: 3 }).catch(() => '');
    const id = (String(list).match(/\[id:([\w-]+)\]/) || [])[1];
    if (id) { const c = codeIn((await g.gmailRead(id).catch(() => '')).split('\n').slice(4).join('\n')); if (c) return c; }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return null;
}

// Sign in through the browser, then write the cookies out. -> { ok, text }
async function signIn(site) {
  const s = SITES[site];
  if (!s) throw new Error('youtube or instagram');
  if (!hasAccount(site)) return { ok: false, text: `no ${s.name} account on the server yet (${s.user} and ${s.pass} in Replit's secrets)` };
  const browser = require('./browserAgent');
  const { claudeText } = require('./llm');
  const r = await browser.runTask({
    persona: 'jarvis', personaName: 'J.A.R.V.I.S.', task: s.task, ownerText: '', allow: ALLOW,
    secrets: { USER: process.env[s.user], PASSWORD: process.env[s.pass] },
    brain: (sys, prompt) => claudeText(sys, prompt, { maxTokens: 700 }),
  });
  // An emailed code: A.R.A.'s inbox has it, so fetch it and finish without him.
  if (r.status !== 'done' && wantsEmailCode(r.text)) {
    const code = await emailCode(site);
    if (code) {
      await require('./groupChat').post('ara', `→ J.A.R.V.I.S.: the ${s.name} code just came into his email, here it is.`).catch(() => {});
      const r2 = await browser.runTask({
        persona: 'jarvis', personaName: 'J.A.R.V.I.S.', ownerText: '', allow: ALLOW,
        task: `You are partway through signing in to ${s.name}; the page is asking for the code that was emailed. Type {{CODE}} into the code box and continue. Then do the rest: ${s.task}`,
        secrets: { USER: process.env[s.user], PASSWORD: process.env[s.pass], CODE: code },
        brain: (sys, prompt) => claudeText(sys, prompt, { maxTokens: 700 }),
      });
      if (r2.status !== 'done') return { ok: false, text: r2.text, shot: r2.shot };
    } else return { ok: false, text: `${r.text} (A.R.A. didn't find the code in his email within 90 seconds)`, shot: r.shot };
  } else if (r.status !== 'done') return { ok: false, text: r.text, shot: r.shot };
  const n = await exportCookies(site);
  return n ? { ok: true, text: `signed in to ${s.name}; ${n} cookies saved for the downloads` } : { ok: false, text: `the browser said it signed in to ${s.name}, but no ${s.name} cookies came out of it`, shot: r.shot };
}

// A download was refused: sign in again (at most every RETRY_GAP), quietly unless
// it fails. -> true when there's a fresh login to retry with.
const last = {};
const told = {};
async function ensureLogin(site, who = 'rogue') {
  // No account saved: nothing to sign in with (the download's own error says what's missing).
  if (!enabled() || !SITES[site] || !hasAccount(site)) return false;
  if (last[site] && Date.now() - last[site].at < RETRY_GAP) return last[site].ok && last[site].fresh;
  const gc = require('./groupChat');
  await gc.post(who, `→ J.A.R.V.I.S.: ${SITES[site].name} refused my download, the login has expired. Can you sign me back in?`).catch(() => {});
  let r;
  try { r = await signIn(site); } catch (e) { r = { ok: false, text: e.message }; }
  last[site] = { at: Date.now(), ok: r.ok, fresh: r.ok };
  setTimeout(() => { if (last[site]) last[site].fresh = false; }, 5 * 60e3).unref?.();
  await gc.post('jarvis', r.ok ? `Done, signed back in to ${SITES[site].name}. Retrying your download.` : `I couldn't sign back in to ${SITES[site].name}: ${r.text}`).catch(() => {});
  // Told once every 12 h at most while it keeps failing.
  if (!r.ok && Date.now() - (told[site] || 0) > 12 * 3600e3) {
    told[site] = Date.now();
    // J.A.R.V.I.S. hands it to A.R.A.; she tells him what's needed (voice + text,
    // her bot), and the hand-off shows in the group.
    const ask = `${SITES[site].name} needs Mr. Burrus to finish my sign-in for R.O.G.U.E.'s downloads: ${r.text}`;
    await gc.post('jarvis', `→ A.R.A.: ${ask}`).catch(() => {});
    const msg = `🔑 **J.A.R.V.I.S. → A.R.A.** ${ask}\nWhen it's sorted (a code entered, the sign-in approved on his phone), tell J.A.R.V.I.S. to sign in to ${SITES[site].name} again.`;
    await require('./talonAlerts').sendFromAra(msg, undefined, { remember: true }).catch(() => {});
    const telegram = require('./telegram');
    const ara = telegram.botFor('ara');
    if (r.shot && ara && ara.isConfigured()) await ara.sendFile(telegram.OWNER_ID, 'photo', r.shot, { filename: 'signin.jpg', caption: `${SITES[site].name} sign-in page` }).catch(() => {});
  }
  return r.ok;
}

async function tag(arg) {
  const site = String(arg || '').trim().toLowerCase().replace(/^(yt|google)$/, 'youtube').replace(/^ig$/, 'instagram');
  if (!SITES[site]) return 'SITE_LOGIN: say youtube or instagram';
  const r = await signIn(site);
  last[site] = { at: Date.now(), ok: r.ok, fresh: r.ok };
  return `SITE_LOGIN ${SITES[site].name}: ${r.ok ? '✓ ' : 'not done: '}${r.text}`;
}

const LOGIN_TOOLS = ` - [SITE_LOGIN: youtube|instagram] — sign your browser in to that site with the account saved on the server, so R.O.G.U.E.'s downloads, transcripts and style learning get past the bot check. It also runs by itself whenever a login expires; he's told only when it can't be done (a code or phone approval only he can give). Report only what the result says.`;

module.exports = { codeIn, wantsEmailCode, toNetscape, cookieFor, ensureLogin, signIn, tag, hasAccount, LOGIN_TOOLS, SITES, ALLOW };
