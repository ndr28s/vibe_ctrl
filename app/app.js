/**
 * Vibes PWA — Multi-token WebSocket controller client
 * Each token creates a separate WS connection and row of machine cards.
 */

const DEFAULT_SERVER = 'wss://vibes.forthetest.shop/ws';
const RECONNECT_BASE = 1500;
const RECONNECT_MAX  = 30000;
const STATIC_BASE    = 'https://static.vibemon.io';

const STATE_COLORS = {
  start:'#00CCCC', idle:'#00AA00', thinking:'#9933FF', planning:'#008888',
  working:'#0066CC', packing:'#AAAAAA', notification:'#FFCC00',
  sleep:'#111144', done:'#00AA00', alert:'#DD0000', offline:'#333344',
  error:'#DD0000', tool_use:'#0066CC',
};

const STATE_LABELS = {
  start:'Hello!', idle:'Ready', thinking:'Thinking', planning:'Planning',
  working:'Working', packing:'Packing', notification:'Input?',
  done:'Done!', sleep:'Zzz...', alert:'Alert', offline:'Offline', error:'Error',
};

const TOOL_LABELS = {
  Bash:'Running', Read:'Reading', Edit:'Editing', Write:'Writing',
  Grep:'Searching', Glob:'Scanning', WebFetch:'Fetching', WebSearch:'Searching',
  Task:'Tasking', Agent:'Delegating',
};

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  groups: [],        // { id, token, label, serverUrl, ws, connected, reconnectTimer, reconnectDelay, machines:{} }
  selectedTarget: null,  // "groupId:machineId"
  resultBlocks: {},
  blockCounter: 0,
  vibeMonReady: false,
  createEngine: null,
};

let groupIdCounter = 0;

// ── DOM refs ───────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const dom = {};

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  Object.assign(dom, {
    connBadge: $('conn-badge'), connDot: $('conn-dot'), connLabel: $('conn-label'),
    machinesList: $('machines-list'), targetSelect: $('target-select'),
    sessionInput: $('session-input'), promptInput: $('prompt'),
    sendBtn: $('send-btn'), resultsScroll: $('results-scroll'),
    resultsEmpty: $('results-empty'), serverInput: $('server-url'),
    addTokenBtn: $('add-token-btn'),
    tokenModal: $('token-modal'), tokenInput: $('token-input'),
    tokenServer: $('token-server'), tokenLabel: $('token-label'),
  });
  loadGroups();
  bindEvents();
  loadVibeMonEngine();
  connectAll();
});

function loadVibeMonEngine() {
  const script = document.createElement('script');
  script.type = 'module';
  script.textContent = `
    import { createVibeMonEngine } from '${STATIC_BASE}/js/vibemon-engine-standalone.js';
    window.__vibeMonCreateEngine = createVibeMonEngine;
    window.dispatchEvent(new Event('vibemon-ready'));
  `;
  document.head.appendChild(script);

  window.addEventListener('vibemon-ready', () => {
    state.createEngine = window.__vibeMonCreateEngine;
    state.vibeMonReady = true;
    renderAllGroups();
  });
}

// ── Persistence ────────────────────────────────────────────────────────────

function loadGroups() {
  const raw = localStorage.getItem('vibes_groups');
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      state.groups = saved.map(g => ({
        id: 'g' + (++groupIdCounter),
        token: g.token,
        label: g.label || g.token.substring(0, 12),
        serverUrl: g.serverUrl || DEFAULT_SERVER,
        ws: null, connected: false,
        reconnectTimer: null, reconnectDelay: RECONNECT_BASE,
        machines: {},
      }));
    } catch { state.groups = []; }
  } else {
    // Migration from old single-token format
    const oldToken = localStorage.getItem('vibes_token');
    const oldServer = localStorage.getItem('vibes_server');
    if (oldToken) {
      state.groups.push({
        id: 'g' + (++groupIdCounter),
        token: oldToken,
        label: oldToken.substring(0, 12),
        serverUrl: oldServer || DEFAULT_SERVER,
        ws: null, connected: false,
        reconnectTimer: null, reconnectDelay: RECONNECT_BASE,
        machines: {},
      });
      saveGroups();
      localStorage.removeItem('vibes_token');
      localStorage.removeItem('vibes_server');
    }
  }

  // Update server URL display
  if (dom.serverInput) {
    dom.serverInput.value = state.groups.length > 0 ? state.groups[0].serverUrl : DEFAULT_SERVER;
  }
}

