// Single shared bearer token. The owner sets SYNC_TOKEN as a server secret and
// pastes the same value into the app (Settings -> Backend).
module.exports = function auth(req, res, next) {
  const expected = process.env.SYNC_TOKEN;
  if (!expected) return res.status(503).json({ error: 'SYNC_TOKEN not configured on server' });
  const got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (got !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
};
