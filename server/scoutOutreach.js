// S.C.O.U.T. cold-outreach cron — server-side port of the outreach half of
// src/services/autoScout.js (inbound sweep, outbound prospecting, cold opens,
// follow-ups). Distinct from server/autoScout.js, which is signal *discovery*
// only (Adzuna/Yelp buying-intent scoring into leads.heat) — this is the loop
// that actually writes the leads and sends the emails.
//
// Cut from this port: leadsSheet.js (mirroring leads into a Google Sheet) —
// a nice-to-have display mirror, not required for outreach to fire. Leads
// still land in the synced `leads` table and show up in the app's own Leads
// panel either way.
const { webResearch, chatAs } = require('./llm');
const { gmailSend } = require('./google');
const { getSetting, setSetting, todayET } = require('./syncStore');
const { pickTarget, pickInboundQuery } = require('./scoutTargets');
const { runInboundScan } = require('./inboundScan');
const { leadHasContact, addLead, updateLead, appendLeadLog, leadExists, getLeadsForOutreach, getLeadsDue } = require('./scoutLeads');

let busy = false;
let doneAnnouncedFor = '';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SCOUT_SYSTEM = 'You are S.C.O.U.T., Empire Digital\'s prospecting and outreach desk — sharp, concrete, never salesy.';

async function loadStats() {
  const today = todayET();
  let s = { date: today, added: 0, sent: 0 };
  try {
    const raw = await getSetting('auto_scout_stats', '');
    if (raw) { const p = JSON.parse(raw); if (p && p.date === today) s = { date: today, added: p.added | 0, sent: p.sent | 0 }; }
  } catch {}
  return s;
}
const saveStats = (s) => setSetting('auto_scout_stats', JSON.stringify(s)).catch(() => {});

function parseLeadAdds(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\[LEAD_ADD:\s*([^\]]+)\]/gi)) {
    const p = m[1].split('|').map((x) => x.trim());
    if (p[0]) out.push({ name: p[0], business: p[1] || '', website: p[2] || '', contact: p[3] || '', bottleneck: p[4] || '', segment: p[5] || '' });
  }
  return out;
}
function parseSubjectBody(text) {
  const t = String(text || '');
  const sm = t.match(/SUBJECT:\s*(.+)/i);
  const bm = t.match(/BODY:\s*([\s\S]+)/i);
  const subject = (sm ? sm[1] : '').trim().split('\n')[0].replace(/^["']|["']$/g, '').slice(0, 160);
  let body = (bm ? bm[1] : '').trim().replace(/\[[^\]]*\]/g, '').trim();
  return { subject, body };
}
function plusDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; }

// --- outbound prospecting ---
async function prospectPass(stats, dailyLeads) {
  if (stats.added >= dailyLeads) return;
  let cursor = 0;
  try { cursor = parseInt(await getSetting('auto_scout_cursor', '0'), 10) || 0; } catch {}
  await setSetting('auto_scout_cursor', String(cursor + 1));
  const { metro, segment } = pickTarget(cursor);

  let results = '';
  try { results = await webResearch(`${segment} businesses in ${metro} — small, owner-operated, currently open (not permanently closed)`); }
  catch (e) { console.error('scout-outreach: search failing', e.message); return; }
  if (!String(results || '').trim()) return;

  const room = Math.min(6, Math.max(1, dailyLeads - stats.added));
  const ask = [{ role: 'user', content:
`TOOL RESULTS — web search for "${segment}" in ${metro}:\n\n${String(results).slice(0, 4000)}\n\n` +
`Pick the businesses in these results that genuinely fit Empire Digital's ICP and emit one line per business:\n` +
`[LEAD_ADD: name | what they do | website | contact | the bottleneck you'd guess they have | ${segment} · ${metro}]\n\n` +
`ICP: owner-operated, roughly 2-50 people, a clear repetitive bottleneck likely costing time or money, an owner who can say yes alone. ` +
`Do NOT add franchises, national chains, directories, marketplaces, aggregator listings or anything enterprise. ` +
`Do NOT add a business that is permanently closed, temporarily closed, or otherwise no longer operating — if the results flag a listing "permanently closed", "closed", "out of business" or similar, skip it; we need live, reachable leads. ` +
`Every lead MUST carry a real phone number or email address found in the results — put it in the contact field. Never invent one. If you don't have a phone or email for a business, SKIP it entirely. ` +
`Add at most ${room}; two well-qualified beats ten weak. Output ONLY the [LEAD_ADD:] lines.` }];
  let resp = '';
  try { resp = await chatAs('anthropic', null, SCOUT_SYSTEM, ask, { maxTokens: 1400 }); }
  catch (e) { console.error('scout-outreach: claude unreachable', e.message); return; }

  let added = 0, noContact = 0;
  for (const c of parseLeadAdds(resp)) {
    if (stats.added >= dailyLeads) break;
    if (!leadHasContact(c.contact)) { noContact++; continue; }
    try {
      if (await leadExists(c.name, c.website)) continue;
      await addLead({ name: c.name, business: c.business, website: c.website, contact: c.contact, bottleneck: c.bottleneck,
        segment: c.segment || `${segment} · ${metro}`, stage: 'new', source: 'scout-auto', log: `Auto-scouted from ${metro} (${segment})` });
      stats.added++; added++;
    } catch {}
  }
  if (added || noContact) console.log(`scout-outreach: ${metro} / ${segment} — +${added} lead${added === 1 ? '' : 's'} (${stats.added}/${dailyLeads} today)${noContact ? ` · skipped ${noContact} with no phone/email` : ''}`);
}