function saveGroups() {
  const data = state.groups.map(g => ({ token: g.token, label: g.label, serverUrl: g.serverUrl }));
  localStorage.setItem('vibes_groups', JSON.stringify(data));
}

// ── Event bindings ─────────────────────────────────────────────────────────

function bindEvents() {
  dom.sendBtn.addEventListener('click', sendCommand);
  dom.promptInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCommand(); }
  });
  dom.promptInput.addEventListener('input', () => {
    dom.promptInput.style.height = 'auto';
    dom.promptInput.style.height = Math.min(dom.promptInput.scrollHeight, 120) + 'px';
  });
  dom.connBadge.addEventListener('click', () => {
    const allConnected = state.groups.every(g => g.connected);
    if (allConnected && state.groups.length > 0) { toast('All connected', 'success'); }
    else { connectAll(); }
  });
  dom.addTokenBtn.addEventListener('click', showTokenModal);
  $('token-submit').addEventListener('click', submitToken);
  $('token-cancel').addEventListener('click', hideTokenModal);
  $('sessions-btn').addEventListener('click', () => {
    if (!state.selectedTarget) { toast('Select a machine first', 'error'); return; }
    const [gid, mid] = state.selectedTarget.split(':');
    const group = state.groups.find(g => g.id === gid);
    if (group) requestSessions(group, mid);
  });
  dom.targetSelect.addEventListener('change', () => {
    state.selectedTarget = dom.targetSelect.value || null;
    highlightSelectedCard();
  });
  dom.serverInput.addEventListener('change', () => {
    // Update all groups' server URL
    const url = dom.serverInput.value.trim() || DEFAULT_SERVER;
    // Only applies to new tokens; existing ones keep their URL
  });
}

// ── Token modal ────────────────────────────────────────────────────────────

function showTokenModal() {
  dom.tokenInput.value = '';
  dom.tokenLabel.value = '';
  dom.tokenServer.value = state.groups.length > 0 ? state.groups[0].serverUrl : DEFAULT_SERVER;
  dom.tokenModal.classList.remove('hidden');
  setTimeout(() => dom.tokenInput.focus(), 300);
}

function hideTokenModal() { dom.tokenModal.classList.add('hidden'); }

function submitToken() {
  const token = dom.tokenInput.value.trim();
  const server = dom.tokenServer.value.trim() || DEFAULT_SERVER;
  const label = dom.tokenLabel.value.trim() || token.substring(0, 12);

  if (!token) { toast('Token is required', 'error'); dom.tokenInput.focus(); return; }

  // Check duplicate
  if (state.groups.find(g => g.token === token && g.serverUrl === server)) {
    toast('Token already added', 'error'); return;
  }

  const group = {
    id: 'g' + (++groupIdCounter),
    token, label, serverUrl: server,
    ws: null, connected: false,
    reconnectTimer: null, reconnectDelay: RECONNECT_BASE,
    machines: {},
  };
  state.groups.push(group);
  saveGroups();
  hideTokenModal();
  connectGroup(group);
  renderAllGroups();
  rebuildTargetSelect();
  updateGlobalConnectionState();
  toast(`Added "${label}"`, 'success');
}

function removeGroup(groupId) {
  const idx = state.groups.findIndex(g => g.id === groupId);
  if (idx === -1) return;
  const group = state.groups[idx];

  // Cleanup engines
  for (const id of Object.keys(group.machines)) {
    if (group.machines[id].engine) {
      try { group.machines[id].engine.cleanup(); } catch {}
    }
  }

  // Disconnect WS
  clearTimeout(group.reconnectTimer);
  if (group.ws) { try { group.ws.close(); } catch {} }

  state.groups.splice(idx, 1);
  saveGroups();
  renderAllGroups();
  rebuildTargetSelect();
  updateGlobalConnectionState();
  toast(`Removed "${group.label}"`, 'success');
}

// ── WebSocket (per group) ──────────────────────────────────────────────────

function connectAll() {
  for (const group of state.groups) connectGroup(group);
  if (state.groups.length === 0) updateGlobalConnectionState();
}

