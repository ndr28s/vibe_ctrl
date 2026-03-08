/**
 * Vibes PWA — WebSocket controller client
 * Uses VibeMon engine for character rendering.
 */

const DEFAULT_SERVER = 'wss://vibes.forthetest.shop/ws';
const RECONNECT_BASE = 1500;
const RECONNECT_MAX  = 30000;
const STATIC_BASE    = 'https://static.vibemon.io';

// VibeMon state colors (from constants.json)
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
  ws: null, connected: false, reconnectTimer: null, reconnectDelay: RECONNECT_BASE,
  token: '', serverUrl: '',
  machines: {},        // id → { id, name, state, tool, engine }
  selectedMachine: null,
  resultBlocks: {},
  blockCounter: 0,
  vibeMonReady: false,
  createEngine: null,  // VibeMon engine factory
};

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
    authModal: $('auth-modal'), authToken: $('auth-token'), authServer: $('auth-server'),
  });
  loadSettings();
  bindEvents();
  loadVibeMonEngine();

  if (!state.token) showAuthModal();
  else connect();
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
    renderMachines();
  });
}

function loadSettings() {
  state.token     = localStorage.getItem('vibes_token')  || '';
  state.serverUrl = localStorage.getItem('vibes_server') || DEFAULT_SERVER;
  if (dom.serverInput) dom.serverInput.value = state.serverUrl;
}

function saveSettings() {
  localStorage.setItem('vibes_token',  state.token);
  localStorage.setItem('vibes_server', state.serverUrl);
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
    if (state.connected) toast('Already connected', 'success');
    else { clearTimeout(state.reconnectTimer); state.reconnectDelay = RECONNECT_BASE; connect(); }
  });
  $('auth-submit').addEventListener('click', submitAuth);
  $('auth-cancel').addEventListener('click', () => { if (state.token) hideAuthModal(); });
  $('settings-btn').addEventListener('click', () => {
    dom.authToken.value = state.token; dom.authServer.value = state.serverUrl; showAuthModal();
  });
  dom.serverInput.addEventListener('change', () => {
    state.serverUrl = dom.serverInput.value.trim() || DEFAULT_SERVER; saveSettings();
  });
  $('sessions-btn').addEventListener('click', () => {
    requestSessions(state.selectedMachine || Object.keys(state.machines)[0]);
  });
  dom.targetSelect.addEventListener('change', () => {
    state.selectedMachine = dom.targetSelect.value || null; highlightSelectedCard();
  });
}

// ── Auth modal ─────────────────────────────────────────────────────────────

function showAuthModal() {
  dom.authToken.value = state.token; dom.authServer.value = state.serverUrl;
  dom.authModal.classList.remove('hidden');
  setTimeout(() => dom.authToken.focus(), 300);
}
function hideAuthModal() { dom.authModal.classList.add('hidden'); }

function submitAuth() {
  const token = dom.authToken.value.trim();
  const server = dom.authServer.value.trim() || DEFAULT_SERVER;
  if (!token) { toast('Token is required', 'error'); dom.authToken.focus(); return; }
  state.token = token; state.serverUrl = server; dom.serverInput.value = server;
  saveSettings(); hideAuthModal();
  if (state.ws) state.ws.close(); else connect();
}

// ── WebSocket ──────────────────────────────────────────────────────────────

function connect() {
  if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
  setConnectionState('connecting');
  try { state.ws = new WebSocket(state.serverUrl); }
  catch { setConnectionState('error'); scheduleReconnect(); return; }
  state.ws.addEventListener('open', onOpen);
  state.ws.addEventListener('message', onMessage);
  state.ws.addEventListener('close', onClose);
  state.ws.addEventListener('error', () => setConnectionState('error'));
}

function onOpen() {
  state.connected = true; state.reconnectDelay = RECONNECT_BASE;
  setConnectionState('connected');
  send({ type: 'register', role: 'controller', token: state.token });
  send({ type: 'machines' });
}

