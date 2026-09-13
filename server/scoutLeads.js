// Lead-pipeline helpers shared by server/scoutOutreach.js — server-side port of
// the `leads` functions in src/services/database.js, re-implemented against the
// synced `leads` table (server/syncStore.js) instead of local SQLite. Same
// table server/personaRuntime.js already reads for cross-domain context and
// server/autoScout.js (signal discovery) already writes into.
const { syncedRows, upsertSyncRow, newId, todayET } = require('./syncStore');

const LEAD_FIELDS = ['name', 'business', 'website', 'contact', 'bottleneck', 'segment', 'value', 'stage', 'next_action', 'next_touch', 'last_touch', 'log', 'source', 'source_id', 'heat', 'signal'];

const _EMAIL_IN = /[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}/i;
function leadHasContact(contact) {
  const s = String(contact || '');
  if (_EMAIL_IN.test(s)) return true;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

async function allLeads() {
  return syncedRows('leads');
}

async function addLead(fields = {}) {
  const now = Date.now();
  const f = { source: 'scout', stage: 'new', ...fields };
  const data = { created_at: now, updated_at: now };
  for (const k of LEAD_FIELDS) if (f[k] !== undefined && f[k] !== null) data[k] = f[k];
  const syncId = newId();
  await upsertSyncRow('leads', syncId, data);
  return syncId;
}

async function updateLead(syncId, patch = {}) {
  const rows = await allLeads();
  const hit = rows.find((l) => l.sync_id === syncId);
  if (!hit) return;
  await upsertSyncRow('leads', syncId, { ...hit, ...patch, updated_at: Date.now() });
}

async function appendLeadLog(syncId, line) {
  const text = String(line || '').trim();
  if (!text) return;
  const rows = await allLeads();
  const hit = rows.find((l) => l.sync_id === syncId);
  if (!hit) return;
  const stamped = `${todayET()} — ${text}`;
  const nextLog = hit.log ? `${stamped}\n${hit.log}` : stamped;
  await upsertSyncRow('leads', syncId, { ...hit, log: nextLog, last_touch: todayET(), updated_at: Date.now() });
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hostOf = (s) => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
async function leadExists(name, website) {
  const n = normName(name);
  const h = hostOf(website);
  const rows = await allLeads();
  return rows.some((r) => (n && normName(r.name) === n) || (h && h.length > 3 && hostOf(r.website) === h));
}

// Leads S.C.O.U.T. may cold-email: fresh, reachable, not yet contacted.
async function getLeadsForOutreach(limit = 5) {
  const rows = (await allLeads()).filter((l) =>
    ['inbound', 'new'].includes(l.stage)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(l.contact || '').trim())
    && !/mailed/i.test(String(l.log || '')));
  rows.sort((a, b) => (b.stage === 'inbound' ? 1 : 0) - (a.stage === 'inbound' ? 1 : 0)
    || (Number(b.heat) || 0) - (Number(a.heat) || 0)
    || (a.created_at || 0) - (b.created_at || 0));
  return rows.slice(0, limit);
}

// Leads whose next touch is due on or before today and aren't closed out.
async function getLeadsDue(dateStr) {
  const rows = (await allLeads()).filter((l) => l.next_touch && l.next_touch <= dateStr && !['won', 'lost'].includes(l.stage));
  rows.sort((a, b) => String(a.next_touch).localeCompare(String(b.next_touch)));
  return rows;
}

module.exports = { LEAD_FIELDS, leadHasContact, addLead, updateLead, appendLeadLog, leadExists, getLeadsForOutreach, getLeadsDue, todayET };
