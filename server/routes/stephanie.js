// S.T.E.P.H.A.N.I.E.'s course for the app, so the app and Telegram share one
// tracker (server/stephanieCourse.js) instead of keeping two that drift.
//
//   GET  /stephanie/course  -> { status, tools, tags }   her live course + tool lines
//   POST /stephanie/course  { tag, arg, asked } -> { text }   run one course tag
//
// `asked` is his message that turn: checks need his own word, same as on Telegram.
const express = require('express');
const course = require('../stephanieCourse');

const r = express.Router();

r.get('/course', async (req, res) => {
  try { res.json({ status: await course.statusText(), tools: course.COURSE_TOOLS, tags: [...course.COURSE_TAGS] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

r.post('/course', async (req, res) => {
  const { tag, arg = '', asked = '' } = req.body || {};
  const name = String(tag || '').toUpperCase();
  if (!course.COURSE_TAGS.has(name)) return res.status(400).json({ error: `unknown course tag ${tag}` });
  try { res.json({ text: await course.courseTag(name, String(arg || ''), String(asked || '')) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = r;