// --- inbound signal sweep (priority) ---
async function inboundPass(stats, dailyLeads) {
  if (stats.added >= dailyLeads) return;
  let cursor = 0;
  try { cursor = parseInt(await getSetting('auto_scout_inbound_cursor', '0'), 10) || 0; } catch {}
  await setSetting('auto_scout_inbound_cursor', String(cursor + 1));
  const { metro } = pickTarget(cursor);

  let digest = '';
  try { digest = await runInboundScan(pickInboundQuery(cursor), { metro }); } catch { return; }
  if (!String(digest || '').trim()) return;

  const room = Math.min(4, Math.max(1, dailyLeads - stats.added));
  const ask = [{ role: 'user', content:
`INBOUND SCAN — public posts and open gigs where someone may want what Empire Digital builds:\n\n${String(digest).slice(0, 8500)}\n\n` +
`Emit a line for each one that is a real buyer — a business owner/operator asking for a custom tool, automation, or software help, OR an open [Hiring]/gig post whose work is genuinely ours to do:\n` +
`[LEAD_ADD: name or handle | what their business does | the post URL | | what they said they need | inbound-signal]\n\n` +
`KEEP the gig-board and Craigslist job posts — those are buyers with a budget; the post URL is the reply channel. SKIP developers/agencies advertising their own services, generic discussion, roles that aren't software/automation work, and anything already stale. Add at most ${room}. Output ONLY [LEAD_ADD:] lines.` }];
  let resp = '';
  try { resp = await chatAs('anthropic', null, SCOUT_SYSTEM, ask, { maxTokens: 1200 }); } catch { return; }

  let added = 0;
  for (const c of parseLeadAdds(resp)) {
    if (stats.added >= dailyLeads) break;
    try {
      if (await leadExists(c.name, c.website)) continue;
      await addLead({ name: c.name, business: c.business, website: c.website, contact: c.contact || '', bottleneck: c.bottleneck,
        segment: 'inbound-signal', stage: 'new', source: 'scout-auto', log: `Auto-scouted inbound signal: ${String(c.bottleneck || '').slice(0, 200)}` });
      stats.added++; added++;
    } catch {}
  }
  if (added) console.log(`scout-outreach: inbound sweep — +${added} signal${added === 1 ? '' : 's'}`);
}

// --- cold outreach ---
async function sendFor(lead, promptText, stats, dailyEmails, label) {
  const email = String(lead.contact || '').trim();
  if (!EMAIL_RE.test(email)) return false;
  let resp = '';
  try { resp = await chatAs('anthropic', null, SCOUT_SYSTEM, [{ role: 'user', content: promptText }], { maxTokens: 500 }); } catch { return false; }
  const { subject, body } = parseSubjectBody(resp);
  if (!subject || body.length < 20) return false;
  try { await gmailSend({ to: email, subject, body }); }
  catch (e) {
    console.error(`scout-outreach: email to ${lead.name} failed —`, e.message);
    if (/auth|401|expired|token|not linked/i.test(e.message)) throw e; // Google problem — abort the pass
    return false;
  }
  stats.sent++;
  await appendLeadLog(lead.sync_id, `${label}: ${subject}`).catch(() => {});
  console.log(`scout-outreach: ${label.toLowerCase()} -> ${lead.name} <${email}> — "${subject}" (${stats.sent}/${dailyEmails} today)`);
  return true;
}

