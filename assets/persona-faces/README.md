# Persona faces & body types

Face photos are **not** dropped in as files here — Metro (the bundler) can only ship a file
that's referenced by a literal `require(...)` somewhere in the code, which doesn't work for
photos that are optional per-persona. Instead, THE OFFICE reuses the photo picker Settings
already has: open Settings, tap a persona's circle, pick a square photo — same feature that
already sets the little orb thumbnail. Whatever's set there is what shows on that persona's
3D head; any persona left unset gets a plain head tinted in their own `persona.color`.

Only use photos you have the rights to use this way (stock photos, AI-generated portraits,
or people who've consented) — this app is private, but the photo still gets textured onto a
real 3D character on Mr. Burrus's own screen.

## Body type

`body-types.json` in this same folder maps each persona id to a build — `"slim"`,
`"average"`, or `"heavy"` — used to pick which rigged base body that persona's character
clones from (all three share one skeleton/animation set, so this is purely a visual pick).
Edit the value next to a persona's id; anything left as `"average"` (or missing entirely)
just uses the default build.