function connectGroup(group) {
  if (group.ws && group.ws.readyState <= WebSocket.OPEN) return;
  updateGlobalConnectionState();

  try { group.ws = new WebSocket(group.serverUrl); }
  catch { group.connected = false; updateGlobalConnectionState(); scheduleReconnectGroup(group); return; }

  group.ws.addEventListener('open', () => {
    group.connected = true;
    group.reconnectDelay = RECONNECT_BASE;
    updateGlobalConnectionState();
    groupSend(group, { type: 'register', role: 'controller', token: group.token });
    groupSend(group, { type: 'machines' });
  });

  group.ws.addEventListener('message', (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    handleGroupMessage(group, msg);
  });

  group.ws.addEventListener('close', () => {
    group.connected = false;
    updateGlobalConnectionState();
    for (const id of Object.keys(group.machines)) {
      group.machines[id].state = 'offline';
      updateMachineCard(group, id);
    }
    scheduleReconnectGroup(group);
  });

  group.ws.addEventListener('error', () => {
    group.connected = false;
    updateGlobalConnectionState();
  });
}

function scheduleReconnectGroup(group) {
  clearTimeout(group.reconnectTimer);
  group.reconnectTimer = setTimeout(() => { if (!group.connected) connectGroup(group); }, group.reconnectDelay);
  group.reconnectDelay = Math.min(group.reconnectDelay * 1.6, RECONNECT_MAX);
}

function groupSend(group, data) {
  if (group.ws && group.ws.readyState === WebSocket.OPEN) group.ws.send(JSON.stringify(data));
}

function updateGlobalConnectionState() {
  if (state.groups.length === 0) {
    dom.connBadge.className = 'conn-badge';
    dom.connLabel.textContent = 'no tokens';
    return;
  }
  const anyConnected = state.groups.some(g => g.connected);
  const allConnected = state.groups.every(g => g.connected);
  if (allConnected) {
    dom.connBadge.className = 'conn-badge connected';
    dom.connLabel.textContent = state.groups.length === 1 ? 'online' : `${state.groups.length} online`;
  } else if (anyConnected) {
    dom.connBadge.className = 'conn-badge connecting';
    const n = state.groups.filter(g => g.connected).length;
    dom.connLabel.textContent = `${n}/${state.groups.length}`;
  } else {
    dom.connBadge.className = 'conn-badge error';
    dom.connLabel.textContent = 'offline';
  }
}

// ── Message handling (per group) ───────────────────────────────────────────

function handleGroupMessage(group, msg) {
  switch (msg.type) {
    case 'machines':        handleMachinesList(group, msg.machines || []); break;
    case 'status':          handleStatus(group, msg); break;
    case 'stream':          handleStream(group, msg); break;
    case 'result':          handleResult(group, msg); break;
    case 'sessions':        handleSessionsList(msg); break;
    case 'session_detail':  handleSessionDetail(msg); break;
    case 'error':           toast(`[${group.label}] ${msg.message || 'Error'}`, 'error'); break;
  }
}

function handleMachinesList(group, machines) {
  for (const m of machines) {
    const id = typeof m === 'string' ? m : (m.id || m.machineId);
    if (!id) continue;
    if (!group.machines[id]) {
      group.machines[id] = { id, name: id, state: m.state || 'idle' };
    }
    // Update with server-provided data
    if (typeof m === 'object') {
      const machine = group.machines[id];
      if (m.state) machine.state = m.state;
      if (m.tool !== undefined) machine.tool = m.tool;
      if (m.project) machine.project = m.project;
      if (m.model) machine.model = m.model;
      if (m.memory !== undefined) machine.memory = m.memory;
    }
  }
  renderGroupRow(group);
  rebuildTargetSelect();
}

function handleStatus(group, msg) {
  const id = msg.machineId || msg.machine_id || msg.id;
  if (!id) return;
  if (!group.machines[id]) {
    group.machines[id] = { id, name: id, state: 'idle' };
    renderGroupRow(group);
    rebuildTargetSelect();
  }
  const m = group.machines[id];
  m.state = msg.state || m.state;
  if (msg.tool !== undefined) m.tool = msg.tool;
  if (msg.project) m.project = msg.project;
  if (msg.model) m.model = msg.model;
  if (msg.memory !== undefined) m.memory = msg.memory;
  updateMachineCard(group, id);
}

function handleStream(group, msg) {
  const mid = msg.machineId || msg.machine_id || msg.id || 'default';
  const blockKey = group.id + ':' + mid;
  let block = state.resultBlocks[blockKey] || createResultBlock(group, mid, blockKey);
  appendChunk(block, msg.chunk || msg.content || '');
  scrollToBottom();
}

