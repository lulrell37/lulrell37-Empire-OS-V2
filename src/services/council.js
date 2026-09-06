// Convene the nightly Empire Council on demand.
//
// A.R.A. emits [COUNCIL_CONVENE] when Mr. Burrus wants the council to meet now
// instead of waiting for 5am. We force a sync first so any [COUNCIL_NOTE] brief
// or [COUNCIL_IDEA] he just gave her is on the backend before the meeting reads
// it, then hit POST /council/run. The meeting runs a few minutes server-side and
// lands the usual "the council met" push + transcript note when it's done.
import { loadBackend } from './keyStore';
import { runSync } from './sync';

export async function convokeCouncil() {
  const be = await loadBackend();
  if (!be) throw new Error('Connect a backend in Settings first');
  // Two passes: the first may be joining a sync already in flight that predates
  // the note we just wrote; the second is guaranteed to push it.
  try { await runSync(); await runSync(); } catch {}
  const res = await fetch(be.url + '/council/run', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + be.token },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}
