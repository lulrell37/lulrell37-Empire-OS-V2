// GET /sites/<slug> — a website the desk built (server/siteDesk.js). Public: the
// business owner opens it from the email. Sandboxed (its own origin, so the page
// can't touch this server's API) and never indexed.
const express = require('express');

const router = express.Router();

router.get('/:slug', async (req, res) => {
  try {
    const html = await require('../siteDesk').getHtml(req.params.slug);
    if (!html) return res.status(404).type('text/plain').send('This page is no longer available.');
    res.set({
      'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation',
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'no-cache',
    });
    res.type('html').send(html);
  } catch (e) {
    console.error('site page failed:', e.message);
    res.status(500).type('text/plain').send('Something went wrong loading this page.');
  }
});

module.exports = router;