async function outreachPass(stats, dailyEmails) {
  if (stats.sent >= dailyEmails) return;
  let leads = [];
  try { leads = await getLeadsForOutreach(3); } catch { return; }
  for (const lead of leads) {
    if (stats.sent >= dailyEmails) break;
    const prompt =
`Write the FIRST cold outreach email to this prospect. It is the opener — one question, nothing else: no pitch, no link, no credentials, no "I hope this finds you well". Warm, sharp, short.\n\n` +
`Prospect: ${lead.name}${lead.business ? ` — ${lead.business}` : ''}${lead.segment ? ` (${lead.segment})` : ''}\nLikely bottleneck: ${lead.bottleneck || 'unknown'}\n\n` +
`Reply in EXACTLY this format, nothing else:\nSUBJECT: <short, not salesy>\nBODY: <2-4 sentences, ends on the question>`;
    let ok = false;
    try { ok = await sendFor(lead, prompt, stats, dailyEmails, 'Auto-emailed opener'); } catch { return; }
    if (ok) await updateLead(lead.sync_id, { stage: 'contacted', next_touch: plusDays(4), next_action: 'await reply / follow up' }).catch(() => {});
  }
}

// --- follow-ups ---
async function followupPass(stats, dailyEmails) {
  if (stats.sent >= dailyEmails) return;
  let due = [];
  try { due = await getLeadsDue(todayET()); } catch { return; }
  due = due.filter((l) => EMAIL_RE.test(String(l.contact || '').trim()) && ['contacted', 'replied', 'qualifying'].includes(l.stage));
  for (const lead of due.slice(0, 2)) {
    if (stats.sent >= dailyEmails) break;
    const prompt =
`Write the NEXT follow-up email to this prospect — they haven't replied. Bring a NEW angle: a relevant example, a sharper version of the question, or a specific idea for their business. Never "just checking in". Short.\n\n` +
`Prospect: ${lead.name}${lead.business ? ` — ${lead.business}` : ''}\nBottleneck: ${lead.bottleneck || 'unknown'}\nThread so far:\n${String(lead.log || '').slice(0, 600)}\n\n` +
`Reply EXACTLY:\nSUBJECT: <re: … or a fresh short line>\nBODY: <2-4 sentences>`;
    const touches = (String(lead.log || '').match(/emailed|follow-up/gi) || []).length;
    let ok = false;
    try { ok = await sendFor(lead, prompt, stats, dailyEmails, 'Auto follow-up sent'); } catch { return; }
    if (ok) await updateLead(lead.sync_id, touches >= 3 ? { stage: 'cold', next_touch: '', next_action: 'went cold — no reply after 3 touches' } : { next_touch: plusDays(4) }).catch(() => {});
  }
}

// The cron ticks every 5 min (see server/index.js); this self-paces to
// whatever `auto_scout_interval_min` says, same due-check pattern as
// server/autoAtlas.js.
async function dueNow() {
  const mins = Math.max(1, parseInt(await getSetting('auto_scout_interval_min', '30'), 10) || 30);
  const last = parseInt(await getSetting('scout_outreach_last_cycle_at', '0'), 10) || 0;
  return Date.now() - last >= mins * 60000;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if ((await getSetting('auto_scout', '0')) !== '1') return;
    if (!(await dueNow())) return;
    await setSetting('scout_outreach_last_cycle_at', String(Date.now()));
    const dailyLeads = Math.max(1, parseInt(await getSetting('auto_scout_daily_leads', '20'), 10) || 20);
    const dailyEmails = Math.max(0, parseInt(await getSetting('auto_scout_daily_emails', '20'), 10) || 20);
    const stats = await loadStats();

    if (stats.added >= dailyLeads && stats.sent >= dailyEmails) {
      if (stats.date !== doneAnnouncedFor) {
        doneAnnouncedFor = stats.date;
        console.log(`scout-outreach: done for the day — ${stats.added} leads, ${stats.sent} emails.`);
      }
      return;
    }

    await inboundPass(stats, dailyLeads).catch(() => {});
    await prospectPass(stats, dailyLeads).catch(() => {});
    await outreachPass(stats, dailyEmails).catch(() => {});
    await followupPass(stats, dailyEmails).catch(() => {});

    await saveStats(stats);
  } catch (e) {
    console.error('scout-outreach: tick crashed', e.message);
  } finally {
    busy = false;
  }
}

module.exports = { tick };
