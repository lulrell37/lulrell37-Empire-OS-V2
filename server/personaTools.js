// The rest of a persona's toolkit on the server — everything the app's
// commandHandler.js / googleCommands.js can do that doesn't physically need the
// phone: Gmail, Calendar, Drive, Sheets, Google Tasks, HUD edits, task edits,
// revenue, business targets, the leads pipeline, and A.R.A.'s client-project
// coordination (THE FIRM). personaRuntime.js calls in here.
//
//   readTag(tag, persona)            -> string | null   feeds a result back before she answers
//   writeTag(tag, persona)           -> { ok, warn, confirm } | null   side effects after the reply
//   runPending(id) / cancelPending(id)   the owner's Confirm / Cancel tap on Telegram
//
// Anything outward-facing or destructive (send an email, delete an event or a
// Drive file) is never fired straight off a model reply — it becomes a
// tg_pending row and the bot asks for a tap, the same rule the app enforces
// with its confirmation card.
const { query } = require('./db');
const { syncedRow, syncedRows, upsertSyncRow, getSetting, setSetting, newId, todayET } = require('./syncStore');
const g = require('./google');
const { addLead, updateLead, appendLeadLog, leadHasContact } = require('./scoutLeads');

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
const parts = (arg) => String(arg || '').split('|').map((s) => s.trim());
// Everything after the first n "|" separators, untouched — for free text (an
// email body, a note) that may itself contain a pipe.
function rest(arg, n) {
  let s = String(arg || '');
  for (let i = 0; i < n; i++) {
    const k = s.indexOf('|');
    if (k < 0) return '';
    s = s.slice(k + 1);
  }
  return s.trim();
}
function asObject(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// "Title | 2" / "Title | all" -> { ref, page }. Anything else is part of the name.
function splitPageArg(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*\|\s*(\d+|all)\s*$/i);
  return m ? { ref: m[1].trim(), page: m[2].toLowerCase() } : { ref: s, page: 1 };
}

async function deleteSyncRow(table, syncId) {
  await query(
    `UPDATE sync_rows SET deleted = true, data = '{}'::jsonb, updated_at = $3, server_seq = nextval('sync_seq')
      WHERE table_name = $1 AND sync_id = $2`,
    [table, syncId, Date.now()],
  );
}

// --- HUD (the synced hud_state singleton) ---------------------------------

