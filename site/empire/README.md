# The Empire — Tarell's website

Live at `<server>/empire/` (served by `server/routes/empireSite.js`). Rebuilt on 2026-11-23 from his
Canva website design "Welcome to The Empire" (`DAG_bBmR7rI`), 39 of its 53 pages (he left out Canva
pages 2, 5, 16, 20, 25, 29 and 46-53).

- **Pages** are plain HTML here, one file per page (`index.html` = Home). Edit them directly.
  On a computer every element sits where the Canva design put it (positions in %, text sized off the
  section width via container units); under 700px wide the same elements stack in one column
  (`style.css`). Layered pieces (the crown + TB logo) stay together as a group.
- **Media** (his photos and videos, ~37 MB) is NOT in the repo: it's in the GitHub release
  `empire-site-media`. `media.json` lists every file the pages use; the server fetches each once into
  `~/.empire-bin/site-media` and serves it. To add one: `gh release upload empire-site-media file.webp`,
  add it to `media.json`, reference it as `media/file.webp`.
- **Forms**: every "Contact me / Apply Here / RSVP / Reserve / Secure your seat" button opens one form
  (`app.js`); it and the footer newsletter POST to `/empire/api/form` → synced table `site_leads` +
  a message to him from A.R.A.'s bot. The Financial Literacy page keeps its Typeform embed.
- **Not carried over**: Canva Pro stock pictures (they only download watermarked) — the dark texture
  `media/texture.svg` stands in for the black backgrounds; the Empire Map's stock city picture is
  replaced by a grid of links; Canva-only fonts use the closest Google Fonts (`FONT` in the generator).
- **Regenerating from Canva** (only if he redesigns it there): `scripts/canva-site/` — `extract.py`
  reads the design JSON from the Canva view page's `window['bootstrap']`, `gen.py` writes the pages.
  Hand edits made here would be overwritten, so prefer editing the HTML.

`node server/scripts/test-empire-site.js` checks links, media and the form.
