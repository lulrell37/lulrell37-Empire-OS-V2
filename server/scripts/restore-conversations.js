// Put back conversations from the Drive backup (server/chatBackup.js).
//   node server/scripts/restore-conversations.js --dry            every day file, count only
//   node server/scripts/restore-conversations.js 2026-11-20 …     just those days
// Only messages missing from tg_messages are added, so running it twice is safe.
require('dotenv').config();
const args = process.argv.slice(2);
require('../chatBackup').restore({ dry: args.includes('--dry'), days: args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) })
  .then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error('restore failed:', e.message); process.exit(1); });