function onMessage(event) {
  let msg; try { msg = JSON.parse(event.data); } catch { return; }
  switch (msg.type) {
    case 'machines':        handleMachinesList(msg.machines || []); break;
    case 'status':          handleStatus(msg); break;
    case 'stream':          handleStream(msg); break;
    case 'result':          handleResult(msg); break;
    case 'sessions':        handleSessionsList(msg); break;
    case 'session_detail':  handleSessionDetail(msg); break;
    case 'daemon_disconnected': handleDaemonDisconnected(msg); break;
    case 'error':           toast(msg.message || 'Server error', 'error'); break;
  }
}

function onClose() {
  state.connected = false; setConnectionState('error');
  for (const id of Object.keys(state.machines)) {
    const m = state.machines[id];
    if (m) { m.state = 'offline'; updateMachineCard(id); }
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => { if (!state.connected) connect(); }, state.reconnectDelay);
  state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, RECONNECT_MAX);
}

function send(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(data));
}

function setConnectionState(s) {
  dom.connBadge.className = 'conn-badge ' + s;
  dom.connLabel.textContent = { connected:'online', connecting:'connecting', error:'offline' }[s] || s;
}

// ── Machine management ─────────────────────────────────────────────────────

function handleMachinesList(machines) {
  for (const m of machines) {
    const id = typeof m === 'string' ? m : (m.id || m.machineId);
    if (!id) continue;
    if (!state.machines[id]) state.machines[id] = { id, name: id, state: 'idle' };
  }
  renderMachines();
  rebuildTargetSelect();
}

function handleStatus(msg) {
  const id = msg.machineId || msg.machine_id || msg.id;
  if (!id) return;
  if (!state.machines[id]) {
    state.machines[id] = { id, name: id, state: 'idle' };
    renderMachines();
    rebuildTargetSelect();
  }
  const m = state.machines[id];
  m.state = msg.state || m.state;
  if (msg.tool !== undefined) m.tool = msg.tool;
  if (msg.project) m.project = msg.project;
  if (msg.model) m.model = msg.model;
  if (msg.memory !== undefined) m.memory = msg.memory;
  updateMachineCard(id);
}

function handleDaemonDisconnected(msg) {
  const id = msg.machineId || msg.machine_id || msg.id;
  if (!id) return;
  const m = state.machines[id];
  if (m) { m.state = 'offline'; updateMachineCard(id); }
}

function getStatusLabel(m) {
  const st = m.state || 'idle';
  if (st === 'working' || st === 'tool_use') {
    return TOOL_LABELS[m.tool] || 'Working';
  }
  return STATE_LABELS[st] || 'Ready';
}

function updateMachineCard(id) {
  const m = state.machines[id];
  if (!m) return;
  const st = m.state || 'idle';
  const color = STATE_COLORS[st] || STATE_COLORS.idle;

  const card = dom.machinesList.querySelector(`[data-machine="${CSS.escape(id)}"]`);
  if (!card) return;

  // Card border/glow
  card.style.background = color + '22';
  card.style.borderColor = color + '60';
  card.style.boxShadow = `inset 0 0 30px ${color}15, 0 0 15px ${color}20`;

  // Top bar
  const topBar = card.querySelector('.card-top-bar');
  if (topBar) topBar.style.background = color;

  // VibeMon engine handles all rendering (character, status, project, model, memory)
  if (m.engine) {
    m.engine.setState({
      state: st,
      character: 'clawd',
      tool: m.tool || '',
      project: m.project || '',
      model: m.model || '',
      memory: m.memory || 0,
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
      state: machineData.state || 'idle',
      character: 'clawd',
      tool: machineData.tool || '',
      project: machineData.project || '',
      model: machineData.model || '',
      memory: machineData.memory || 0,
    });
    engine.render();
    engine.startAnimation();
    return engine;
  } catch (e) {
    console.warn('VibeMon engine init failed:', e);
    return null;
  }
}