function handleResult(group, msg) {
  const mid = msg.machineId || msg.machine_id || msg.id || 'default';
  const blockKey = group.id + ':' + mid;
  let block = state.resultBlocks[blockKey] || createResultBlock(group, mid, blockKey);
  const cursor = block.bodyEl.querySelector('.cursor');
  if (cursor) cursor.remove();
  block.el.classList.remove('streaming');
  block.el.classList.add('complete');

  if (msg.sessionId || msg.session_id) {
    const sid = msg.sessionId || msg.session_id;
    const metaEl = block.el.querySelector('.result-meta');
    const span = document.createElement('span');
    span.className = 'result-session';
    span.title = 'Tap to copy session ID';
    span.textContent = sid.substring(0, 8) + '\u2026';
    span.addEventListener('click', () => {
      navigator.clipboard.writeText(sid).then(() => {
        toast('Session ID copied', 'success');
        dom.sessionInput.value = sid;
      });
    });
    metaEl.prepend(span);
  }
  scrollToBottom();
}

// ── Machine card rendering ─────────────────────────────────────────────────

function getStatusLabel(m) {
  const st = m.state || 'idle';
  if (st === 'working' || st === 'tool_use') return TOOL_LABELS[m.tool] || 'Working';
  return STATE_LABELS[st] || 'Ready';
}

function updateMachineCard(group, id) {
  const m = group.machines[id];
  if (!m) return;
  const st = m.state || 'idle';
  const color = STATE_COLORS[st] || STATE_COLORS.idle;

  const groupRow = dom.machinesList.querySelector(`[data-group="${group.id}"]`);
  if (!groupRow) return;
  const card = groupRow.querySelector(`[data-machine="${CSS.escape(id)}"]`);
  if (!card) return;

  card.style.background = color + '22';
  card.style.borderColor = color + '60';
  card.style.boxShadow = `inset 0 0 30px ${color}15, 0 0 15px ${color}20`;

  const topBar = card.querySelector('.card-top-bar');
  if (topBar) topBar.style.background = color;

  if (m.engine) {
    m.engine.setState({
      state: st, character: 'clawd',
      tool: m.tool || '', project: m.project || '',
      model: m.model || '', memory: m.memory || 0,
    });
    m.engine.render();
  }
}

async function initEngineForCard(container, machineData) {
  if (!state.createEngine) return null;
  try {
    const engine = state.createEngine(container, {
      useEmoji: false,
      characterImageUrls: {
        apto:  `${STATIC_BASE}/characters/apto.png`,
        clawd: `${STATIC_BASE}/characters/clawd.png`,
        kiro:  `${STATIC_BASE}/characters/kiro.png`,
        claw:  `${STATIC_BASE}/characters/claw.png`,
      }
    });
    await engine.init();
    engine.setState({
      state: machineData.state || 'idle', character: 'clawd',
      tool: machineData.tool || '', project: machineData.project || '',
      model: machineData.model || '', memory: machineData.memory || 0,
    });
    engine.render();
    engine.startAnimation();
    return engine;
  } catch (e) {
    console.warn('VibeMon engine init failed:', e);
    return null;
  }
}

function renderAllGroups() {
  // Cleanup all engines
  for (const group of state.groups) {
    for (const id of Object.keys(group.machines)) {
      if (group.machines[id].engine) {
        try { group.machines[id].engine.cleanup(); } catch {}
        group.machines[id].engine = null;
      }
    }
  }

  dom.machinesList.innerHTML = '';

  if (state.groups.length === 0) {
    dom.machinesList.innerHTML = `
      <div class="machine-card-empty" style="width:100%">
        <div class="empty-face">( · _ · )</div>
        <span>no tokens added<br>tap + to add one</span>
      </div>`;
    return;
  }

  for (const group of state.groups) {
    renderGroupRow(group);
  }
}

