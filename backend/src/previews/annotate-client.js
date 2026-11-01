/*
 * Skipper : annotations sur l'aperçu d'une branche (« je pointe, l'agent corrige »).
 * Injecté par le proxy des aperçus dans chaque page HTML (voir annotate.ts) ; servi tel quel, sans build.
 * Bouton « Annoter » → cliquer un élément → écrire ou dicter ce qu'il faut changer → « Envoyer à l'agent ».
 * L'interface vit dans un shadow DOM : elle ne touche ni aux styles ni au DOM de l'application.
 */
(function () {
  'use strict';
  if (window.__skipperAnnotate) return;
  window.__skipperAnnotate = true;

  var API = '/__skipper';
  var STORE = 'skipper-annotations:' + location.pathname + location.search;
  var HIDDEN = 'skipper-annotations-hidden';
  var Speech = window.SpeechRecognition || window.webkitSpeechRecognition;

  var state = { mode: false, items: [], note: '', session: null, sending: false, watching: false, error: '', hovered: null, editing: null };

  function load() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      if (saved && Array.isArray(saved.items)) {
        state.items = saved.items;
        state.note = saved.note || '';
      }
    } catch (e) {}
  }
  function save() {
    try {
      if (state.items.length || state.note) sessionStorage.setItem(STORE, JSON.stringify({ items: state.items, note: state.note }));
      else sessionStorage.removeItem(STORE);
    } catch (e) {}
  }

  /* ---------- Sélecteur CSS stable d'un élément ---------- */
  function esc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }
  /* Classes générées (modules CSS, styled-components…) : peu parlantes et instables, écartées. */
  function goodClass(c) {
    return c && c.length < 40 && !/^(css|sc|jsx|svelte|astro)-|[0-9a-f]{6,}|__[a-zA-Z0-9]{5}$|:/.test(c);
  }
  function part(el) {
    var tag = el.tagName.toLowerCase();
    var testid = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testid) return tag + '[data-testid="' + testid.replace(/"/g, '\\"') + '"]';
    if (el.id && !/\d{3,}|^:/.test(el.id)) return '#' + esc(el.id);
    var classes = Array.prototype.filter.call(el.classList, goodClass).slice(0, 2);
    var s = tag + classes.map(function (c) { return '.' + esc(c); }).join('');
    var parent = el.parentElement;
    if (parent) {
      var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return s;
  }
  function selectorOf(el) {
    var parts = [];
    for (var cur = el; cur && cur.nodeType === 1 && cur !== document.documentElement; cur = cur.parentElement) {
      parts.unshift(part(cur));
      var sel = parts.join(' > ');
      if (parts[0].charAt(0) === '#' || unique(sel)) return sel;
      if (parts.length >= 6) break;
    }
    return parts.join(' > ');
  }
  function describe(el) {
    var r = el.getBoundingClientRect();
    var html = el.outerHTML || '';
    if (html.length > 1500) html = html.slice(0, 1500) + '…';
    var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 200) text = text.slice(0, 200) + '…';
    return { selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: text, html: html, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
  }
  function find(sel) {
    try {
      return document.querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  /* ---------- Interface (shadow DOM) ---------- */
  var host = document.createElement('skipper-annotate');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483000;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.fab{position:fixed;right:16px;bottom:16px;pointer-events:auto;display:flex;align-items:center;gap:6px;background:#1f1f1f;color:#fff;border:1px solid #d97757;border-radius:999px;padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.3)}' +
    '.fab:hover{background:#2b2b2b}.fab.on{background:#d97757;color:#141414}' +
    '.fab .n{background:#d97757;color:#141414;border-radius:999px;padding:0 7px;font-size:12px}.fab.on .n{background:#141414;color:#fff}' +
    '.hide{position:fixed;right:8px;bottom:50px;pointer-events:auto;width:22px;height:22px;border-radius:50%;border:0;background:#1f1f1f;color:#aaa;font-size:13px;cursor:pointer;display:none}' +
    '.wrap:hover .hide{display:block}' +
    '.box{position:fixed;pointer-events:none;border:2px solid #d97757;background:rgba(217,119,87,.12);border-radius:3px;transition:all .06s}' +
    '.label{position:fixed;pointer-events:none;background:#d97757;color:#141414;font-size:11px;padding:1px 5px;border-radius:3px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}' +
    '.pin{position:fixed;pointer-events:auto;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#d97757;color:#141414;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);cursor:pointer}' +
    '.pop,.panel{position:fixed;pointer-events:auto;background:#1f1f1f;color:#eee;border:1px solid #444;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.45);font-size:13px}' +
    '.pop{width:min(340px,calc(100vw - 20px));padding:10px}' +
    '.panel{right:16px;bottom:66px;width:min(360px,calc(100vw - 32px));max-height:min(60vh,520px);display:flex;flex-direction:column}' +
    '.panel header{padding:10px 12px;border-bottom:1px solid #333;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:8px}' +
    '.panel .list{overflow:auto;padding:6px 12px;flex:1}' +
    '.item{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid #2c2c2c}.item:last-child{border-bottom:0}' +
    '.item .k{flex:0 0 20px;height:20px;border-radius:50%;background:#d97757;color:#141414;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}' +
    '.item .c{flex:1;white-space:pre-wrap;word-break:break-word}.item .s{display:block;color:#888;font-size:11px;margin-top:2px;word-break:break-all}' +
    '.x{background:none;border:0;color:#888;cursor:pointer;font-size:15px;line-height:1;padding:0 2px}.x:hover{color:#e5534b}' +
    '.field{position:relative}' +
    'textarea{width:100%;min-height:70px;resize:vertical;background:#141414;color:#eee;border:1px solid #444;border-radius:6px;padding:7px 34px 7px 8px;font-size:13px;line-height:1.4}' +
    'textarea:focus{outline:none;border-color:#d97757}' +
    '.mic{position:absolute;right:5px;bottom:7px;width:26px;height:26px;border-radius:6px;border:0;background:none;color:#aaa;cursor:pointer;font-size:15px}' +
    '.mic:hover{color:#fff;background:#333}.mic.rec{color:#e5534b;background:rgba(229,83,75,.15)}' +
    '.row{display:flex;gap:6px;justify-content:flex-end;align-items:center;margin-top:8px}' +
    '.btn{border:1px solid #555;background:#2b2b2b;color:#eee;border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer}' +
    '.btn:hover{border-color:#888}.btn.primary{background:#d97757;border-color:#d97757;color:#141414;font-weight:600}.btn:disabled{opacity:.5;cursor:default}' +
    '.foot{padding:10px 12px;border-top:1px solid #333}' +
    '.hint{color:#999;font-size:12px;margin:0 0 6px}.err{color:#ff8a80;font-size:12px;margin-top:6px}' +
    '.toast{position:fixed;left:50%;transform:translateX(-50%);top:14px;pointer-events:auto;background:#1f1f1f;color:#eee;border:1px solid #444;border-radius:999px;padding:8px 14px;font-size:13px;display:flex;gap:10px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:calc(100vw - 20px)}' +
    '.toast .msg{flex:1 1 auto;min-width:0}@media (max-width:600px){.toast{width:calc(100vw - 20px);border-radius:12px}}' +
    '.toast a{color:#f0a283}.dot{width:8px;height:8px;border-radius:50%;background:#d97757;animation:p 1s infinite alternate;flex:0 0 auto}.dot.ok{background:#57ab5a;animation:none}' +
    '@keyframes p{to{opacity:.3}}' +
    '.banner{position:fixed;left:50%;transform:translateX(-50%);top:14px;pointer-events:none;background:#d97757;color:#141414;border-radius:999px;padding:6px 14px;font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.3)}' +
    '</style><div class="wrap"><div class="ov"></div><div class="dlg"></div></div>';
  var ov = root.querySelector('.ov');
  var ui = root.querySelector('.dlg');

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  /* Dictée (Web Speech API) dans une zone de saisie. */
  var recognition = null;
  function micButton(textarea, onText) {
    if (!Speech) return null;
    var b = el('button', { class: 'mic', type: 'button', title: 'Dicter', text: '🎤' });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      if (recognition) {
        recognition.stop();
        return;
      }
      var base = textarea.value;
      var r = new Speech();
      r.lang = navigator.language || 'fr-FR';
      r.continuous = true;
      r.interimResults = true;
      r.onresult = function (ev) {
        var said = '';
        for (var i = 0; i < ev.results.length; i++) said += ev.results[i][0].transcript + ' ';
        said = said.replace(/\s+/g, ' ').trim();
        if (!base && said) said = said.charAt(0).toUpperCase() + said.slice(1);
        textarea.value = base ? (/\s$/.test(base) ? base : base + ' ') + said : said;
        onText && onText(textarea.value);
      };
      r.onerror = function (ev) {
        if (ev.error === 'not-allowed') b.title = 'Micro refusé : autorisez-le dans les réglages du navigateur';
      };
      r.onend = function () {
        recognition = null;
        b.classList.remove('rec');
      };
      recognition = r;
      b.classList.add('rec');
      try {
        r.start();
      } catch (err) {
        recognition = null;
        b.classList.remove('rec');
      }
    });
    return b;
  }
  function stopDictation() {
    if (recognition) recognition.stop();
  }

  function isBusy(s) {
    return !!s && ((s.status === 'running' && s.activity !== 'idle') || s.status === 'queued' || s.status === 'pending');
  }

  /* Calque des repères : numéros des éléments annotés, élément survolé, élément en cours d'annotation. */
  var raf = 0;
  function overlay() {
    raf = 0;
    ov.textContent = '';
    if (sessionStorage.getItem(HIDDEN)) return;
    var ui = ov;
    // Repères des éléments déjà annotés.
    state.items.forEach(function (it, i) {
      var target = find(it.selector);
      if (!target) return;
      var r = target.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      ui.appendChild(el('div', { class: 'pin', style: 'left:' + Math.max(12, r.left) + 'px;top:' + Math.max(12, r.top) + 'px', title: it.comment, text: String(i + 1), onclick: function () { state.panel = true; update(); } }));
    });

    // Élément survolé en mode annotation.
    if (state.mode && state.hovered && !state.editing) {
      var hr = state.hovered.getBoundingClientRect();
      ui.appendChild(el('div', { class: 'box', style: 'left:' + hr.left + 'px;top:' + hr.top + 'px;width:' + hr.width + 'px;height:' + hr.height + 'px' }));
      ui.appendChild(el('div', { class: 'label', style: 'left:' + Math.max(4, hr.left) + 'px;top:' + Math.max(4, hr.top - 18) + 'px', text: part(state.hovered) }));
    }
    if (state.mode && !state.editing) ui.appendChild(el('div', { class: 'banner', text: 'Cliquez sur l’élément à modifier · Échap pour quitter' }));
    if (state.editing && state.editing.target.isConnected) {
      var cr = state.editing.target.getBoundingClientRect();
      ui.appendChild(el('div', { class: 'box', style: 'left:' + cr.left + 'px;top:' + cr.top + 'px;width:' + cr.width + 'px;height:' + cr.height + 'px' }));
    }
  }

  /* Calque des dialogues : reconstruit seulement quand l'état change (jamais au défilement : la saisie garderait mal le focus). */
  function dialogs() {
    ui.textContent = '';
    if (sessionStorage.getItem(HIDDEN)) return;
    var count = state.items.length;

    // Commentaire de l'élément choisi (placé une fois, près de l'élément).
    if (state.editing) {
      var er = state.editing.rect;
      var popW = Math.min(340, innerWidth - 20);
      var left = Math.min(Math.max(10, er.left), innerWidth - popW - 10);
      var below = er.bottom + 8;
      var top = below + 190 < innerHeight ? below : Math.max(10, er.top - 198);
      var ta = el('textarea', { placeholder: 'Que faut-il changer ? (ex. « plus gros et en vert », « ce texte doit dire… »)' });
      ta.value = state.editing.comment;
      ta.addEventListener('input', function () { state.editing.comment = ta.value; });
      ta.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addCurrent();
        if (e.key === 'Escape') cancelEdit();
      });
      var pop = el('div', { class: 'pop', style: 'left:' + left + 'px;top:' + top + 'px' }, [
        el('p', { class: 'hint', text: '<' + state.editing.info.tag + '> ' + (state.editing.info.text ? '« ' + state.editing.info.text.slice(0, 60) + ' »' : '') }),
        el('div', { class: 'field' }, [ta, micButton(ta, function (v) { state.editing.comment = v; })]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: cancelEdit }),
          el('button', { class: 'btn primary', type: 'button', text: 'Ajouter', onclick: addCurrent }),
        ]),
      ]);
      ui.appendChild(pop);
      setTimeout(function () { ta.focus(); }, 0);
    }

    // Liste des annotations et envoi.
    if ((count || state.panel) && !state.editing) {
      var list = el('div', { class: 'list' });
      if (!count) list.appendChild(el('p', { class: 'hint', text: 'Aucun élément annoté. Cliquez sur « Annoter » puis sur un élément de la page.' }));
      state.items.forEach(function (it, i) {
        list.appendChild(el('div', { class: 'item' }, [
          el('span', { class: 'k', text: String(i + 1) }),
          el('span', { class: 'c', text: it.comment }, [el('span', { class: 's', text: it.selector })]),
          el('button', { class: 'x', type: 'button', title: 'Retirer', text: '×', onclick: function () { state.items.splice(i, 1); save(); update(); } }),
        ]));
      });
      var note = el('textarea', { placeholder: 'Remarque générale (facultatif)' });
      note.style.minHeight = '44px';
      note.value = state.note;
      note.addEventListener('input', function () {
        var was = !!state.note.trim();
        state.note = note.value;
        save();
        // Le bouton d'envoi suit la saisie sans reconstruire le panneau (le focus resterait sinon en route).
        if (was !== !!state.note.trim()) send.disabled = state.sending || (!count && !state.note.trim());
      });
      note.addEventListener('keydown', function (e) { e.stopPropagation(); });
      var send = el('button', { class: 'btn primary', type: 'button', text: state.sending ? 'Envoi…' : 'Envoyer à l’agent' + (count ? ' (' + count + ')' : ''), onclick: sendAll });
      if (state.sending || (!count && !state.note.trim())) send.disabled = true;
      var target = state.session ? 'Session « ' + state.session.name + ' »' : '';
      ui.appendChild(el('div', { class: 'panel' }, [
        el('header', {}, [el('span', { text: 'Annotations' }), el('button', { class: 'x', type: 'button', title: 'Fermer', text: '×', onclick: function () { state.panel = false; update(); } })]),
        list,
        el('div', { class: 'foot' }, [
          el('div', { class: 'field' }, [note, micButton(note, function (v) { state.note = v; save(); })]),
          state.error ? el('div', { class: 'err', text: state.error }) : null,
          el('div', { class: 'row' }, [target ? el('span', { class: 'hint', style: 'margin:0 auto 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: target }) : null, send]),
        ]),
      ]));
    }

    // Suivi du travail de l'agent après l'envoi.
    if (state.watching && state.session) {
      var busy = isBusy(state.session);
      ui.appendChild(el('div', { class: 'toast' }, [
        el('span', { class: 'dot' + (busy ? '' : ' ok') }),
        el('span', { class: 'msg', text: busy ? 'L’agent applique vos annotations… la page se mettra à jour toute seule.' : 'C’est fait : l’agent a terminé.' }),
        busy ? null : el('button', { class: 'btn', type: 'button', text: 'Recharger', onclick: function () { location.reload(); } }),
        el('a', { href: state.session.url, target: '_blank', rel: 'noopener', text: 'Voir la session' }),
        el('button', { class: 'x', type: 'button', title: 'Masquer', text: '×', onclick: function () { state.watching = false; update(); } }),
      ]));
    }

    var fab = el('button', { class: 'fab' + (state.mode ? ' on' : ''), type: 'button', title: 'Annoter la page pour l’agent de cette branche (Skipper)' }, [
      el('span', { text: state.mode ? '✕ Terminer' : '✎ Annoter' }),
      count ? el('span', { class: 'n', text: String(count) }) : null,
    ]);
    fab.addEventListener('click', function () {
      state.mode = !state.mode;
      state.hovered = null;
      if (!state.mode && count) state.panel = true;
      update();
    });
    ui.appendChild(fab);
    ui.appendChild(el('button', { class: 'hide', type: 'button', title: 'Masquer le bouton jusqu’à la fermeture de l’onglet', text: '×', onclick: function () { sessionStorage.setItem(HIDDEN, '1'); state.mode = false; update(); } }));
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(overlay);
  }
  function update() {
    dialogs();
    schedule();
  }

  function cancelEdit() {
    stopDictation();
    state.editing = null;
    update();
  }
  function addCurrent() {
    stopDictation();
    var e = state.editing;
    if (!e || !e.comment.trim()) return;
    var info = e.info;
    state.items.push({ comment: e.comment.trim(), selector: info.selector, tag: info.tag, text: info.text, html: info.html, rect: info.rect });
    state.editing = null;
    state.error = '';
    save();
    update();
  }

  function api(path, body) {
    var opts = { credentials: 'same-origin', headers: {} };
    if (body) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-Skipper-Annotation'] = '1';
      opts.body = JSON.stringify(body);
    }
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Erreur ' + r.status);
        return data;
      });
    });
  }

  function sendAll() {
    stopDictation();
    state.sending = true;
    state.error = '';
    update();
    api('/annotations', {
      page: location.pathname + location.search + location.hash,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      note: state.note,
      annotations: state.items,
    }).then(function (data) {
      state.items = [];
      state.note = '';
      state.panel = false;
      state.mode = false;
      save();
      state.session = data.session;
      startWatching();
    }, function (err) {
      state.error = err.message;
    }).then(function () {
      state.sending = false;
      update();
    });
  }

  /* Après l'envoi : suit l'état de la session (survit au rechargement de la page par le serveur de développement). */
  var WATCH = 'skipper-annotations-watch';
  var timer = 0;
  function startWatching() {
    state.watching = true;
    try { sessionStorage.setItem(WATCH, String(Date.now())); } catch (e) {}
    clearTimeout(timer);
    timer = setTimeout(poll, 2500);
  }
  function poll() {
    api('/session').then(function (data) {
      state.session = data.session;
      if (isBusy(data.session)) timer = setTimeout(poll, 3000);
      else try { sessionStorage.removeItem(WATCH); } catch (e) {}
      update();
    }, function () {
      timer = setTimeout(poll, 6000);
    });
  }

  /* ---------- Choix d'un élément ---------- */
  function ours(e) {
    return e.composedPath && e.composedPath().indexOf(host) >= 0;
  }
  function targetAt(x, y) {
    host.style.display = 'none';
    var t = document.elementFromPoint(x, y);
    host.style.display = '';
    return t && t !== document.documentElement && t !== document.body ? t : null;
  }
  document.addEventListener('mousemove', function (e) {
    if (!state.mode || state.editing || ours(e)) return;
    var t = targetAt(e.clientX, e.clientY);
    if (t !== state.hovered) {
      state.hovered = t;
      schedule();
    }
  }, true);
  /* En mode annotation, un clic choisit l'élément au lieu de l'activer (lien, bouton, formulaire). */
  function swallow(e) {
    if (!state.mode || ours(e)) return;
    // Pas de preventDefault sur le toucher : il annulerait le clic qui choisit l'élément (et le défilement de la page).
    if (e.type.slice(0, 5) !== 'touch') e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }
  ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'touchstart', 'touchend', 'submit'].forEach(function (type) {
    document.addEventListener(type, swallow, { capture: true, passive: false });
  });
  document.addEventListener('click', function (e) {
    if (!state.mode || ours(e)) return;
    swallow(e);
    if (state.editing) return cancelEdit();
    var t = targetAt(e.clientX, e.clientY);
    if (!t) return;
    state.hovered = null;
    state.editing = { target: t, info: describe(t), rect: t.getBoundingClientRect(), comment: '' };
    update();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !state.mode) return;
    if (state.editing) cancelEdit();
    else {
      state.mode = false;
      if (state.items.length) state.panel = true;
      update();
    }
  }, true);
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);

  /* ---------- Démarrage : seulement si la personne peut donner des instructions à une session de la branche. ---------- */
  function start() {
    api('/session').then(function (data) {
      if (!data.canAnnotate) return;
      state.session = data.session;
      load();
      (document.body || document.documentElement).appendChild(host);
      // Les applications qui réécrivent tout le <body> (rendu côté client) peuvent retirer le bouton : on le remet.
      new MutationObserver(function () {
        if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
        if (state.items.length) schedule();
      }).observe(document.documentElement, { childList: true, subtree: true });
      var since = Number(sessionStorage.getItem(WATCH) || 0);
      if (since && Date.now() - since < 30 * 60000) {
        state.watching = true;
        poll();
      }
      update();
    }, function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