function renderMachines() {
  // Cleanup old engines
  for (const id of Object.keys(state.machines)) {
    if (state.machines[id].engine) {
      try { state.machines[id].engine.cleanup(); } catch {}
      state.machines[id].engine = null;
    }
  }

  dom.machinesList.innerHTML = '';

  const ids = Object.keys(state.machines);
  if (ids.length === 0) {
    dom.machinesList.innerHTML = `
      <div class="machine-card-empty">
        <div class="empty-face">( · _ · )</div>
        <span>no daemons<br>connected</span>
      </div>`;
    return;
  }

  for (const id of ids) {
    const m = state.machines[id];
    const st = m.state || 'idle';
    const color = STATE_COLORS[st] || STATE_COLORS.idle;

    const card = document.createElement('div');
    card.className = 'machine-card';
    card.dataset.machine = id;
    card.style.background = color + '22';
    card.style.borderColor = color + '60';
    card.style.boxShadow = `inset 0 0 30px ${color}15, 0 0 15px ${color}20`;
    if (state.selectedMachine === id) card.classList.add('selected');

    // VibeMon engine renders everything (character, status, project, model, memory)
    // Wrapper clips the scaled-down 172x348 container to card size
    card.innerHTML = `
      <div class="card-top-bar" style="background:${color}"></div>
      <div class="card-vibemon-wrapper"><div class="card-vibemon vibemon-display"></div></div>
      <div class="card-machine-name">${esc(m.name)}</div>
    `;

    card.addEventListener('click', () => selectMachine(id));
    dom.machinesList.appendChild(card);

    // Initialize VibeMon engine for this card
    if (state.vibeMonReady) {
      const container = card.querySelector('.card-vibemon');
      initEngineForCard(container, m).then(engine => {
        if (engine) m.engine = engine;
      });
    }
  }
}

function selectMachine(id) {
  state.selectedMachine = id;
  dom.targetSelect.value = id;
  highlightSelectedCard();
  dom.promptInput.focus();
}

function highlightSelectedCard() {
  dom.machinesList.querySelectorAll('.machine-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.machine === state.selectedMachine);
  });
}

function rebuildTargetSelect() {
  const current = dom.targetSelect.value;
  dom.targetSelect.innerHTML = '<option value="">— pick target —</option>';
  for (const id of Object.keys(state.machines)) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = state.machines[id].name;
    dom.targetSelect.appendChild(opt);
  }
  if (current && state.machines[current]) dom.targetSelect.value = current;
}

// ── Commands ───────────────────────────────────────────────────────────────

function sendCommand() {
  const prompt = dom.promptInput.value.trim();
  if (!prompt) { toast('Enter a prompt first', 'error'); return; }
  const target = state.selectedMachine || dom.targetSelect.value;
  if (!target) { toast('Select a target machine', 'error'); return; }
  if (!state.connected) { toast('Not connected', 'error'); return; }

  const msg = { type: 'command', target, prompt };
  const session = dom.sessionInput.value.trim();
  if (session) msg.sessionId = session;
  send(msg);

  createResultBlock(target, prompt, null);
  dom.promptInput.value = '';
  dom.promptInput.style.height = '';
  dom.sendBtn.disabled = true;
  setTimeout(() => { dom.sendBtn.disabled = false; }, 800);
}

// ── Result streaming ───────────────────────────────────────────────────────

function handleStream(msg) {
  const mid = msg.machineId || msg.machine_id || msg.id || 'default';
  let block = state.resultBlocks[mid] || createResultBlock(mid, null, mid);
  appendChunk(block, msg.chunk || msg.content || '');
  scrollToBottom();
}

function handleResult(msg) {
  const mid = msg.machineId || msg.machine_id || msg.id || 'default';
  let block = state.resultBlocks[mid] || createResultBlock(mid, null, mid);
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

function createResultBlock(machineId, prompt, blockId) {
  const id = blockId || ('block-' + (++state.blockCounter));
  const name = state.machines[machineId]?.name || machineId || 'unknown';
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (dom.resultsEmpty) dom.resultsEmpty.style.display = 'none';

  const el = document.createElement('div');
  el.className = 'result-block streaming';
  el.dataset.blockId = id;
  el.innerHTML = `
    <div class="result-header">
      <span class="result-machine">${esc(name)}</span>
      <span class="result-meta">${esc(ts)}</span>
    </div>
    <div class="result-body">${prompt ? '<span class="prompt-echo">\u203A ' + esc(prompt) + '\n\n</span>' : ''}<span class="cursor"></span></div>
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

function requestSessions(machineId) {
  if (!machineId) { toast('Select a machine first', 'error'); return; }
  send({ type: 'sessions', target: machineId, limit: 20 });
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
      send({ type: 'session_detail', target: item.dataset.machine, sessionId: item.dataset.sid });
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