function renderGroupRow(group) {
  // Cleanup engines for this group
  for (const id of Object.keys(group.machines)) {
    if (group.machines[id].engine) {
      try { group.machines[id].engine.cleanup(); } catch {}
      group.machines[id].engine = null;
    }
  }

  let groupEl = dom.machinesList.querySelector(`[data-group="${group.id}"]`);
  if (!groupEl) {
    groupEl = document.createElement('div');
    groupEl.className = 'token-group';
    groupEl.dataset.group = group.id;
    dom.machinesList.appendChild(groupEl);
  }

  const ids = Object.keys(group.machines);
  const connDot = group.connected ? 'connected' : 'disconnected';

  groupEl.innerHTML = `
    <div class="token-group-header">
      <div class="token-group-dot ${connDot}"></div>
      <span class="token-group-label">${esc(group.label)}</span>
      <button class="token-remove-btn" data-remove="${group.id}" title="Remove token">&times;</button>
    </div>
    <div class="token-group-cards">
      ${ids.length === 0 ? `
        <div class="machine-card-empty">
          <div class="empty-face">( · _ · )</div>
          <span>no daemons</span>
        </div>
      ` : ''}
    </div>
  `;

  // Bind remove button
  groupEl.querySelector('.token-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`Remove token "${group.label}"?`)) removeGroup(group.id);
  });

  const cardsContainer = groupEl.querySelector('.token-group-cards');

  for (const id of ids) {
    const m = group.machines[id];
    const st = m.state || 'idle';
    const color = STATE_COLORS[st] || STATE_COLORS.idle;

    const card = document.createElement('div');
    card.className = 'machine-card';
    card.dataset.machine = id;
    card.style.background = color + '22';
    card.style.borderColor = color + '60';
    card.style.boxShadow = `inset 0 0 30px ${color}15, 0 0 15px ${color}20`;

    const targetKey = group.id + ':' + id;
    if (state.selectedTarget === targetKey) card.classList.add('selected');

    card.innerHTML = `
      <div class="card-top-bar" style="background:${color}"></div>
      <div class="card-vibemon-wrapper"><div class="card-vibemon vibemon-display"></div></div>
      <div class="card-machine-name">${esc(m.name)}</div>
    `;

    card.addEventListener('click', () => selectMachine(group, id));
    cardsContainer.appendChild(card);

    if (state.vibeMonReady) {
      const container = card.querySelector('.card-vibemon');
      initEngineForCard(container, m).then(engine => {
        if (engine) m.engine = engine;
      });
    }
  }
}

function selectMachine(group, machineId) {
  state.selectedTarget = group.id + ':' + machineId;
  dom.targetSelect.value = state.selectedTarget;
  highlightSelectedCard();
  dom.promptInput.focus();
}

function highlightSelectedCard() {
  dom.machinesList.querySelectorAll('.machine-card').forEach(c => {
    const groupEl = c.closest('[data-group]');
    if (!groupEl) { c.classList.remove('selected'); return; }
    const targetKey = groupEl.dataset.group + ':' + c.dataset.machine;
    c.classList.toggle('selected', targetKey === state.selectedTarget);
  });
}

function rebuildTargetSelect() {
  const current = dom.targetSelect.value;
  dom.targetSelect.innerHTML = '<option value="">— pick target —</option>';

  for (const group of state.groups) {
    const ids = Object.keys(group.machines);
    if (ids.length === 0) continue;

    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;

    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = group.id + ':' + id;
      opt.textContent = group.machines[id].name;
      optgroup.appendChild(opt);
    }
    dom.targetSelect.appendChild(optgroup);
  }

  if (current) dom.targetSelect.value = current;
}

// ── Commands ───────────────────────────────────────────────────────────────

function sendCommand() {
  const prompt = dom.promptInput.value.trim();
  if (!prompt) { toast('Enter a prompt first', 'error'); return; }

  const target = state.selectedTarget || dom.targetSelect.value;
  if (!target || !target.includes(':')) { toast('Select a target machine', 'error'); return; }

  const [gid, mid] = target.split(':');
  const group = state.groups.find(g => g.id === gid);
  if (!group) { toast('Token group not found', 'error'); return; }
  if (!group.connected) { toast('Not connected to this token', 'error'); return; }

  const msg = { type: 'command', target: mid, prompt };
  const session = dom.sessionInput.value.trim();
  if (session) msg.sessionId = session;
  groupSend(group, msg);

  createResultBlock(group, mid, null);
  dom.promptInput.value = '';
  dom.promptInput.style.height = '';
  dom.sendBtn.disabled = true;
  setTimeout(() => { dom.sendBtn.disabled = false; }, 800);
}

// ── Result streaming ───────────────────────────────────────────────────────

function createResultBlock(group, machineId, blockId) {
  const id = blockId || (group.id + ':' + machineId);
  const name = group.machines[machineId]?.name || machineId || 'unknown';
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (dom.resultsEmpty) dom.resultsEmpty.style.display = 'none';

  const el = document.createElement('div');
  el.className = 'result-block streaming';
  el.dataset.blockId = id;
  el.innerHTML = `
    <div class="result-header">
      <span class="result-machine">${esc(group.label)} / ${esc(name)}</span>
      <span class="result-meta">${esc(ts)}</span>
    </div>
    <div class="result-body"><span class="cursor"></span></div>
  `;

  dom.resultsScroll.appendChild(el);
  const bodyEl = el.querySelector('.result-body');
  const block = { el, bodyEl, id };
  state.resultBlocks[id] = block;
  scrollToBottom();
  return block;
}