// Merge, never replace — the row carries the whole HUD, and the persona
// context + council read every field of it.
async function hudPatch(patch) {
  const cur = (await syncedRow('hud_state', 'singleton')) || {};
  await upsertSyncRow('hud_state', 'singleton', { ...cur, ...patch, updated_at: Date.now() });
}
async function routine() {
  const h = (await syncedRow('hud_state', 'singleton')) || {};
  const items = (asObject(h.morning_routine, []) || []).map((r) => (typeof r === 'string' ? { id: r, label: r } : r));
  return { items, done: asObject(h.morning_routine_done, {}) || {} };
}
function findRoutineItem(items, ref) {
  const q = String(ref || '').toLowerCase().trim();
  return items.find((i) => i.id === ref) || items.find((i) => i.label.toLowerCase() === q) || items.find((i) => i.label.toLowerCase().includes(q));
}
const routineId = (i = 0) => `r_${Date.now().toString(36)}${i.toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// --- tasks (the app's synced list; Google Tasks mirrored best-effort) -----

async function findTask(name) {
  const q = String(name || '').toLowerCase();
  return (await syncedRows('tasks')).find((t) => !t.completed && String(t.title || '').toLowerCase().includes(q)) || null;
}

async function findLeadRow(ref) {
  const q = String(ref || '').toLowerCase().trim();
  if (!q) return null;
  const rows = (await syncedRows('leads')).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  return rows.find((l) => l.sync_id === ref)
    || rows.find((l) => String(l.name || '').toLowerCase().includes(q))
    || rows.find((l) => String(l.business || '').toLowerCase().includes(q))
    || null;
}

// --- THE FIRM ---------------------------------------------------------------

const PROJECT_ROLES = {
  jarvis: 'Architecture & build feasibility',
  selene: 'Brand direction & visual identity',
  rogue: 'Copy, messaging & content strategy',
  atlas: 'Pricing structure & payment systems',
  aisha: 'Legal, compliance, terms & privacy',
  stephanie: 'Training & educational content',
  haven: 'Health & wellness protocol content',
  sage: 'Research, evidence & competitive analysis',
};
async function activeProject() {
  return asObject(await getSetting('active_project', ''), null);
}

// ---------------------------------------------------------------------------
// Reads — the result goes back to the persona before she answers.
// ---------------------------------------------------------------------------

async function readTag({ name, arg }, persona) {
  switch (name) {
    case 'READ_EMAIL':
      return g.gmailList(arg ? { q: arg } : {});
    case 'READ_EMAIL_ID':
      return g.gmailRead(arg);
    case 'READ_CALENDAR': {
      if (!arg) return g.calendarList();
      const p = parts(arg);
      if (p.length >= 2) return g.calendarList({ startISO: p[0], days: parseInt(p[1], 10) || 30 });
      if (/^\d+$/.test(p[0])) return g.calendarList({ days: parseInt(p[0], 10) });
      return g.calendarList({ startISO: p[0] });
    }
    case 'LIST_NOTES':
      return g.driveList(parseInt(arg, 10) || 30);
    case 'SEARCH_DRIVE':
      return arg ? g.driveSearch(arg) : null;
    case 'READ_FILE_ID': {
      const { ref, page } = splitPageArg(arg);
      return g.driveRead({ fileId: ref, page });
    }
    case 'READ_NOTE': {
      const { ref, page } = splitPageArg(arg);
      try {
        return await g.driveRead({ name: ref, page });
      } catch (e) {
        // Drive-first, then the app's own synced notes — same as the app.
        const q = ref.toLowerCase();
        const local = (await syncedRows('notes')).find((n) => String(n.title || '').toLowerCase() === q)
          || (await syncedRows('notes')).find((n) => String(n.title || '').toLowerCase().includes(q));
        if (local) return `Note "${local.title}" (app notes, not Drive):\n${String(local.content || '').slice(0, 16000)}`;
        throw e;
      }
    }
    case 'READ_TASKS': {
      const open = (await syncedRows('tasks')).filter((t) => !t.completed);
      const app = open.length ? `App tasks:\n${open.map((t) => `• ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`).join('\n')}` : 'App tasks: none open.';
      const gt = await g.gTasksList().catch((e) => `Google Tasks: unavailable — ${e.message}`);
      return `${app}\n\n${gt}`;
    }
    case 'LEADS':
    case 'LEAD_LIST': {
      const stage = (arg || '').toLowerCase();
      const rows = (await syncedRows('leads'))
        .filter((l) => !stage || (l.stage || 'new') === stage)
        .sort((a, b) => (Number(b.heat) || 0) - (Number(a.heat) || 0) || (b.updated_at || 0) - (a.updated_at || 0))
        .slice(0, 25);
      if (!rows.length) return `Pipeline: no leads${stage ? ` at "${stage}"` : ''}.`;
      return `Pipeline (${rows.length}${stage ? ` · ${stage}` : ''}, hottest first):\n` + rows.map((l) =>
        `• ${l.name}${l.business ? ` — ${l.business}` : ''} [${l.stage || 'new'}${l.heat != null ? ` · heat ${l.heat}` : ''}]${l.contact ? ` ${l.contact}` : ''}${l.next_action ? `\n   next: ${l.next_action}${l.next_touch ? ` (${l.next_touch})` : ''}` : ''}`).join('\n');
    }
    case 'EXPENSE_SUMMARY': {
      const mp = todayET().slice(0, 7);
      const rows = (await syncedRows('expenses')).filter((e) => String(e.date || '').startsWith(mp));
      if (!rows.length) return `Expenses: nothing logged for ${mp}.`;
      const by = {};
      let total = 0;
      for (const e of rows) { const a = Number(e.amount) || 0; by[e.category || 'general'] = (by[e.category || 'general'] || 0) + a; total += a; }
      return `Expenses ${mp} — ${money(total)} across ${rows.length}:\n` + Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `• ${k}: ${money(v)}`).join('\n');
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Writes — run once after the reply. Return { ok } for a receipt, { warn } when
// it failed or landed somewhere other than asked, { confirm } when it needs the
// owner's tap first. null = not a tag this module owns.
// ---------------------------------------------------------------------------

async function propose(persona, kind, label, detail, payload) {
  const id = newId().slice(0, 12);
  await query(
    'INSERT INTO tg_pending (id, persona, kind, label, detail, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, persona, kind, label, detail, JSON.stringify(payload), Date.now()],
  );
  return { confirm: { id, label, detail } };
}

async function writeTag({ name, arg }, persona) {
  const p = parts(arg);
  const now = Date.now();
  switch (name) {
    // --- Google ---
    case 'CREATE_EVENT':
      if (!p[0] || !p[1]) return { warn: 'CREATE_EVENT needs a title and a start time' };
      return { ok: await g.calendarCreate({ title: p[0], startISO: p[1], minutes: parseInt(p[2], 10) || 60 }) };
    case 'CREATE_NOTE': {
      if (!p[0]) return null;
      const r = await g.saveDriveNote(p[0], rest(arg, 1));
      return { ok: `Drive note ${r.created ? 'created' : 'updated'}: ${r.name}` };
    }
    case 'EDIT_NOTE':
      if (!p[0]) return null;
      return { ok: await g.driveUpdate({ fileId: p[0], content: rest(arg, 1) }) };
    case 'CREATE_SHEET':
      if (!p[0]) return null;
      return {
        ok: await g.sheetCreate({
          title: p[0],
          columns: (p[1] || '').split(',').map((s) => s.trim()).filter(Boolean),
          values: (p[2] || '').split(',').map((s) => s.trim()).filter(Boolean),
        }),
      };
    case 'SET_REMINDER':
      if (!p[0] || !p[1]) return null;
      await upsertSyncRow('important_dates', newId(), { label: p[0], date: p[1], note: '', created_at: now, updated_at: now });
      return { ok: `reminder saved: ${p[0]} — ${p[1]}` };
    case 'SEND_EMAIL': {
      const [to, subject] = p;
      const body = rest(arg, 2);
      if (!to || !subject || !body) return { warn: 'SEND_EMAIL needs to | subject | body' };
      return propose(persona, 'send_email', 'Send email', `To: ${to}\nSubject: ${subject}\n\n${body.slice(0, 1500)}`, { to, subject, body });
    }
    case 'DELETE_EVENT':
      if (!arg) return null;
      return propose(persona, 'delete_event', 'Delete calendar event', `Event id: ${arg}`, { id: arg });
    case 'DELETE_FILE':
      if (!arg) return null;
      return propose(persona, 'delete_file', 'Move Drive file to trash', `File id: ${arg}`, { id: arg });
    case 'LEAD_EMAIL': {
      const lead = await findLeadRow(p[0]);
      if (!lead) return { warn: `no lead matches "${p[0]}"` };
      const email = (String(lead.contact || '').match(/[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}/i) || [])[0];
      if (!email) return { warn: `no email on file for ${lead.name}` };
      const body = rest(arg, 2);
      if (!p[1] || !body) return { warn: 'LEAD_EMAIL needs lead | subject | body' };
      return propose(persona, 'lead_email', 'Send outreach email', `To: ${lead.name} <${email}>\nSubject: ${p[1]}\n\n${body.slice(0, 1500)}`,
        { to: email, subject: p[1], body, leadId: lead.sync_id, stage: lead.stage || 'new' });
    }

    // --- tasks ---
    case 'CREATE_TASK': {
      if (!p[0]) return null;
      const due = /^\d{4}-\d{2}-\d{2}$/.test(p[2] || '') ? p[2] : null;
      await upsertSyncRow('tasks', newId(), { title: p[0], notes: p[1] || '', due_date: due, priority: 'normal', completed: 0, created_at: now, updated_at: now });
      const gt = await g.gTaskCreate({ title: p[0], notes: p[1], due }).catch((e) => `Google Tasks copy failed — ${e.message}`);
      return /failed/.test(gt) ? { warn: `task added to the app, but ${gt}` } : { ok: `task added: ${p[0]} (app + Google Tasks)` };
    }
    case 'TASK_EDIT': {
      const t = await findTask(p[0]);
      if (!t || !p[1]) return { warn: `no open task matches "${p[0]}"` };
      const { sync_id: sid, ...data } = t;
      await upsertSyncRow('tasks', sid, { ...data, title: p[1], updated_at: now });
      return { ok: `task renamed: ${t.title} → ${p[1]}` };
    }
    case 'DELETE_TASK': {
      const t = await findTask(arg);
      const gt = await g.gTaskDelete(arg).catch(() => null);
      if (!t && !gt) return { warn: `no open task matches "${arg}"` };
      if (t) await deleteSyncRow('tasks', t.sync_id);
      return { ok: `task deleted: ${t ? t.title : arg}` };
    }

    // --- money ---
    case 'ADD_REVENUE': {
      const amount = parseFloat(String(p[1] || '').replace(/[^0-9.\-]/g, ''));
      if (!p[0] || isNaN(amount)) return { warn: 'ADD_REVENUE needs business | amount' };
      await upsertSyncRow('revenue', newId(), { business: p[0], amount, type: (p[2] || 'income').toLowerCase(), note: p[3] || '', date: todayET(), created_at: now, updated_at: now });
      return { ok: `${(p[2] || 'income').toLowerCase()} logged: ${money(amount)} ${p[0]}` };
    }
    case 'SET_TARGET': {
      const q = String(p[0] || '').toLowerCase();
      const b = (await syncedRows('business_targets')).find((x) => String(x.business || '').toLowerCase().includes(q));
      if (!b) return { warn: `no business matches "${p[0]}"` };
      const monthly = parseFloat(p[1]);
      const weekly = p[2] != null ? parseFloat(p[2]) : NaN;
      const { sync_id: sid, ...data } = b;
      await upsertSyncRow('business_targets', sid, {
        ...data, target: isNaN(monthly) ? b.target : monthly, week_goal: isNaN(weekly) ? b.week_goal : weekly, updated_at: now,
      });
      return { ok: `target set: ${b.business} ${money(isNaN(monthly) ? b.target : monthly)}/mo` };
    }

    // --- HUD ---
    case 'UPDATE_SCORE': {
      const n = parseInt(arg, 10);
      if (isNaN(n)) return null;
      await hudPatch({ empire_score: n });
      return { ok: `Empire Score → ${n}%` };
    }
    case 'UPDATE_HUD':
      if (!p[0] || p[1] == null) return null;
      await hudPatch({ [p[0]]: rest(arg, 1) });
      return { ok: `HUD ${p[0]} updated` };
    case 'SET_WORD':
      if (!p[0]) return null;
      await hudPatch({ word_of_day: p[0], word_phonetic: p[1] || '', word_def: p[2] || '' });
      return { ok: `word of the day: ${p[0]}` };
    case 'SET_VERSE':
      if (!p[0]) return null;
      await hudPatch({ verse_of_day: p[0], verse_ref: p[1] || '' });
      return { ok: 'verse of the day set' };
    case 'SET_FACT':
      if (!arg) return null;
      await hudPatch({ fact_of_day: arg });
      return { ok: 'fact of the day set' };
    case 'ROUTINE_DONE': {
      const { items, done } = await routine();
      const hit = [];
      for (const ref of String(arg).split(',').map((s) => s.trim()).filter(Boolean)) {
        const it = findRoutineItem(items, ref);
        if (it) { done[it.id] = true; hit.push(it.label); }
      }
      if (!hit.length) return { warn: `no routine item matches "${arg}"` };
      await hudPatch({ morning_routine_done: JSON.stringify(done) });
      return { ok: `routine checked: ${hit.join(', ')}` };
    }
    case 'ROUTINE_ADD': {
      if (!arg) return null;
      const { items } = await routine();
      await hudPatch({ morning_routine: JSON.stringify([...items, { id: routineId(items.length), label: arg }]) });
      return { ok: `routine item added: ${arg}` };
    }
    case 'ROUTINE_REMOVE': {
      const { items, done } = await routine();
      const it = findRoutineItem(items, arg);
      if (!it) return { warn: `no routine item matches "${arg}"` };
      delete done[it.id];
      await hudPatch({ morning_routine: JSON.stringify(items.filter((i) => i.id !== it.id)), morning_routine_done: JSON.stringify(done) });
      return { ok: `routine item removed: ${it.label}` };
    }
    case 'ROUTINE_RENAME': {
      const { items } = await routine();
      const it = findRoutineItem(items, p[0]);
      if (!it || !p[1]) return { warn: `no routine item matches "${p[0]}"` };
      const was = it.label;
      it.label = p[1];
      await hudPatch({ morning_routine: JSON.stringify(items) });
      return { ok: `routine item renamed: ${was} → ${p[1]}` };
    }
    case 'BATMAN_SET': {
      const h = (await syncedRow('hud_state', 'singleton')) || {};
      const t = asObject(h.batman_template, []);
      const key = String(p[0] || '').toLowerCase().slice(0, 3);
      const d = Array.isArray(t) ? t.find((x) => String(x.day || '').toLowerCase().slice(0, 3) === key) : null;
      if (!d) return { warn: `Batman Protocol has no day "${p[0]}" yet — set the template up in the app first` };
      if (p[1] != null) d.label = p[1];
      if (p[2] != null) d.desc = p[2];
      await hudPatch({ batman_template: JSON.stringify(t) });
      return { ok: `Batman Protocol ${d.day}: ${d.label}` };
    }

    // --- leads ---
    case 'LEAD_ADD': {
      const [lname, business, website, contact, bottleneck, segment] = p;
      if (!lname) return null;
      if (!/inbound[\s-]?signal/i.test(segment || '') && !leadHasContact(contact)) return { warn: `lead "${lname}" not added — needs a phone or email` };
      await addLead({ name: lname, business: business || '', website: website || '', contact: contact || '', bottleneck: bottleneck || '', segment: segment || '' });
      return { ok: `lead added: ${lname}` };
    }
    case 'LEAD_UPDATE': {
      const lead = await findLeadRow(p[0]);
      if (!lead) return { warn: `no lead matches "${p[0]}"` };
      const patch = {};
      for (const pair of rest(arg, 1).split(';')) {
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const k = pair.slice(0, eq).trim().toLowerCase();
        const v = pair.slice(eq + 1).trim();
        if (k === 'log') await appendLeadLog(lead.sync_id, v);
        else if (['name', 'business', 'website', 'contact', 'bottleneck', 'segment', 'value', 'stage', 'next_action', 'next_touch'].includes(k)) patch[k] = v;
      }
      if (Object.keys(patch).length) await updateLead(lead.sync_id, patch);
      return { ok: `lead updated: ${lead.name}` };
    }
    case 'LEAD_LOG': {
      const lead = await findLeadRow(p[0]);
      if (!lead) return { warn: `no lead matches "${p[0]}"` };
      await appendLeadLog(lead.sync_id, rest(arg, 1));
      return { ok: `logged on ${lead.name}` };
    }

    // --- THE FIRM ---
    case 'PROJECT_START': {
      if (!p[0]) return null;
      const target = (p[2] || '').toLowerCase();
      let repo = null;
      let mode = 'new';
      if (target.includes('/')) { const [o, r] = target.split('/'); repo = { owner: o.trim(), repo: r.trim() }; mode = 'existing'; }
      else if (target === 'empire') { repo = { owner: 'lulrell37', repo: 'lulrell37-Empire-OS-V2' }; mode = 'empire'; }
      await setSetting('active_project', JSON.stringify({ name: p[0], brief: p[1] || '', target: mode, repo, contributions: [], startedAt: now }));
      return { ok: `project opened: ${p[0]}${mode === 'new' ? ' (its repo is created from the app when the first build is filed)' : ''}` };
    }
    case 'PROJECT_DONE':
    case 'PROJECT_CLOSE':
    case 'PROJECT_COMPLETE':
    case 'PROJECT_END': {
      const proj = await activeProject();
      await setSetting('active_project', '');
      return { ok: proj ? `project closed: ${proj.name}` : 'no project was open' };
    }
    case 'BUILD_REQUEST': {
      // Filing a build needs the GitHub token, which lives on the phone. Keep the
      // spec safe in Drive (or the app's notes) so it can be filed from the app.
      const proj = await activeProject();
      const title = `Build Spec — ${proj ? proj.name : todayET()}`;
      try {
        await g.saveDriveNote(title, arg);
        return { warn: `build spec saved to Drive as "${title}" — filing it to GitHub still needs the app open` };
      } catch {
        await upsertSyncRow('notes', newId(), { title, content: arg, persona, created_at: now, updated_at: now });
        return { warn: `build spec saved to the app's Notes as "${title}" — filing it to GitHub still needs the app open` };
      }
    }
    default:
      return null;
  }
}

