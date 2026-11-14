/*
 * Chat de la Résidence de l'Industrie — widget à intégrer au site internet.
 *
 * Intégration : ajouter avant </body> sur chaque page du site
 *   <script src="https://VOTRE-APP.onrender.com/chat-widget.js" defer></script>
 *
 * Options (attributs data- de la balise script, tous facultatifs) :
 *   data-api    adresse du serveur du bot (par défaut : le serveur qui sert ce fichier)
 *   data-color  couleur principale, ex. #1f3a5f
 *   data-title  titre de la fenêtre
 *   data-privacy  adresse de la page « données personnelles » du site (lien affiché sous la fenêtre)
 */
(function () {
  'use strict';
  if (window.__rdiChatLoaded) return;
  window.__rdiChatLoaded = true;

  var script = document.currentScript;
  var base = '';
  try {
    base = (script && script.getAttribute('data-api')) || (script && script.src ? new URL(script.src).origin : '');
  } catch (e) { base = ''; }
  base = String(base).replace(/\/+$/, '');
  var color = /^#[0-9a-f]{3,8}$/i.test((script && script.getAttribute('data-color')) || '') ? script.getAttribute('data-color') : '#1f3a5f';
  var title = (script && script.getAttribute('data-title')) || "Assistant virtuel — Résidence de l'Industrie";
  var privacyUrl = (script && script.getAttribute('data-privacy')) || '';
  if (!/^https:\/\//i.test(privacyUrl)) privacyUrl = '';

  var STORE_KEY = 'rdi-chat-v1';
  var MAX_SENT = 16;     // nombre de messages envoyés au serveur à chaque requête
  var MAX_LEN = 1000;    // longueur maximale d'un message du visiteur

  var state = { messages: [], sessionId: '', open: false, busy: false };

  function load() {
    try {
      var raw = window.sessionStorage.getItem(STORE_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.messages)) state.messages = d.messages.slice(-40);
      if (d && typeof d.sessionId === 'string' && /^[a-z0-9]{8,32}$/i.test(d.sessionId)) state.sessionId = d.sessionId;
    } catch (e) { /* stockage indisponible : le chat marche quand même */ }
  }
  function save() {
    try { window.sessionStorage.setItem(STORE_KEY, JSON.stringify({ messages: state.messages.slice(-40), sessionId: state.sessionId })); } catch (e) { /* ignoré */ }
  }

  // ---------- Interface (Shadow DOM : le style du site n'interfère pas) ----------
  var host = document.createElement('div');
  host.setAttribute('data-rdi-chat', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var css = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
    '.launcher{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:58px;height:58px;border-radius:50%;border:0;background:' + color + ';color:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center}',
    '.launcher:focus-visible,.send:focus-visible,.close:focus-visible,.foot a:focus-visible{outline:3px solid #ffbf47;outline-offset:2px}',
    '.launcher svg{width:28px;height:28px;fill:#fff}',
    '.panel{position:fixed;right:18px;bottom:88px;z-index:2147483000;width:360px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 110px);background:#fff;color:#1c1c1c;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden}',
    '.panel.open{display:flex}',
    '.head{background:' + color + ';color:#fff;padding:12px 14px;display:flex;align-items:center;gap:8px}',
    '.head .t{flex:1;font-size:14px;font-weight:600;line-height:1.25}',
    '.close{background:transparent;border:0;color:#fff;font-size:24px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:6px}',
    '.list{flex:1;overflow-y:auto;padding:12px;background:#f4f5f7;display:flex;flex-direction:column;gap:8px}',
    '.msg{max-width:86%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}',
    '.msg.bot{background:#fff;border:1px solid #e1e3e8;align-self:flex-start;border-bottom-left-radius:4px}',
    '.msg.user{background:' + color + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}',
    '.msg a{color:inherit;text-decoration:underline}',
    '.msg.bot a{color:' + color + '}',
    '.note{font-size:12px;color:#5b6270;text-align:center;padding:2px 6px}',
    '.typing{align-self:flex-start;color:#5b6270;font-size:13px;padding:2px 6px}',
    '.form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e1e3e8;background:#fff}',
    '.form textarea{flex:1;resize:none;height:42px;max-height:96px;padding:9px 10px;border:1px solid #c9ccd3;border-radius:10px;font-size:14px}',
    '.send{border:0;background:' + color + ';color:#fff;border-radius:10px;padding:0 14px;font-size:14px;cursor:pointer}',
    '.send:disabled{opacity:.5;cursor:default}',
    '.foot{font-size:11px;color:#5b6270;text-align:center;padding:0 10px 8px;background:#fff;line-height:1.35}',
    '.foot a{color:' + color + ';text-decoration:underline}',
    '@media (max-width:480px){.panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100vh;max-height:100vh;border-radius:0}.launcher{right:12px;bottom:12px}}',
    '@media (prefers-reduced-motion:no-preference){.panel.open{animation:rdi-in .18s ease-out}@keyframes rdi-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}'
  ].join('\n');

  var style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  var launcher = el('button', 'launcher', { type: 'button', 'aria-label': 'Ouvrir le chat', 'aria-expanded': 'false' });
  launcher.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>';

  var panel = el('div', 'panel', { role: 'dialog', 'aria-label': title });
  var head = el('div', 'head');
  var ttl = el('div', 't'); ttl.textContent = title;
  var closeBtn = el('button', 'close', { type: 'button', 'aria-label': 'Fermer le chat' }); closeBtn.textContent = '×';
  head.appendChild(ttl); head.appendChild(closeBtn);

  var list = el('div', 'list', { role: 'log', 'aria-live': 'polite' });

  var form = el('div', 'form');
  var input = el('textarea', '', { placeholder: 'Écrivez votre message…', maxlength: String(MAX_LEN), 'aria-label': 'Votre message', rows: '1' });
  var sendBtn = el('button', 'send', { type: 'button' }); sendBtn.textContent = 'Envoyer';
  form.appendChild(input); form.appendChild(sendBtn);

  var foot = el('div', 'foot');
  foot.appendChild(document.createTextNode("Assistant automatisé (IA) : vos messages sont transmis à un prestataire d'intelligence artificielle pour y répondre. N'y indiquez aucune donnée bancaire ni information sensible."));
  if (privacyUrl) {
    foot.appendChild(document.createTextNode(' '));
    var pa = document.createElement('a'); pa.href = privacyUrl; pa.target = '_blank'; pa.rel = 'noopener noreferrer'; pa.textContent = 'Données personnelles';
    foot.appendChild(pa);
  }

  panel.appendChild(head); panel.appendChild(list); panel.appendChild(form); panel.appendChild(foot);
  root.appendChild(launcher); root.appendChild(panel);

  // ---------- Affichage des messages ----------
  var URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

  function renderText(node, text) {
    var last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a');
      a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = m[0];
      node.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  function addBubble(role, text) {
    var b = el('div', 'msg ' + (role === 'user' ? 'user' : 'bot'));
    renderText(b, text);
    list.appendChild(b);
    list.scrollTop = list.scrollHeight;
    return b;
  }

  function showTyping(on) {
    var t = list.querySelector('.typing');
    if (on && !t) {
      t = el('div', 'typing'); t.textContent = "L'assistant écrit…"; list.appendChild(t);
    } else if (!on && t) t.remove();
    list.scrollTop = list.scrollHeight;
  }

  function renderAll() {
    list.textContent = '';
    addBubble('bot', "Bonjour ! Posez-moi votre question sur la Résidence ou sur votre séjour.");
    state.messages.forEach(function (m) { addBubble(m.role, m.content); });
  }

  // ---------- Envoi ----------
  function send() {
    if (state.busy) return;
    var text = input.value.trim();
    if (!text) return;
    state.messages.push({ role: 'user', content: text.slice(0, MAX_LEN) });
    addBubble('user', text);
    input.value = '';
    save();
    state.busy = true; sendBtn.disabled = true; showTyping(true);

    var payload = { messages: state.messages.slice(-MAX_SENT), sessionId: state.sessionId };

    fetch(base + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    }).then(function (res) {
      showTyping(false);
      if (!res.ok) {
        var msg = res.status === 429
          ? 'Beaucoup de demandes en ce moment : réessayez dans quelques minutes.'
          : 'Le service est momentanément indisponible. Vous pouvez aussi nous écrire via Airbnb ou Booking.';
        if (res.data && res.data.error && res.status === 429) msg = res.data.error;
        addBubble('bot', msg);
        return;
      }
      var reply = '';
      var c = res.data && res.data.content;
      if (Array.isArray(c)) reply = c.map(function (x) { return x && x.text ? x.text : ''; }).join('\n').trim();
      if (!reply) reply = "Désolé, je n'ai pas pu répondre. Pouvez-vous reformuler ?";
      state.messages.push({ role: 'assistant', content: reply });
      addBubble('bot', reply);
      save();
    }).catch(function () {
      showTyping(false);
      addBubble('bot', 'Connexion impossible pour le moment. Vérifiez votre connexion et réessayez.');
    }).then(function () {
      state.busy = false; sendBtn.disabled = false; input.focus();
    });
  }

  // ---------- Événements ----------
  function setOpen(v) {
    state.open = v;
    panel.classList.toggle('open', v);
    launcher.setAttribute('aria-expanded', v ? 'true' : 'false');
    launcher.setAttribute('aria-label', v ? 'Fermer le chat' : 'Ouvrir le chat');
    if (v) { list.scrollTop = list.scrollHeight; setTimeout(function () { input.focus(); }, 50); }
    else launcher.focus();
  }

  launcher.addEventListener('click', function () { setOpen(!state.open); });
  closeBtn.addEventListener('click', function () { setOpen(false); });
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  function mount() {
    load();
    if (!state.sessionId) {
      var chars = 'abcdefghijklmnopqrstuvwxyz0123456789', id = '';
      try { var arr = new Uint8Array(16); window.crypto.getRandomValues(arr); for (var i = 0; i < arr.length; i++) id += chars[arr[i] % chars.length]; }
      catch (e) { for (var k = 0; k < 16; k++) id += chars[Math.floor(Math.random() * chars.length)]; }
      state.sessionId = id; save();
    }
    renderAll();
    document.body.appendChild(host);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