function appendChunk(block, chunk) {
  const cursor = block.bodyEl.querySelector('.cursor');
  const text = document.createTextNode(chunk);
  if (cursor) block.bodyEl.insertBefore(text, cursor);
  else block.bodyEl.appendChild(text);
}

function scrollToBottom() {
  requestAnimationFrame(() => { dom.resultsScroll.scrollTop = dom.resultsScroll.scrollHeight; });
}

// ── Utilities ──────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Session browser ─────────────────────────────────────────────────────

function requestSessions(group, machineId) {
  if (!machineId) { toast('Select a machine first', 'error'); return; }
  groupSend(group, { type: 'sessions', target: machineId, limit: 20 });
  toast('Loading sessions...', 'success');
}

function handleSessionsList(msg) {
  showSessionsModal(msg.sessions || [], msg.machineId || '');
}

function handleSessionDetail(msg) {
  showSessionDetailModal(msg.messages || [], msg.sessionId || '');
}

function showSessionsModal(sessions, machineId) {
  const existing = document.getElementById('sessions-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'sessions-modal';
  modal.className = 'sessions-modal';

  let listHtml = '';
  if (sessions.length === 0) {
    listHtml = '<div class="session-empty">No sessions found</div>';
  } else {
    for (const s of sessions) {
      const date = new Date(s.modified).toLocaleString([], {
        month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
      });
      listHtml += `
        <div class="session-item" data-sid="${esc(s.sessionId)}" data-machine="${esc(machineId)}">
          <div class="session-item-header">
            <span class="session-project">${esc(s.project || 'unknown')}</span>
            <span class="session-date">${date}</span>
          </div>
          <div class="session-preview">${esc((s.preview||'').slice(0,80))}</div>
          <div class="session-meta">${s.messageCount||0} messages</div>
        </div>`;
    }
  }

  modal.innerHTML = `
    <div class="sessions-backdrop"></div>
    <div class="sessions-sheet">
      <div class="sessions-header">
        <span class="sessions-title">Sessions</span>
        <button class="sessions-close" aria-label="Close">&times;</button>
      </div>
      <div class="sessions-list">${listHtml}</div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('.sessions-close').addEventListener('click', () => modal.remove());
  modal.querySelector('.sessions-backdrop').addEventListener('click', () => modal.remove());
  modal.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', () => {
      // Find the right group to send through
      const target = state.selectedTarget;
      if (target) {
        const [gid] = target.split(':');
        const group = state.groups.find(g => g.id === gid);
        if (group) groupSend(group, { type: 'session_detail', target: item.dataset.machine, sessionId: item.dataset.sid });
      }
      item.style.opacity = '0.5';
    });
  });
}

function showSessionDetailModal(messages, sessionId) {
  const listModal = document.getElementById('sessions-modal');
  if (listModal) listModal.remove();

  const modal = document.createElement('div');
  modal.id = 'session-detail-modal';
  modal.className = 'sessions-modal';

  let chatHtml = '';
  for (const m of messages) {
    const cls = m.role === 'user' ? 'chat-user' : 'chat-assistant';
    chatHtml += `
      <div class="chat-msg ${cls}">
        <div class="chat-role">${m.role === 'user' ? 'You' : 'Claude'}</div>
        <div class="chat-text">${esc(m.text)}</div>
      </div>`;
  }

  modal.innerHTML = `
    <div class="sessions-backdrop"></div>
    <div class="sessions-sheet">
      <div class="sessions-header">
        <span class="sessions-title">Conversation</span>
        <button class="session-resume-btn">Resume</button>
        <button class="sessions-close" aria-label="Close">&times;</button>
      </div>
      <div class="session-chat">${chatHtml}</div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('.sessions-close').addEventListener('click', () => modal.remove());
  modal.querySelector('.sessions-backdrop').addEventListener('click', () => modal.remove());
  modal.querySelector('.session-resume-btn').addEventListener('click', () => {
    dom.sessionInput.value = sessionId;
    modal.remove();
    dom.promptInput.focus();
    toast('Session ID set. Type a message to continue.', 'success');
  });
}

// ── Toast ───────────────────────────────────────────────────────────────

function toast(msg, type = '') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 300ms';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2500);
}
