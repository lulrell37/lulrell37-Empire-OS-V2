// J.A.R.V.I.S.'s read-only window into the Empire OS source — the app (src/,
// App.js) and this server — so "look at the code" gets a real answer instead
// of a guess. Reads GitHub `main` (latest merged code, refreshed when main
// moves) when GITHUB_TOKEN is set, else the checkout this server was deployed
// from. Text files only; gitignored secrets like DEPLOY_BACKEND.md never show.
//
//   [CODE_TREE] / [CODE_TREE: src/services]   list files
//   [READ_CODE: server/personaRuntime.js]     read a file (paged; "| 2", "| all")
//   [SEARCH_CODE: relayAllowed]               grep the repo
//
// empireOsBrief() is the always-on knowledge block: AGENTS.md (the build notes)
// plus the file map, folded into his prompt.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let briefCache = null; // { sha, text }
const PAGE = 14000; // chars per READ_CODE page
const TEXT = /\.(js|jsx|ts|tsx|json|md|sql|yml|yaml|sh|txt|html|css|gradle|xml|properties|toml)$/i;
const DENY = /(^|\/)(\.env|DEPLOY_BACKEND\.md|google-services\.json|node_modules\/|\.git\/|package-lock\.json)|\.(pem|key|p8|p12|jks)$/i;

// Two sources. With GITHUB_TOKEN: the repo's `main` on GitHub — always the
// latest merged code (a Claude Code PR he just merged included), re-checked
// every 2 minutes and re-downloaded only when main moves. Without it, or if
// GitHub is unreachable: the checkout this server was deployed from (current
// as of the last deploy). git-tracked / text files only, secrets denied.
const os = require('os');
const SHA_TTL = 2 * 60e3;
let snap = null; // { root, files, label, sha, checkedAt }

function walk(root) {
  const files = [];
  const go = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (/^(\.git|node_modules|dist|\.expo)$/.test(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) go(rel); else files.push(rel);
    }
  };
  go('');
  return files;
}
const keep = (files) => files.filter((f) => f && TEXT.test(f) && !DENY.test(f));

let diskSnap = null;
function diskSource() {
  if (diskSnap) return diskSnap;
  let files = [];
  try { files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 << 20 }).split('\n'); } catch { /* no git */ }
  if (!files.filter(Boolean).length) { try { files = walk(ROOT); } catch { files = []; } }
  let sha = '';
  try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* */ }
  diskSnap = { root: ROOT, files: keep(files), sha, label: `the code this server was deployed with${sha ? ` (commit ${sha})` : ''} — may be behind GitHub main` };
  return diskSnap;
}