// --- confirmations -----------------------------------------------------------

async function takePending(id) {
  const { rows } = await query("UPDATE tg_pending SET resolved = 'running' WHERE id = $1 AND resolved IS NULL RETURNING *", [id]);
  return rows[0] || null;
}
async function resolvePending(id, state) {
  await query('UPDATE tg_pending SET resolved = $2 WHERE id = $1', [id, state]);
}

// Run a confirmed action. Returns { ok, text, row } — row null when it was
// already handled (a double tap) or never existed.
async function runPending(id) {
  const row = await takePending(id);
  if (!row) return { ok: false, text: 'Already handled.', row: null };
  const pl = row.payload || {};
  try {
    let text;
    if (row.kind === 'send_email') {
      await g.gmailSend(pl);
      text = `Sent to ${pl.to}.`;
    } else if (row.kind === 'lead_email') {
      await g.gmailSend(pl);
      await appendLeadLog(pl.leadId, `Emailed: ${pl.subject}`);
      if (pl.stage === 'new') await updateLead(pl.leadId, { stage: 'contacted' });
      text = `Sent to ${pl.to} — logged on the lead.`;
    } else if (row.kind === 'delete_event') {
      text = await g.calendarDelete(pl.id);
    } else if (row.kind === 'delete_file') {
      text = await g.driveTrash(pl.id);
    } else {
      throw new Error(`unknown action ${row.kind}`);
    }
    await resolvePending(id, 'done');
    return { ok: true, text, row };
  } catch (e) {
    await resolvePending(id, 'failed');
    return { ok: false, text: `Failed — ${e.message}`, row };
  }
}
async function cancelPending(id) {
  const row = await takePending(id);
  if (row) await resolvePending(id, 'cancelled');
  return row;
}

// Tags readTag / writeTag own, for the caller's routing.
const READ_TAGS = new Set(['READ_EMAIL', 'READ_EMAIL_ID', 'READ_CALENDAR', 'LIST_NOTES', 'SEARCH_DRIVE', 'READ_FILE_ID', 'READ_NOTE', 'READ_TASKS', 'LEADS', 'LEAD_LIST', 'EXPENSE_SUMMARY']);

module.exports = { readTag, writeTag, runPending, cancelPending, READ_TAGS, PROJECT_ROLES, activeProject, deleteSyncRow };
