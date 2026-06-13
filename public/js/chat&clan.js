/**
 * public/js/chat&clan.js — Global chat + Clan panel (client-side)
 *
 * Drop  <script nonce="__CSP_NONCE__" src="/js/chat&clan.js"></script>
 * after app.js in index.html (replaces chat.js).
 *
 * Requires app.js to expose after login / session restore:
 *   window.__username — logged-in username string
 *   window.__token    — session Bearer token string
 *
 * Requires the SSE handler (broadcast.js) to forward:
 *   if (data.type === 'chat')       window.__chatIncoming?.(data);
 *   if (data.type === 'clan_chat')  window.__clanChatIncoming?.(data);
 *   if (data.type === 'clan_event') window.__clanEventIncoming?.(data);
 *
 * Optional profile click-through:
 *   window.__openProfile = (username) => { ... };
 *
 * Security notes:
 * - All user content rendered via textContent / dataset, never innerHTML.
 */

(function () {
  'use strict';

  const MAX_DISPLAY   = 200;
  const COOLDOWN_MS   = 2_000;

  // ── DOM refs — shell ────────────────────────────────────────────────────
  const toggleBtn   = document.getElementById('chatclan-toggle-btn');
  const panel       = document.getElementById('chatclan-panel');
  const closeBtn    = document.getElementById('chatclan-close-btn');
  const unreadBadge = document.getElementById('chatclan-unread');

  const tabGlobal   = document.getElementById('cc-tab-global');
  const tabClan     = document.getElementById('cc-tab-clan');
  const globalBadge = document.getElementById('cc-global-badge');
  const clanBadge   = document.getElementById('cc-clan-badge');

  const pageGlobal  = document.getElementById('cc-page-global');
  const pageClan    = document.getElementById('cc-page-clan');

  if (!panel || !toggleBtn) return;

  // ── Global chat refs ────────────────────────────────────────────────────
  const globalList     = document.getElementById('cc-global-messages');
  const globalForm     = document.getElementById('cc-global-form');
  const globalInput    = document.getElementById('cc-global-input');
  const globalSendBtn  = document.getElementById('cc-global-send');
  const globalDownload = document.getElementById('cc-global-download');

  // ── Clan refs ────────────────────────────────────────────────────────────
  const clanLanding   = document.getElementById('cc-clan-landing');
  const landingCreate = document.getElementById('cc-landing-create');
  const landingJoin   = document.getElementById('cc-landing-join');

  const createPanel   = document.getElementById('cc-create-panel');
  const createBack    = document.getElementById('cc-create-back');
  const createName    = document.getElementById('cc-create-name');
  const createDesc    = document.getElementById('cc-create-desc');
  const createEmoji   = document.getElementById('cc-create-emoji');
  const createOpen    = document.getElementById('cc-create-open');
  const createSubmit  = document.getElementById('cc-create-submit');

  const searchPanel   = document.getElementById('cc-search-panel');
  const searchBack    = document.getElementById('cc-search-back');
  const searchInput   = document.getElementById('cc-search-input');
  const searchBtn     = document.getElementById('cc-search-btn');
  const searchResults = document.getElementById('cc-search-results');

  const clanHome       = document.getElementById('cc-clan-home');
  const crestDisplay   = document.getElementById('cc-crest-display');
  const clanNameDisp   = document.getElementById('cc-clan-name-display');
  const clanMetaDisp   = document.getElementById('cc-clan-meta-display');

  const pendingSection = document.getElementById('cc-pending-section');
  const pendingList    = document.getElementById('cc-pending-list');

  const navChat      = document.getElementById('cc-nav-chat');
  const navMembers   = document.getElementById('cc-nav-members');
  const navAlliances = document.getElementById('cc-nav-alliances');
  const navSettings  = document.getElementById('cc-nav-settings');

  const subChat      = document.getElementById('cc-sub-chat');
  const subMembers   = document.getElementById('cc-sub-members');
  const subAlliances = document.getElementById('cc-sub-alliances');
  const subSettings  = document.getElementById('cc-sub-settings');

  const clanMsgList  = document.getElementById('cc-clan-messages');
  const clanForm     = document.getElementById('cc-clan-form');
  const clanInput    = document.getElementById('cc-clan-input');
  const clanSendBtn  = document.getElementById('cc-clan-send');

  const memberList   = document.getElementById('cc-member-list');

  const allyList         = document.getElementById('cc-ally-list');
  const addAllyInput     = document.getElementById('cc-add-ally-input');
  const addAllyBtn       = document.getElementById('cc-add-ally-btn');
  const addEnemyInput    = document.getElementById('cc-add-enemy-input');
  const addEnemyBtn      = document.getElementById('cc-add-enemy-btn');

  const settingsName  = document.getElementById('cc-settings-name');
  const settingsDesc  = document.getElementById('cc-settings-desc');
  const settingsEmoji = document.getElementById('cc-settings-emoji');
  const settingsOpen  = document.getElementById('cc-settings-open');
  const settingsSave  = document.getElementById('cc-settings-save');
  const leaveClanBtn  = document.getElementById('cc-leave-clan-btn');
  const disbandBtn    = document.getElementById('cc-disband-clan-btn');

  // ── State ────────────────────────────────────────────────────────────────
  let isOpen        = false;
  let activeTab     = 'global'; // 'global' | 'clan'
  let unreadGlobal  = 0;
  let unreadClan    = 0;
  let sendCooldownGlobal = false;
  let sendCooldownClan   = false;

  let myClan        = null; // { id, name, description, emoji, open, leader, memberCount, myRole }
  const seenGlobalIds = new Set();
  const seenClanIds   = new Set();

  // ══════════════════════════════════════════════════════════════════════
  // Utilities
  // ══════════════════════════════════════════════════════════════════════

  function isAtBottom(list) {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  }
  function scrollToBottom(list, force) {
    if (force || isAtBottom(list)) list.scrollTop = list.scrollHeight;
  }
  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Auto-grow a <textarea> to fit its content, up to the CSS max-height
   * (where overflow-y:auto takes over). Reset to 'auto' first so shrinking
   * (e.g. after Enter clears the box) recalculates correctly.
   */
  function autosizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }
  function attachAutosize(el) {
    if (!el) return;
    autosizeTextarea(el);
    el.addEventListener('input', () => autosizeTextarea(el));
  }
  /** Format a ms timestamp as UTC time for the "edited" tooltip / badge. */
  function formatUTC(ts) {
    const d = new Date(ts);
    return d.toLocaleString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      month: 'short', day: 'numeric',
      timeZone: 'UTC', hour12: false,
    }) + ' UTC';
  }

  /**
   * Render (or re-render) a message <li>.
   *
   * kind: 'global' | 'clan' — used to route edit/history API calls and to
   *   pick the right SSE incoming handler when an edit broadcast arrives.
   *
   * The full message data is cached on the <li>'s dataset so the ⋮ menu
   * (added after the fact) and edit-in-place logic can read it without
   * threading extra state through closures.
   */
  function appendMessage(list, data, scroll, seenIds, capacity, kind) {
    const { username, message, sent_at, role, id, edited_at } = data;
    const safeUser = String(username ?? '').slice(0, 30);
    const safeMsg  = String(message  ?? '').slice(0, 300);
    const safeTime = formatTime(typeof sent_at === 'number' ? sent_at : Date.now());

    const li = document.createElement('li');
    li.className = 'cc-msg';
    li.dataset.kind = kind || 'global';
    if (id !== undefined && id !== null) li.dataset.id = String(id);
    li.dataset.username = safeUser;
    li.dataset.message  = safeMsg;
    li.dataset.sentAt   = String(sent_at || Date.now());
    if (edited_at) li.dataset.editedAt = String(edited_at);

    if (role === 'leader' || role === 'officer') {
      const badge = document.createElement('span');
      badge.className = `cc-role-badge cc-role-${role}`;
      badge.textContent = role === 'leader' ? '★ LEADER' : '◆ OFFICER';
      li.appendChild(badge);
    }

    const userSpan = document.createElement('span');
    userSpan.className = 'cc-user';
    userSpan.dataset.u = safeUser;
    userSpan.textContent = safeUser;

    const textSpan = document.createElement('span');
    textSpan.className = 'cc-text';
    textSpan.textContent = safeMsg;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'cc-time';
    timeSpan.textContent = safeTime;

    li.appendChild(userSpan);
    li.appendChild(textSpan);
    li.appendChild(timeSpan);

    if (edited_at) {
      li.appendChild(buildEditedBadge(edited_at));
    }

    // ⋮ menu — present on every message; Copy is always available,
    // Edit / Edit history are added conditionally inside buildMsgMenuBtn.
    li.appendChild(buildMsgMenuBtn());

    list.appendChild(li);

    while (list.children.length > capacity) {
      list.removeChild(list.firstChild);
    }
    if (scroll !== false) scrollToBottom(list);
  }

  function buildEditedBadge(editedAt) {
    const badge = document.createElement('span');
    badge.className = 'cc-edited-badge';
    badge.textContent = '(edited)';
    badge.title = `Edited ${formatUTC(editedAt)} — click for history`;
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const li = badge.closest('.cc-msg');
      if (li) openEditHistory(li);
    });
    return badge;
  }


  // ── Edit-history modal refs ──────────────────────────────────────────────
  const editHistoryOverlay = document.getElementById('cc-edit-history-overlay');
  const editHistoryList    = document.getElementById('cc-eh-list');
  const editHistoryClose   = document.getElementById('cc-eh-close');
  const editHistoryRestore = document.getElementById('cc-eh-restore');

  let _ehSelectedMsg  = null; // currently selected revision text
  let _ehTargetLi     = null; // <li> the modal was opened for

  if (editHistoryClose) {
    editHistoryClose.addEventListener('click', () => {
      if (editHistoryOverlay) editHistoryOverlay.classList.remove('cc-eh-open');
    });
  }

  if (editHistoryOverlay) {
    editHistoryOverlay.addEventListener('click', (e) => {
      if (e.target === editHistoryOverlay) editHistoryOverlay.classList.remove('cc-eh-open');
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editHistoryOverlay?.classList.contains('cc-eh-open')) {
      editHistoryOverlay.classList.remove('cc-eh-open');
    }
  });

  if (editHistoryRestore) {
    editHistoryRestore.addEventListener('click', async () => {
      if (!_ehSelectedMsg || !_ehTargetLi) return;
      const id   = _ehTargetLi.dataset.id;
      const kind = _ehTargetLi.dataset.kind || 'global';
      if (!id) return;

      const url    = kind === 'clan' ? `/api/clan/chat/${id}` : `/api/chat/${id}`;
      const token  = window.__token || '';
      try {
        const res  = await fetch(url, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ message: _ehSelectedMsg }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data?.error || 'Could not restore version.');
          return;
        }
        // Update the <li> in-place
        patchMessageLi(_ehTargetLi, data);
        editHistoryOverlay.classList.remove('cc-eh-open');
      } catch (err) {
        console.error('[chatclan] restore error:', err);
        alert('Network error — could not restore version.');
      }
    });
  }

  /**
   * Build the ⋮ context-menu button for a message <li>.
   * Copy is always present. Edit / History are injected lazily when the
   * menu opens (so we always read the latest role/username from the <li>
   * dataset rather than capturing stale closure values at build time).
   */
  function buildMsgMenuBtn() {
    const wrap = document.createElement('div');
    wrap.className = 'cc-msg-menu-wrap';

    const btn = document.createElement('button');
    btn.className = 'cc-msg-menu-btn';
    btn.type = 'button';
    btn.title = 'Message options';
    btn.setAttribute('aria-label', 'Message options');
    btn.textContent = '⋮';
    wrap.appendChild(btn);

    const menu = document.createElement('div');
    menu.className = 'cc-msg-menu';
    menu.hidden = true;
    wrap.appendChild(menu);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !menu.hidden;

      // Close all other open menus
      document.querySelectorAll('.cc-msg-menu:not([hidden])').forEach(m => { m.hidden = true; });

      if (isOpen) return;

      const li = btn.closest('.cc-msg');
      menu.innerHTML = '';

      // ── Copy ──────────────────────────────────────────────────────────
      const copyItem = document.createElement('button');
      copyItem.textContent = '📋 Copy';
      copyItem.addEventListener('click', () => {
        const text = li?.dataset.message || li?.querySelector('.cc-text')?.textContent || '';
        navigator.clipboard?.writeText(text).catch(() => {});
        menu.hidden = true;
      });
      menu.appendChild(copyItem);

      // ── Edit (own messages only) ───────────────────────────────────────
      if (li && li.dataset.username === (window.__username || '')) {
        const editItem = document.createElement('button');
        editItem.textContent = '✏️ Edit';
        editItem.addEventListener('click', () => {
          menu.hidden = true;
          startInlineEdit(li);
        });
        menu.appendChild(editItem);

        // ── Edit history (only if message was edited) ───────────────────
        if (li.dataset.editedAt) {
          const histItem = document.createElement('button');
          histItem.textContent = '🕐 Edit history';
          histItem.addEventListener('click', () => {
            menu.hidden = true;
            openEditHistory(li);
          });
          menu.appendChild(histItem);
        }
      } else if (li && li.dataset.editedAt) {
        // Others can still view edit history (read-only)
        const histItem = document.createElement('button');
        histItem.textContent = '🕐 Edit history';
        histItem.addEventListener('click', () => {
          menu.hidden = true;
          openEditHistory(li);
        });
        menu.appendChild(histItem);
      }

      menu.hidden = false;
    });

    // Close when clicking anywhere else
    document.addEventListener('click', () => { menu.hidden = true; }, { capture: false });

    return wrap;
  }

  /**
   * Replace a message <li>'s text area with a single-line textarea for in-place editing.
   * Pressing Enter commits; Escape cancels.
   */
  function startInlineEdit(li) {
    if (!li) return;
    const currentText = li.dataset.message || li.querySelector('.cc-text')?.textContent || '';
    const textSpan    = li.querySelector('.cc-text');
    if (!textSpan) return;

    // Prevent double-editing
    if (li.querySelector('.cc-edit-input')) return;

    const input = document.createElement('textarea');
    input.className = 'cc-edit-input';
    input.value     = currentText;
    input.maxLength = li.dataset.kind === 'clan' ? 300 : 200;
    input.rows      = 1;

    const saveBtn = document.createElement('button');
    saveBtn.type      = 'button';
    saveBtn.className = 'cc-edit-save';
    saveBtn.textContent = '✓';
    saveBtn.title     = 'Save edit';

    const cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'cc-edit-cancel';
    cancelBtn.textContent = '✕';
    cancelBtn.title     = 'Cancel';

    // Hide the original text span (keep in DOM so cancel can restore)
    textSpan.style.display = 'none';
    li.appendChild(input);
    li.appendChild(saveBtn);
    li.appendChild(cancelBtn);
    attachAutosize(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    async function commitEdit() {
      const newText = input.value.trim();
      if (!newText || newText === currentText) {
        cancel();
        return;
      }
      const id   = li.dataset.id;
      const kind = li.dataset.kind || 'global';
      if (!id) { cancel(); return; }

      saveBtn.disabled   = true;
      cancelBtn.disabled = true;

      const url   = kind === 'clan' ? `/api/clan/chat/${id}` : `/api/chat/${id}`;
      const token = window.__token || '';
      try {
        const res  = await fetch(url, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ message: newText }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data?.error || 'Could not save edit.');
          saveBtn.disabled   = false;
          cancelBtn.disabled = false;
          return;
        }
        patchMessageLi(li, data);
      } catch (err) {
        console.error('[chatclan] inline edit error:', err);
        alert('Network error — could not save edit.');
        saveBtn.disabled   = false;
        cancelBtn.disabled = false;
      }
    }

    function cancel() {
      input.remove();
      saveBtn.remove();
      cancelBtn.remove();
      textSpan.style.display = '';
    }

    saveBtn.addEventListener('click', commitEdit);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
      if (e.key === 'Escape')               { e.preventDefault(); cancel(); }
    });
  }

  /**
   * Mutate an existing <li> in-place to reflect an edited message payload
   * (either from a local PATCH response or an incoming SSE edit broadcast).
   */
  function patchMessageLi(li, data) {
    if (!li || !data) return;

    const newMsg  = String(data.message || '').slice(0, 300);
    const editedAt = data.edited_at || null;

    // Update dataset
    li.dataset.message = newMsg;
    if (editedAt) li.dataset.editedAt = String(editedAt);

    // Update displayed text
    const textSpan = li.querySelector('.cc-text');
    if (textSpan) {
      textSpan.textContent = newMsg;
      textSpan.style.display = '';
    }

    // Remove stale inline edit controls if still present
    li.querySelector('.cc-edit-input')?.remove();
    li.querySelector('.cc-edit-save')?.remove();
    li.querySelector('.cc-edit-cancel')?.remove();

    // Update / add (edited) badge
    let badge = li.querySelector('.cc-edited-badge');
    if (editedAt) {
      if (badge) {
        badge.title = `Edited ${formatUTC(editedAt)} — click for history`;
      } else {
        badge = buildEditedBadge(editedAt);
        // Insert before the ⋮ menu
        const menuWrap = li.querySelector('.cc-msg-menu-wrap');
        if (menuWrap) li.insertBefore(badge, menuWrap);
        else          li.appendChild(badge);
      }
    }

    // Refresh ⋮ menu so "Edit history" option appears if it wasn't there before
    const oldMenu = li.querySelector('.cc-msg-menu-wrap');
    if (oldMenu) {
      oldMenu.replaceWith(buildMsgMenuBtn());
    }
  }

  /**
   * Open the edit-history modal for a given message <li>.
   * Fetches revision history from the server and renders it.
   */
  async function openEditHistory(li) {
    if (!li || !editHistoryOverlay || !editHistoryList) return;
    const id   = li.dataset.id;
    const kind = li.dataset.kind || 'global';
    if (!id) return;

    _ehTargetLi    = li;
    _ehSelectedMsg = null;
    editHistoryRestore && (editHistoryRestore.disabled = true);

    editHistoryList.innerHTML = '<li class="cc-eh-loading">Loading…</li>';
    editHistoryOverlay.classList.add('cc-eh-open');

    const url   = kind === 'clan' ? `/api/clan/chat/${id}/history` : `/api/chat/${id}/history`;
    const token = window.__token || '';
    try {
      const res  = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();

      if (!res.ok) {
        editHistoryList.innerHTML = `<li class="cc-eh-empty">${data?.error || 'Could not load history.'}</li>`;
        return;
      }

      const edits = data.edits || [];
      // The current version is the "latest" — append it at the end
      const currentMsg = li.dataset.message || li.querySelector('.cc-text')?.textContent || '';
      const currentAt  = li.dataset.editedAt ? Number(li.dataset.editedAt) : null;

      // Build the full chain: [oldest…, current]
      // edits[i].message = the text *before* that edit, edits[i].edited_at = when the edit was applied
      const allVersions = edits.map((e, i) => ({
        label: `Version ${i + 1}`,
        message: e.message,
        ts: e.edited_at,
        isCurrent: false,
      }));
      allVersions.push({
        label: `Current (Version ${edits.length + 1})`,
        message: currentMsg,
        ts: currentAt,
        isCurrent: true,
      });

      if (allVersions.length <= 1 && edits.length === 0) {
        editHistoryList.innerHTML = '<li class="cc-eh-empty">No edit history.</li>';
        return;
      }

      editHistoryList.innerHTML = '';
      const canRestore = li.dataset.username === (window.__username || '');

      for (const v of allVersions.slice().reverse()) { // newest first
        const item = document.createElement('li');
        item.className = 'cc-eh-item' + (v.isCurrent ? ' cc-eh-item--current' : '');
        item.dataset.msg = v.message;

        const meta = document.createElement('div');
        meta.className = 'cc-eh-meta';
        meta.textContent = v.label + (v.ts ? ` — ${formatUTC(v.ts)}` : '');
        item.appendChild(meta);

        const text = document.createElement('div');
        text.className = 'cc-eh-text';
        text.textContent = v.message;
        item.appendChild(text);

        if (canRestore && !v.isCurrent) {
          item.addEventListener('click', () => {
            editHistoryList.querySelectorAll('.cc-eh-item').forEach(el => el.classList.remove('cc-eh-selected'));
            item.classList.add('cc-eh-selected');
            _ehSelectedMsg = v.message;
            if (editHistoryRestore) editHistoryRestore.disabled = false;
          });
        }

        editHistoryList.appendChild(item);
      }
    } catch (err) {
      console.error('[chatclan] openEditHistory error:', err);
      editHistoryList.innerHTML = '<li class="cc-eh-empty">Network error.</li>';
    }
  }

  // ── SSE edit-broadcast handlers ─────────────────────────────────────────────
  // broadcast.js should forward:
  //   if (data.type === 'chat_edit')      window.__chatEditIncoming?.(data);
  //   if (data.type === 'clan_chat_edit') window.__clanChatEditIncoming?.(data);

  window.__chatEditIncoming = function (data) {
    if (!data || !data.id) return;
    const li = globalList.querySelector(`.cc-msg[data-id="${data.id}"]`);
    if (li) patchMessageLi(li, data);
  };

  window.__clanChatEditIncoming = function (data) {
    if (!data || !data.id) return;
    const li = clanMsgList?.querySelector(`.cc-msg[data-id="${data.id}"]`);
    if (li) patchMessageLi(li, data);
  };

  function appendSystem(list, text) {
    const li = document.createElement('li');
    li.className = 'cc-msg cc-system';
    li.textContent = String(text).slice(0, 200);
    list.appendChild(li);
    scrollToBottom(list);
  }

  function setUnreadBadges() {
    const total = unreadGlobal + unreadClan;
    if (unreadBadge) {
      unreadBadge.textContent = total > 99 ? '99+' : (total > 0 ? String(total) : '');
      unreadBadge.classList.toggle('visible', total > 0);
    }
    if (globalBadge) {
      globalBadge.textContent = unreadGlobal > 99 ? '99+' : (unreadGlobal > 0 ? String(unreadGlobal) : '');
      globalBadge.classList.toggle('visible', unreadGlobal > 0);
    }
    if (clanBadge) {
      clanBadge.textContent = unreadClan > 99 ? '99+' : (unreadClan > 0 ? String(unreadClan) : '');
      clanBadge.classList.toggle('visible', unreadClan > 0);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Panel open / close / tabs
  // ══════════════════════════════════════════════════════════════════════

  function openPanel() {
    isOpen = true;
    panel.classList.add('cc-open');
    if (activeTab === 'global') { unreadGlobal = 0; scrollToBottom(globalList, true); }
    else                         { unreadClan = 0; scrollToBottom(clanMsgList, true); }
    setUnreadBadges();
  }
  function closePanel() {
    isOpen = false;
    panel.classList.remove('cc-open');
  }

  toggleBtn.addEventListener('click', () => (isOpen ? closePanel() : openPanel()));
  if (closeBtn) closeBtn.addEventListener('click', closePanel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closePanel();
  });

  function switchTab(tab) {
    activeTab = tab;
    const isGlobal = tab === 'global';

    tabGlobal.classList.toggle('cc-tab-active', isGlobal);
    tabGlobal.setAttribute('aria-selected', String(isGlobal));
    tabClan.classList.toggle('cc-tab-active', !isGlobal);
    tabClan.setAttribute('aria-selected', String(!isGlobal));

    pageGlobal.classList.toggle('cc-page-active', isGlobal);
    pageClan.classList.toggle('cc-page-active', !isGlobal);

    if (isGlobal) {
      unreadGlobal = 0;
      scrollToBottom(globalList, true);
    } else {
      unreadClan = 0;
      scrollToBottom(clanMsgList, true);
      // Refresh clan state when opening the clan tab
      refreshMyClan();
    }
    setUnreadBadges();
  }

  if (tabGlobal) tabGlobal.addEventListener('click', () => switchTab('global'));
  if (tabClan)   tabClan.addEventListener('click', () => switchTab('clan'));

  // ══════════════════════════════════════════════════════════════════════
  // GLOBAL CHAT
  // ══════════════════════════════════════════════════════════════════════

  async function loadGlobalHistory() {
    try {
      const res = await fetch('/api/chat');
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data?.messages)) return;
      globalList.innerHTML = '';
      seenGlobalIds.clear();
      for (const msg of data.messages) {
        if (msg.id) seenGlobalIds.add(msg.id);
        appendMessage(globalList, msg, false, seenGlobalIds, MAX_DISPLAY, 'global');
      }
      scrollToBottom(globalList, true);
    } catch (err) {
      console.warn('[chatclan] Could not load global history:', err);
    }
  }

  window.__chatIncoming = function (data) {
    if (!data || typeof data !== 'object') return;

    if (data.id) {
      if (seenGlobalIds.has(data.id)) return;
      seenGlobalIds.add(data.id);
      if (seenGlobalIds.size > MAX_DISPLAY * 2) {
        const first = seenGlobalIds.values().next().value;
        seenGlobalIds.delete(first);
      }
    }

    const wasAtBottom = isAtBottom(globalList);
    const viewingGlobal = isOpen && activeTab === 'global';
    appendMessage(globalList, data, wasAtBottom || viewingGlobal, seenGlobalIds, MAX_DISPLAY, 'global');

    if (!viewingGlobal) {
      unreadGlobal++;
      setUnreadBadges();
    }
  };

  async function sendGlobalMessage() {
    if (sendCooldownGlobal) return;
    const text = globalInput.value.trim();
    if (!text) return;

    if (!window.__username) {
      appendSystem(globalList, 'You must be logged in to chat.');
      return;
    }

    globalSendBtn.disabled = true;
    sendCooldownGlobal = true;
    globalInput.value = '';
    autosizeTextarea(globalInput);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${window.__token || ''}`,
        },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        appendSystem(globalList, data?.error || 'Failed to send message.');
        globalInput.value = text;
        autosizeTextarea(globalInput);
      } else if (typeof window.__chatIncoming === 'function') {
        window.__chatIncoming(data);
      }
    } catch (err) {
      console.error('[chatclan] global send error:', err);
      appendSystem(globalList, 'Network error — could not send.');
      globalInput.value = text;
      autosizeTextarea(globalInput);
    }

    setTimeout(() => {
      sendCooldownGlobal = false;
      globalSendBtn.disabled = false;
    }, COOLDOWN_MS);
  }

  if (globalForm) {
    globalForm.addEventListener('submit', (e) => { e.preventDefault(); sendGlobalMessage(); });
  }
  if (globalInput) {
    globalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGlobalMessage(); }
    });
    attachAutosize(globalInput);
  }

  if (globalDownload) {
    globalDownload.addEventListener('click', () => {
      const lines = [];
      for (const li of globalList.querySelectorAll('.cc-msg:not(.cc-system)')) {
        const user = li.querySelector('.cc-user')?.textContent || '?';
        const msg  = li.querySelector('.cc-text')?.textContent || '';
        const time = li.querySelector('.cc-time')?.textContent || '';
        lines.push(`[${time}] ${user}: ${msg}`);
      }
      if (!lines.length) return;
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `saint-pixels-chat-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  // ── Profile click-through (both chats) ──────────────────────────────────
  function handleProfileClick(e) {
    if (!e.target.classList.contains('cc-user')) return;
    const u = e.target.dataset?.u;
    if (u && typeof window.__openProfile === 'function') window.__openProfile(u);
  }
  globalList.addEventListener('click', handleProfileClick);
  if (clanMsgList) clanMsgList.addEventListener('click', handleProfileClick);

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — view-state management
  // ══════════════════════════════════════════════════════════════════════

  function showClanView(view) {
    // view: 'landing' | 'create' | 'search' | 'home'
    clanLanding.classList.toggle('hidden', view !== 'landing');
    createPanel.classList.toggle('hidden', view !== 'create');
    searchPanel.classList.toggle('hidden', view !== 'search');
    clanHome.classList.toggle('hidden', view !== 'home');
  }

  function showClanSubpage(sub) {
    // sub: 'chat' | 'members' | 'alliances' | 'settings'
    subChat.classList.toggle('active', sub === 'chat');
    subMembers.classList.toggle('active', sub === 'members');
    subAlliances.classList.toggle('active', sub === 'alliances');
    subSettings.classList.toggle('active', sub === 'settings');

    navChat.classList.toggle('active', sub === 'chat');
    navMembers.classList.toggle('active', sub === 'members');
    navAlliances.classList.toggle('active', sub === 'alliances');
    navSettings.classList.toggle('active', sub === 'settings');

    if (sub === 'chat')      { loadClanHistory(); scrollToBottom(clanMsgList, true); }
    if (sub === 'members')   loadMembers();
    if (sub === 'alliances') loadRelations();
    if (sub === 'settings')  loadSettings();
  }

  // ── Landing actions ──────────────────────────────────────────────────────
  if (landingCreate) landingCreate.addEventListener('click', () => showClanView('create'));
  if (landingJoin)   landingJoin.addEventListener('click', () => {
    showClanView('search');
    runClanSearch('');
  });
  if (createBack) createBack.addEventListener('click', () => showClanView('landing'));
  if (searchBack) searchBack.addEventListener('click', () => showClanView('landing'));

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — fetch current membership
  // ══════════════════════════════════════════════════════════════════════

  function authHeaders(extra) {
    return Object.assign({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${window.__token || ''}`,
    }, extra || {});
  }

  async function refreshMyClan() {
    if (!window.__username) {
      myClan = null;
      showClanView('landing');
      return;
    }
    try {
      const res = await fetch('/api/clan/mine', { headers: authHeaders() });
      if (!res.ok) { showClanView('landing'); return; }
      const data = await res.json();
      myClan = data.clan;

      if (!myClan) {
        showClanView('landing');
        return;
      }

      renderClanHome(data);
      showClanView('home');
      // default to chat sub-page on first load of this clan
      showClanSubpage('chat');
    } catch (err) {
      console.warn('[chatclan] refreshMyClan error:', err);
    }
  }

  function renderClanHome(data) {
    crestDisplay.textContent = myClan.emoji || '🛡️';
    crestDisplay.title = myClan.name;
    clanNameDisp.textContent = myClan.name;
    clanMetaDisp.textContent = `${myClan.memberCount} member${myClan.memberCount === 1 ? '' : 's'} · ${myClan.open ? 'Open' : 'Invite Only'}`;

    const isLeaderOrOfficer = myClan.myRole === 'leader' || myClan.myRole === 'officer';

    // Pending requests (leader/officer only)
    if (isLeaderOrOfficer && Array.isArray(data.pending) && data.pending.length > 0) {
      pendingSection.classList.remove('hidden');
      pendingList.innerHTML = '';
      for (const p of data.pending) {
        const row = document.createElement('div');
        row.className = 'cc-pending-row';

        const name = document.createElement('span');
        name.className = 'cc-pending-name';
        name.textContent = p.username;

        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'cc-accept-btn';
        acceptBtn.textContent = '✓ Accept';
        acceptBtn.addEventListener('click', () => respondToRequest(p.username, true));

        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'cc-reject-btn';
        rejectBtn.textContent = '✕';
        rejectBtn.addEventListener('click', () => respondToRequest(p.username, false));

        row.appendChild(name);
        row.appendChild(acceptBtn);
        row.appendChild(rejectBtn);
        pendingList.appendChild(row);
      }
    } else {
      pendingSection.classList.add('hidden');
      pendingList.innerHTML = '';
    }

    // Show/hide settings save + disband based on role
    settingsSave.classList.toggle('hidden', myClan.myRole !== 'leader');
    disbandBtn.classList.toggle('hidden', myClan.myRole !== 'leader');

    // Hide ally-management inputs unless leader/officer
    const allyActions = document.querySelector('.cc-ally-actions');
    if (allyActions) allyActions.classList.toggle('hidden', !isLeaderOrOfficer);
  }

  async function respondToRequest(username, accept) {
    if (!myClan) return;
    try {
      const res = await fetch(`/api/clan/${myClan.id}/requests/${encodeURIComponent(username)}/${accept ? 'accept' : 'reject'}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (res.ok) refreshMyClan();
    } catch (err) {
      console.warn('[chatclan] respondToRequest error:', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — create
  // ══════════════════════════════════════════════════════════════════════

  if (createSubmit) {
    createSubmit.addEventListener('click', async () => {
      const name = createName.value.trim();
      if (!name) { createName.focus(); return; }

      createSubmit.disabled = true;
      try {
        const res = await fetch('/api/clan/create', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            name,
            description: createDesc.value.trim(),
            emoji: createEmoji.value.trim() || '🛡️',
            open: !!createOpen.checked,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data?.error || 'Failed to create clan.');
        } else {
          createName.value = '';
          createDesc.value = '';
          createEmoji.value = '🛡️';
          createOpen.checked = true;
          refreshMyClan();
        }
      } catch (err) {
        console.error('[chatclan] create error:', err);
        alert('Network error — could not create clan.');
      }
      createSubmit.disabled = false;
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — search / join
  // ══════════════════════════════════════════════════════════════════════

  async function runClanSearch(query) {
    searchResults.innerHTML = '<div class="cc-loading">Searching…</div>';
    try {
      const res = await fetch(`/api/clan/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error('search failed');
      const data = await res.json();
      renderSearchResults(data.clans || []);
    } catch (err) {
      searchResults.innerHTML = '<div class="cc-empty">Could not search clans.</div>';
    }
  }

  function renderSearchResults(clans) {
    if (!clans.length) {
      searchResults.innerHTML = '<div class="cc-empty">No clans found.</div>';
      return;
    }
    searchResults.innerHTML = '';
    for (const c of clans) {
      const row = document.createElement('div');
      row.className = 'cc-clan-result';

      const crest = document.createElement('div');
      crest.className = 'cc-clan-result-crest';
      crest.textContent = c.emoji || '🛡️';

      const info = document.createElement('div');
      info.className = 'cc-clan-result-info';
      const name = document.createElement('div');
      name.className = 'cc-clan-result-name';
      name.textContent = c.name;
      const meta = document.createElement('div');
      meta.className = 'cc-clan-result-meta';
      meta.textContent = `${c.memberCount} member${c.memberCount === 1 ? '' : 's'} · ${c.open ? 'Open' : 'Invite Only'}`;
      info.appendChild(name);
      info.appendChild(meta);

      const btn = document.createElement('button');
      btn.className = 'cc-btn cc-btn--gold cc-btn--sm';
      btn.textContent = c.open ? 'Join' : 'Request';
      btn.addEventListener('click', () => joinClan(c.id, btn));

      row.appendChild(crest);
      row.appendChild(info);
      row.appendChild(btn);
      searchResults.appendChild(row);
    }
  }

  async function joinClan(clanId, btn) {
    btn.disabled = true;
    try {
      const res = await fetch(`/api/clan/join/${clanId}`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) {
        alert(data?.error || 'Failed to join clan.');
        btn.disabled = false;
        return;
      }
      if (data.joined) {
        refreshMyClan();
      } else if (data.requested) {
        btn.textContent = 'Requested';
      }
    } catch (err) {
      console.error('[chatclan] joinClan error:', err);
      alert('Network error — could not join clan.');
      btn.disabled = false;
    }
  }

  if (searchBtn)   searchBtn.addEventListener('click', () => runClanSearch(searchInput.value.trim()));
  if (searchInput) searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runClanSearch(searchInput.value.trim()); }
  });

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — inner nav
  // ══════════════════════════════════════════════════════════════════════

  if (navChat)      navChat.addEventListener('click', () => showClanSubpage('chat'));
  if (navMembers)   navMembers.addEventListener('click', () => showClanSubpage('members'));
  if (navAlliances) navAlliances.addEventListener('click', () => showClanSubpage('alliances'));
  if (navSettings)  navSettings.addEventListener('click', () => showClanSubpage('settings'));

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — chat
  // ══════════════════════════════════════════════════════════════════════

  async function loadClanHistory() {
    if (!myClan) return;
    try {
      const res = await fetch('/api/clan/chat', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data?.messages)) return;
      clanMsgList.innerHTML = '';
      seenClanIds.clear();
      for (const msg of data.messages) {
        if (msg.id) seenClanIds.add(msg.id);
        appendMessage(clanMsgList, msg, false, seenClanIds, MAX_DISPLAY, 'clan');
      }
      scrollToBottom(clanMsgList, true);
    } catch (err) {
      console.warn('[chatclan] loadClanHistory error:', err);
    }
  }

  window.__clanChatIncoming = function (data) {
    if (!data || typeof data !== 'object') return;
    // Only render if it's for our clan
    if (!myClan || data.clan_id !== myClan.id) return;

    if (data.id) {
      if (seenClanIds.has(data.id)) return;
      seenClanIds.add(data.id);
      if (seenClanIds.size > MAX_DISPLAY * 2) {
        const first = seenClanIds.values().next().value;
        seenClanIds.delete(first);
      }
    }

    const wasAtBottom = isAtBottom(clanMsgList);
    const viewingClanChat = isOpen && activeTab === 'clan' && subChat.classList.contains('active');
    appendMessage(clanMsgList, data, wasAtBottom || viewingClanChat, seenClanIds, MAX_DISPLAY, 'clan');

    if (!viewingClanChat) {
      unreadClan++;
      setUnreadBadges();
    }
  };

  window.__clanEventIncoming = function (data) {
    if (!data || typeof data !== 'object') return;
    if (!myClan || data.clan_id !== myClan.id) return;

    switch (data.event) {
      case 'join':
        appendSystem(clanMsgList, `${data.username} joined the clan.`);
        refreshMyClan();
        break;
      case 'leave':
        appendSystem(clanMsgList, `${data.username} left the clan.`);
        refreshMyClan();
        break;
      case 'kicked':
        appendSystem(clanMsgList, `${data.target} was removed from the clan.`);
        if (data.target === window.__username) {
          myClan = null;
          showClanView('landing');
        } else {
          refreshMyClan();
        }
        break;
      case 'role_change':
        appendSystem(clanMsgList, `${data.target} is now ${data.role === 'officer' ? 'an officer' : 'a member'}.`);
        refreshMyClan();
        break;
      case 'disbanded':
        if (data.target === window.__username || !data.target) {
          myClan = null;
          showClanView('landing');
        }
        break;
      case 'settings_updated':
        refreshMyClan();
        break;
      default:
        break;
    }
  };

  async function sendClanMessage() {
    if (sendCooldownClan || !myClan) return;
    const text = clanInput.value.trim();
    if (!text) return;

    if (!window.__username) {
      appendSystem(clanMsgList, 'You must be logged in to chat.');
      return;
    }

    clanSendBtn.disabled = true;
    sendCooldownClan = true;
    clanInput.value = '';
    autosizeTextarea(clanInput);

    try {
      const res = await fetch('/api/clan/chat', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        appendSystem(clanMsgList, data?.error || 'Failed to send message.');
        clanInput.value = text;
        autosizeTextarea(clanInput);
      } else if (typeof window.__clanChatIncoming === 'function') {
        window.__clanChatIncoming(data);
      }
    } catch (err) {
      console.error('[chatclan] clan send error:', err);
      appendSystem(clanMsgList, 'Network error — could not send.');
      clanInput.value = text;
      autosizeTextarea(clanInput);
    }

    setTimeout(() => {
      sendCooldownClan = false;
      clanSendBtn.disabled = false;
    }, COOLDOWN_MS);
  }

  if (clanForm) clanForm.addEventListener('submit', (e) => { e.preventDefault(); sendClanMessage(); });
  if (clanInput) {
    clanInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendClanMessage(); }
    });
    attachAutosize(clanInput);
  }

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — members
  // ══════════════════════════════════════════════════════════════════════

  async function loadMembers() {
    if (!myClan) return;
    memberList.innerHTML = '<li class="cc-loading">Loading…</li>';
    try {
      const res = await fetch(`/api/clan/${myClan.id}/members`, { headers: authHeaders() });
      if (!res.ok) throw new Error('members fetch failed');
      const data = await res.json();
      renderMembers(data.members || []);
    } catch (err) {
      memberList.innerHTML = '<li class="cc-loading">Could not load members.</li>';
    }
  }

  function renderMembers(rows) {
    memberList.innerHTML = '';
    const myRole = myClan.myRole;

    for (const m of rows) {
      const li = document.createElement('li');
      li.className = 'cc-member-row';

      if (m.role === 'leader' || m.role === 'officer') {
        const badge = document.createElement('span');
        badge.className = `cc-role-badge cc-role-${m.role}`;
        badge.textContent = m.role === 'leader' ? '★' : '◆';
        li.appendChild(badge);
      }

      const name = document.createElement('span');
      name.className = 'cc-member-name';
      name.textContent = m.username;
      name.addEventListener('click', () => {
        if (typeof window.__openProfile === 'function') window.__openProfile(m.username);
      });
      li.appendChild(name);

      // Action buttons — visible based on role
      const actions = document.createElement('div');
      actions.className = 'cc-member-actions';

      const isSelf = m.username === window.__username;

      if (!isSelf && myRole === 'leader' && m.role !== 'leader') {
        const promoteBtn = document.createElement('button');
        promoteBtn.textContent = m.role === 'officer' ? 'Demote' : 'Promote';
        promoteBtn.addEventListener('click', () => promoteMember(m.username));
        actions.appendChild(promoteBtn);
      }

      if (!isSelf && (myRole === 'leader' || myRole === 'officer') && m.role !== 'leader'
          && !(m.role === 'officer' && myRole === 'officer')) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'cc-kick-btn';
        kickBtn.textContent = 'Kick';
        kickBtn.addEventListener('click', () => kickMember(m.username));
        actions.appendChild(kickBtn);
      }

      if (actions.children.length > 0) li.appendChild(actions);
      memberList.appendChild(li);
    }
  }

  async function promoteMember(username) {
    if (!myClan) return;
    try {
      const res = await fetch(`/api/clan/${myClan.id}/promote`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ username }),
      });
      if (res.ok) loadMembers();
      else {
        const data = await res.json();
        alert(data?.error || 'Failed to update role.');
      }
    } catch (err) {
      console.error('[chatclan] promoteMember error:', err);
    }
  }

  async function kickMember(username) {
    if (!myClan) return;
    if (!confirm(`Remove ${username} from the clan?`)) return;
    try {
      const res = await fetch(`/api/clan/${myClan.id}/kick`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ username }),
      });
      if (res.ok) { loadMembers(); refreshMyClan(); }
      else {
        const data = await res.json();
        alert(data?.error || 'Failed to remove member.');
      }
    } catch (err) {
      console.error('[chatclan] kickMember error:', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — alliances / enemies
  // ══════════════════════════════════════════════════════════════════════

  async function loadRelations() {
    if (!myClan) return;
    allyList.innerHTML = '<div class="cc-loading">Loading…</div>';
    try {
      const res = await fetch(`/api/clan/${myClan.id}/relations`, { headers: authHeaders() });
      if (!res.ok) throw new Error('relations fetch failed');
      const data = await res.json();
      renderRelations(data.allies || [], data.enemies || []);
    } catch (err) {
      allyList.innerHTML = '<div class="cc-empty">Could not load alliances.</div>';
    }
  }

  function renderRelations(allies, enemies) {
    allyList.innerHTML = '';

    const canManage = myClan.myRole === 'leader' || myClan.myRole === 'officer';

    const alliesTitle = document.createElement('div');
    alliesTitle.className = 'cc-ally-section-title allies';
    alliesTitle.textContent = `🤝 Allies (${allies.length}/10)`;
    allyList.appendChild(alliesTitle);

    if (allies.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cc-empty';
      empty.textContent = 'No allies yet.';
      allyList.appendChild(empty);
    } else {
      for (const c of allies) allyList.appendChild(relationRow(c, 'ally', canManage));
    }

    const enemiesTitle = document.createElement('div');
    enemiesTitle.className = 'cc-ally-section-title enemies';
    enemiesTitle.textContent = `🔥 Rivals (${enemies.length}/10)`;
    allyList.appendChild(enemiesTitle);

    if (enemies.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cc-empty';
      empty.textContent = 'No rivals declared.';
      allyList.appendChild(empty);
    } else {
      for (const c of enemies) allyList.appendChild(relationRow(c, 'enemy', canManage));
    }
  }

  function relationRow(clan, relation, canManage) {
    const row = document.createElement('div');
    row.className = 'cc-ally-row';

    const crest = document.createElement('span');
    crest.className = 'cc-ally-crest';
    crest.textContent = clan.emoji || '🛡️';

    const name = document.createElement('span');
    name.className = 'cc-ally-name';
    name.textContent = clan.name;

    row.appendChild(crest);
    row.appendChild(name);

    if (canManage) {
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.title = relation === 'ally' ? 'Remove ally' : 'Remove rival';
      removeBtn.addEventListener('click', () => removeRelation(clan.id, relation));
      row.appendChild(removeBtn);
    }

    return row;
  }

  async function addRelation(name, relation) {
    if (!myClan || !name) return;
    try {
      const endpoint = relation === 'ally' ? 'allies' : 'enemies';
      const res = await fetch(`/api/clan/${myClan.id}/${endpoint}`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data?.error || 'Failed to update relation.'); return; }
      loadRelations();
    } catch (err) {
      console.error('[chatclan] addRelation error:', err);
    }
  }

  async function removeRelation(targetId, relation) {
    if (!myClan) return;
    try {
      const endpoint = relation === 'ally' ? 'allies' : 'enemies';
      const res = await fetch(`/api/clan/${myClan.id}/${endpoint}/${targetId}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (res.ok) loadRelations();
    } catch (err) {
      console.error('[chatclan] removeRelation error:', err);
    }
  }

  if (addAllyBtn) addAllyBtn.addEventListener('click', () => {
    const name = addAllyInput.value.trim();
    if (!name) return;
    addAllyInput.value = '';
    addRelation(name, 'ally');
  });
  if (addEnemyBtn) addEnemyBtn.addEventListener('click', () => {
    const name = addEnemyInput.value.trim();
    if (!name) return;
    addEnemyInput.value = '';
    addRelation(name, 'enemy');
  });

  // ══════════════════════════════════════════════════════════════════════
  // CLAN — settings
  // ══════════════════════════════════════════════════════════════════════

  function loadSettings() {
    if (!myClan) return;
    settingsName.value  = myClan.name || '';
    settingsDesc.value  = myClan.description || '';
    settingsEmoji.value = myClan.emoji || '🛡️';
    settingsOpen.checked = !!myClan.open;

    const isLeader = myClan.myRole === 'leader';
    settingsName.disabled  = !isLeader;
    settingsDesc.disabled  = !isLeader;
    settingsEmoji.disabled = !isLeader;
    settingsOpen.disabled  = !isLeader;
  }

  if (settingsSave) {
    settingsSave.addEventListener('click', async () => {
      if (!myClan || myClan.myRole !== 'leader') return;
      settingsSave.disabled = true;
      try {
        const res = await fetch(`/api/clan/${myClan.id}/settings`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({
            name: settingsName.value.trim(),
            description: settingsDesc.value.trim(),
            emoji: settingsEmoji.value.trim() || '🛡️',
            open: !!settingsOpen.checked,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data?.error || 'Failed to save settings.');
        } else {
          myClan = data.clan;
          renderClanHome({ clan: myClan, pending: [] });
        }
      } catch (err) {
        console.error('[chatclan] settings save error:', err);
        alert('Network error — could not save settings.');
      }
      settingsSave.disabled = false;
    });
  }

  if (leaveClanBtn) {
    leaveClanBtn.addEventListener('click', async () => {
      if (!myClan) return;
      if (!confirm(`Leave ${myClan.name}?`)) return;
      try {
        const res = await fetch('/api/clan/leave', { method: 'POST', headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) { alert(data?.error || 'Failed to leave clan.'); return; }
        myClan = null;
        showClanView('landing');
      } catch (err) {
        console.error('[chatclan] leave error:', err);
      }
    });
  }

  if (disbandBtn) {
    disbandBtn.addEventListener('click', async () => {
      if (!myClan) return;
      if (!confirm(`Disband ${myClan.name}? This cannot be undone.`)) return;
      try {
        const res = await fetch('/api/clan/disband', { method: 'POST', headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) { alert(data?.error || 'Failed to disband clan.'); return; }
        myClan = null;
        showClanView('landing');
      } catch (err) {
        console.error('[chatclan] disband error:', err);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Boot
  // ══════════════════════════════════════════════════════════════════════

  loadGlobalHistory();
  // Panel starts collapsed — CSS default (no cc-open class) keeps it off-screen.
  switchTab('global');

  // Refresh clan state once auth resolves (app.js sets window.__username after load)
  window.addEventListener('sp-state-change', (e) => {
    if (e.detail && e.detail.currentUser !== undefined) {
      if (activeTab === 'clan') refreshMyClan();
    }
  });

})();