async function githubSource() {
  const { REPO, gh } = require('./buildAgent');
  const head = await gh(`/repos/${REPO.owner}/${REPO.repo}/commits/main`);
  const sha = String(head.sha || '').slice(0, 12);
  if (snap && snap.sha === sha) { snap.checkedAt = Date.now(); return snap; }
  const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/tarball/${head.sha}`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`GitHub tarball ${res.status}`);
  const dir = path.join(os.tmpdir(), `empire-code-${sha}`);
  const tgz = `${dir}.tgz`;
  fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1']);
  fs.rmSync(tgz, { force: true });
  if (snap && snap.root !== dir) fs.rm(snap.root, { recursive: true, force: true }, () => {});
  const when = head.commit?.committer?.date ? new Date(head.commit.committer.date).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '';
  const msg = String(head.commit?.message || '').split('\n')[0].slice(0, 80);
  snap = { root: dir, files: keep(walk(dir)), sha, checkedAt: Date.now(), label: `GitHub main @ ${sha}${when ? `, ${when} ET` : ''}${msg ? ` — "${msg}"` : ''} (the latest merged code)` };
  briefCache = null; // the build notes may have changed with it
  return snap;
}

let lastGhError = null;
async function source() {
  if (snap && Date.now() - snap.checkedAt < SHA_TTL) return snap;
  if (process.env.GITHUB_TOKEN) {
    try { const s = await githubSource(); lastGhError = null; return s; } catch (e) {
      lastGhError = e.message;
      console.error('codeAccess: GitHub snapshot failed —', e.message);
      if (snap) return snap; // last good GitHub copy beats the deploy copy
    }
  }
  return diskSource();
}

const allFiles = async () => (await source()).files;
async function readRaw(rel) {
  const s = await source();
  return fs.readFileSync(path.join(s.root, rel), 'utf8');
}

// Exact path, else the one file whose path ends with what he typed.
async function resolve(ref) {
  const want = String(ref || '').trim().replace(/^\.?\//, '');
  const files = await allFiles();
  if (files.includes(want)) return want;
  const hits = files.filter((f) => f.endsWith(`/${want}`) || f.toLowerCase().endsWith(want.toLowerCase()));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`"${want}" matches several files: ${hits.slice(0, 8).join(', ')} — use the full path`);
  throw new Error(`no file "${want}" in the repo — [CODE_TREE] lists them`);
}

async function codeTree(dir = '') {
  const d = String(dir || '').trim().replace(/^\.?\/|\/$/g, '');
  const files = (await allFiles()).filter((f) => !d || f.startsWith(`${d}/`));
  if (!files.length) return `no files under "${d}"`;
  return `${files.length} files${d ? ` under ${d}/` : ''}:\n${files.slice(0, 400).join('\n')}${files.length > 400 ? `\n… ${files.length - 400} more — narrow it with [CODE_TREE: folder]` : ''}`;
}

async function readCode(arg) {
  const [ref, pg] = String(arg || '').split('|').map((s) => s.trim());
  const rel = await resolve(ref);
  const text = await readRaw(rel);
  const lines = text.split('\n');
  // Pages of whole lines, ~PAGE chars each.
  const pages = [];
  let cur = [];
  let size = 0;
  lines.forEach((l, i) => {
    const row = `${i + 1}: ${l}`;
    if (size + row.length > PAGE && cur.length) { pages.push(cur.join('\n')); cur = []; size = 0; }
    cur.push(row);
    size += row.length + 1;
  });
  if (cur.length) pages.push(cur.join('\n'));
  if (/^all$/i.test(pg || '')) return `${rel} (${lines.length} lines):\n${pages.join('\n').slice(0, PAGE * 4)}`;
  const n = Math.min(pages.length, Math.max(1, parseInt(pg, 10) || 1));
  return `${rel} (${lines.length} lines) — page ${n} of ${pages.length}${n < pages.length ? ` · next: [READ_CODE: ${rel} | ${n + 1}]` : ''}\n${pages[n - 1] || ''}`;
}

async function searchCode(q) {
  const needle = String(q || '').trim();
  if (!needle) return 'SEARCH_CODE needs something to look for';
  const src = await source();
  const lower = needle.toLowerCase();
  const out = [];
  for (const f of src.files) {
    if (out.length >= 60) break;
    let text;
    try { text = fs.readFileSync(path.join(src.root, f), 'utf8'); } catch { continue; }
    if (!text.toLowerCase().includes(lower)) continue;
    text.split('\n').forEach((l, i) => {
      if (out.length < 60 && l.toLowerCase().includes(lower)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`);
    });
  }
  return out.length ? `"${needle}" in the code (${src.label}):\n${out.join('\n')}${out.length >= 60 ? '\n… (first 60 hits — search something more specific)' : ''}` : `nothing in the repo mentions "${needle}" (${src.label})`;
}

// What Empire OS is and how it's built — AGENTS.md plus the file map. Cached;
// it only changes when the code does.
async function empireOsBrief() {
  const src = await source();
  if (briefCache && briefCache.sha === src.sha) return briefCache.text;
  try {
    const notes = await readRaw('AGENTS.md');
    const files = await allFiles();
    const map = files.filter((f) => /^(App\.js|src\/|server\/[^/]+\.js$|server\/routes\/|\.github\/workflows\/)/.test(f));
    briefCache = { sha: src.sha, text: `[EMPIRE OS — HOW IT'S BUILT. You know this system inside out: this is its build notes (AGENTS.md) and file map, from ${src.label}. Your code tags read that same copy. For anything deeper, read the actual code with [SEARCH_CODE] / [READ_CODE] before answering — never guess how something works.\n\n${notes}\n\nFILE MAP (${map.length} source files):\n${map.join('\n')}\n]` };
    return briefCache.text;
  } catch (e) {
    return `[EMPIRE OS: couldn't load the build notes (${e.message}). Use [SEARCH_CODE] / [READ_CODE] to look at the code directly.]`;
  }
}

const CODE_TAGS = new Set(['CODE_TREE', 'READ_CODE', 'SEARCH_CODE']);
async function codeTag(name, arg) {
  if (name === 'CODE_TREE') return codeTree(arg);
  if (name === 'READ_CODE') return readCode(arg);
  if (name === 'SEARCH_CODE') return searchCode(arg);
  return '';
}

module.exports = { CODE_TAGS, codeTag, codeTree, readCode, searchCode, empireOsBrief };
