// The Empire site: every "Contact me / Apply / RSVP / Reserve your seat" button opens
// one form; it and the newsletter post to /empire/api/form, which tells Tarell.
(function () {
  var dlg = document.getElementById('formdlg');
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-form]');
    if (!b || !dlg) return;
    e.preventDefault();
    var topic = b.getAttribute('data-form');
    dlg.querySelector('.ftitle').textContent = topic;
    dlg.querySelector('[name=topic]').value = topic + ' — ' + document.title;
    dlg.querySelector('.msg').textContent = '';
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  });
  function send(form) {
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    data.kind = form.getAttribute('data-kind');
    data.page = location.pathname;
    var msg = form.querySelector('.msg');
    msg.textContent = 'Sending…';
    return fetch('api/form', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'failed'); return j; }); })
      .then(function () { msg.textContent = data.kind === 'newsletter' ? "You're subscribed. Welcome to The Empire." : "Got it — we'll be in touch soon."; form.reset(); })
      .catch(function (e) { msg.textContent = "Couldn't send that (" + e.message + '). Please try again.'; });
  }
  document.querySelectorAll('form[data-kind]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      send(f).then(function () { if (f.closest('dialog')) setTimeout(function () { dlg.close(); }, 1400); });
    });
  });
  // Pause the motivation clips that aren't on screen.
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (x) { if (x.isIntersecting) { x.target.play && x.target.play().catch(function () {}); } else { x.target.pause && x.target.pause(); } });
    }, { threshold: 0.15 });
    document.querySelectorAll('video').forEach(function (v) { io.observe(v); });
  }
})();
