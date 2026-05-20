'use strict';

const DRONE_COLOURS = ['#00e676','#00b0ff','#ff9100','#e040fb','#ffea00'];
const HANDLE_R = 6;

const S = {
  seqData:     null,
  frames:      {},
  fi:          0,
  activeDrone: null,
  dirty:       false,
  videoW:      1,
  videoH:      1,
  playing:     false,
  playSpeed:   1,
  memorise:    false,
  drag:        null,
  selectedBox: null,
  seqList:     [],
  zoom:        1.0,
};

const elCanvas     = document.getElementById('canvas');
const ctx          = elCanvas.getContext('2d');
const elSeqList    = document.getElementById('seq-list');
const elSeqSearch  = document.getElementById('seq-search');
const elSeqTitle   = document.getElementById('seq-title');
const elFrameLabel = document.getElementById('frame-label');
const elFrameInfo  = document.getElementById('frame-info-text');
const elDroneBar   = document.getElementById('drone-buttons');
const elBtnPlay    = document.getElementById('btn-play');
const elBtn2x       = document.getElementById('btn-2x');
const elBtn4x       = document.getElementById('btn-4x');
const elBtnMemorise   = document.getElementById('btn-memorise');
const elBtnExpandAll  = document.getElementById('btn-expand-all');
const elBtnPrev       = document.getElementById('btn-prev');
const elBtnNext       = document.getElementById('btn-next');
const elBtnHelp       = document.getElementById('btn-help');
const elBtnErase      = document.getElementById('btn-erase-frame');
const elBtnSave       = document.getElementById('btn-save');
const elBtnReload     = document.getElementById('btn-reload');
const elBtnRevert     = document.getElementById('btn-revert-frame');
const elBtnRevertSeq  = document.getElementById('btn-revert-seq');
const elSaveStatus = document.getElementById('save-status');

const elViewerOuter  = document.getElementById('viewer-outer');
const elTimeBarTrack = document.getElementById('time-bar-track');
const elTimeBarFill  = document.getElementById('time-bar-fill');
const elTimeBarThumb = document.getElementById('time-bar-thumb');
const elTimeCurrent  = document.getElementById('time-current');
const elTimeTotal    = document.getElementById('time-total');

// ── Coordinates ───────────────────────────────────────────────────────────────

// Account for CSS scaling (canvas logical size vs displayed size)
function screenToCanvas(clientX, clientY) {
  const rect = elCanvas.getBoundingClientRect();
  return [
    (clientX - rect.left) * (elCanvas.width  / rect.width),
    (clientY - rect.top)  * (elCanvas.height / rect.height),
  ];
}

// ── Fit canvas to viewer ──────────────────────────────────────────────────────

function fitCanvas() {
  if (!S.videoW || !S.videoH) return;
  const availW = elViewerOuter.clientWidth;
  const availH = elViewerOuter.clientHeight;
  const scale  = Math.min(availW / S.videoW, availH / S.videoH);
  elCanvas.style.width  = Math.floor(S.videoW * scale * S.zoom) + 'px';
  elCanvas.style.height = Math.floor(S.videoH * scale * S.zoom) + 'px';
}

new ResizeObserver(fitCanvas).observe(elViewerOuter);

// ── Sequence list ─────────────────────────────────────────────────────────────

async function loadSeqList() {
  const data = await fetch('/api/sequences').then(r => r.json());
  S.seqList = data;
  renderSeqList();
}

function renderSeqList() {
  const q = elSeqSearch.value.toLowerCase();
  elSeqList.innerHTML = '';
  for (const s of S.seqList) {
    const label = `${s.split}/${s.seq}`;
    if (q && !label.includes(q)) continue;
    const div = document.createElement('div');
    div.className = 'seq-item' + (
      S.seqData && S.seqData.split === s.split && S.seqData.seq === s.seq ? ' active' : ''
    );
    const tags = [];
    if (!s.has_video) tags.push('<span class="tag no-video">no video</span>');
    if (s.has_temp)   tags.push('<span class="tag unsaved">unsaved</span>');
    div.innerHTML = `<span class="seq-item-name">${label}</span>
      <span class="seq-item-meta">${tags.join('')}</span>`;
    div.addEventListener('click', () => openSequence(s.split, s.seq));
    elSeqList.appendChild(div);
  }
}

elSeqSearch.addEventListener('input', renderSeqList);

// ── Open sequence ─────────────────────────────────────────────────────────────

async function openSequence(split, seq) {
  elSeqTitle.textContent = `Loading ${split}/${seq}…`;
  const data = await fetch(`/api/sequence/${split}/${seq}`).then(r => r.json());
  S.seqData = data;
  S.frames  = {};
  for (const [k, v] of Object.entries(data.frames)) {
    S.frames[parseInt(k)] = v.map(r => ({ ...r }));
  }
  S.fi          = 0;
  S.activeDrone = null;
  S.selectedBox = null;
  S.dirty       = data.has_temp;
  S.zoom        = 1.0;
  _pushQueue    = Promise.resolve();
  _frameCache.clear();
  _fetchInFlight.clear();

  elSeqTitle.textContent = `${split} / ${seq}`;
  elSaveStatus.textContent = '';

  buildDroneBar(data.drone_names);
  loadVideo(split, seq);
  renderSeqList();
}

function buildDroneBar(names) {
  elDroneBar.innerHTML = '';
  names.forEach((name, i) => {
    const col = DRONE_COLOURS[i] || '#ffffff';
    const btn = document.createElement('button');
    btn.className = 'drone-btn';
    btn.textContent = name;
    btn.style.background  = col + '22';
    btn.style.color       = col;
    btn.style.borderColor = col + '44';
    btn.dataset.idx = i;
    btn.addEventListener('click', () => selectDrone(i));
    elDroneBar.appendChild(btn);
  });
}

function selectDrone(idx) {
  const name = S.seqData.drone_names[idx];
  const col  = DRONE_COLOURS[idx] || '#ffffff';
  S.activeDrone = (S.activeDrone && S.activeDrone.name === name)
    ? null
    : { name, idx, colour: col };
  updateDroneBar();
  drawCanvas();
}

function updateDroneBar() {
  for (const btn of elDroneBar.querySelectorAll('.drone-btn')) {
    btn.classList.toggle('selected', S.activeDrone && S.activeDrone.idx === parseInt(btn.dataset.idx));
  }
}

// ── Frame loading + prefetch cache ───────────────────────────────────────────

let _currentFrameImg = null;
const _frameCache     = new Map();   // fi → Image
const _fetchInFlight  = new Set();   // fi values currently being fetched
const PREFETCH_AHEAD  = 30;          // frames to prefetch during playback

function loadVideo(split, seq) {
  _frameCache.clear();
  _fetchInFlight.clear();
  _fetchFrame(split, seq, 0, (img) => {
    if (!img) return;
    S.videoW = img.naturalWidth;
    S.videoH = img.naturalHeight;
    elCanvas.width  = S.videoW;
    elCanvas.height = S.videoH;
    fitCanvas();
    _currentFrameImg = img;
    _frameCache.set(0, img);
    drawCanvas();
    updateFrameLabel();
    updateTimeBar();
  });
}

function _fetchFrame(split, seq, fi, cb) {
  const img = new Image();
  img.onload  = () => cb(img);
  img.onerror = () => cb(null);
  img.src = `/frame/${split}/${seq}/${fi}`;
}

async function _prefetch(fromFi) {
  if (!S.seqData || !S.playing) return;
  const { split, seq, n_frames } = S.seqData;
  // Fetch sequentially so server can do sequential reads (no seeking)
  for (let i = 1; i <= PREFETCH_AHEAD; i++) {
    if (!S.playing) break;
    const fi = fromFi + i;
    if (fi >= n_frames) break;
    if (_frameCache.has(fi) || _fetchInFlight.has(fi)) continue;
    _fetchInFlight.add(fi);
    await new Promise(resolve => {
      _fetchFrame(split, seq, fi, (img) => {
        _fetchInFlight.delete(fi);
        if (img) _frameCache.set(fi, img);
        resolve();
      });
    });
  }
  // Evict frames behind current position
  for (const key of _frameCache.keys()) {
    if (key < fromFi - 2) _frameCache.delete(key);
  }
}

function seekToFrame(fi) {
  if (!S.seqData) return;
  fi = Math.max(0, Math.min(fi, S.seqData.n_frames - 1));
  S.fi = fi;
  S.selectedBox = null;
  updateFrameLabel();
  updateTimeBar();

  if (_frameCache.has(fi)) {
    _currentFrameImg = _frameCache.get(fi);
    drawCanvas();
    _prefetch(fi);
  } else {
    const { split, seq } = S.seqData;
    _fetchFrame(split, seq, fi, (img) => {
      if (img) { _frameCache.set(fi, img); _currentFrameImg = img; }
      drawCanvas();
      _prefetch(fi);
    });
  }
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function updateFrameLabel() {
  if (!S.seqData) return;
  elFrameLabel.textContent = `Frame ${S.fi + 1} / ${S.seqData.n_frames}`;
  const t0 = S.fi * S.seqData.window_s;
  const t1 = t0 + S.seqData.window_s;
  const boxes = S.frames[S.fi] || [];
  elFrameInfo.textContent =
    `t = [${t0.toFixed(3)}, ${t1.toFixed(3)}] s   |   ${boxes.length} box(es) in frame`;
}

function updateTimeBar() {
  if (!S.seqData) return;
  const n      = S.seqData.n_frames;
  const pct    = n > 1 ? (S.fi / (n - 1)) * 100 : 0;
  const tCur   = S.fi * S.seqData.window_s;
  const tTotal = (n - 1) * S.seqData.window_s;
  elTimeBarFill.style.width  = pct + '%';
  elTimeBarThumb.style.left  = pct + '%';
  elTimeCurrent.textContent  = fmtTime(tCur);
  elTimeTotal.textContent    = fmtTime(tTotal);
}

// ── Canvas drawing ────────────────────────────────────────────────────────────

function droneColour(name) {
  if (!S.seqData) return '#ffffff';
  const idx = S.seqData.drone_names.indexOf(name);
  return idx >= 0 ? DRONE_COLOURS[idx] : '#ffffff';
}

function drawCanvas() {
  if (_currentFrameImg) {
    ctx.drawImage(_currentFrameImg, 0, 0, elCanvas.width, elCanvas.height);
  } else {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, elCanvas.width, elCanvas.height);
  }
  const boxes = S.frames[S.fi] || [];

  boxes.forEach((b, idx) => {
    const col      = droneColour(b.drone_name);
    const selected = S.selectedBox && S.selectedBox.fi === S.fi && S.selectedBox.idx === idx;

    ctx.strokeStyle = col;
    ctx.lineWidth   = selected ? 3 : 2;
    ctx.setLineDash(selected ? [5, 3] : []);
    ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
    ctx.setLineDash([]);

    const label = b.drone_name || 'drone';
    ctx.font = '12px Segoe UI, sans-serif';
    const tw = ctx.measureText(label).width;
    const ty = b.y1 > 18 ? b.y1 - 4 : b.y2 + 16;
    ctx.fillStyle = col + 'cc';
    ctx.fillRect(b.x1, ty - 13, tw + 6, 15);
    ctx.fillStyle = '#000';
    ctx.fillText(label, b.x1 + 3, ty - 1);

    for (const [hx, hy] of corners(b)) {
      ctx.fillStyle = selected ? col : col + '99';
      ctx.fillRect(hx - HANDLE_R, hy - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
    }
  });

  if (S.drag && S.drag.type === 'draw') {
    const { x0, y0, x1, y1 } = S.drag;
    const col = S.activeDrone ? S.activeDrone.colour : '#ffffff';
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
  }

  updateFrameLabel();
}

function corners(b) {
  return [[b.x1, b.y1], [b.x2, b.y1], [b.x1, b.y2], [b.x2, b.y2]];
}

function hitTestBox(b, cx, cy) {
  const cs = [
    ['corner-tl', b.x1, b.y1], ['corner-tr', b.x2, b.y1],
    ['corner-bl', b.x1, b.y2], ['corner-br', b.x2, b.y2],
  ];
  for (const [name, hx, hy] of cs) {
    if (Math.abs(cx - hx) <= HANDLE_R + 2 && Math.abs(cy - hy) <= HANDLE_R + 2) return name;
  }
  if (cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2) return 'move';
  return null;
}

function hitTest(cx, cy) {
  const boxes = S.frames[S.fi] || [];
  for (let i = boxes.length - 1; i >= 0; i--) {
    const h = hitTestBox(boxes[i], cx, cy);
    if (h) return { idx: i, hit: h };
  }
  return null;
}

function cursorForHit(result) {
  if (!result) return 'crosshair';
  switch (result.hit) {
    case 'corner-tl': return 'nw-resize';
    case 'corner-tr': return 'ne-resize';
    case 'corner-bl': return 'sw-resize';
    case 'corner-br': return 'se-resize';
    case 'move':      return 'move';
    default:          return 'crosshair';
  }
}

// ── Mouse interaction ─────────────────────────────────────────────────────────

elCanvas.addEventListener('mousedown', onMouseDown);
elCanvas.addEventListener('mousemove', onMouseMove);
elCanvas.addEventListener('mouseup',   onMouseUp);
elCanvas.addEventListener('mouseleave', () => { elCanvas.style.cursor = 'crosshair'; });

function onMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const [cx, cy] = screenToCanvas(e.clientX, e.clientY);

  const result = hitTest(cx, cy);

  if (S.memorise && !result) {
    placeMemoriseBox(cx, cy);
    return;
  }

  if (result) {
    S.selectedBox = { fi: S.fi, idx: result.idx };
    const b = (S.frames[S.fi] || [])[result.idx];
    if (!b) return;
    S.drag = {
      type: result.hit === 'move' ? 'move' : 'resize',
      idx: result.idx, hit: result.hit,
      startCX: cx, startCY: cy,
      orig: { ...b },
    };
  } else if (S.activeDrone && !S.memorise) {
    S.selectedBox = null;
    S.drag = { type: 'draw', x0: cx, y0: cy, x1: cx, y1: cy };
  } else {
    S.selectedBox = null;
  }
  drawCanvas();
}

function onMouseMove(e) {
  const [cx, cy] = screenToCanvas(e.clientX, e.clientY);

  if (!S.drag) {
    elCanvas.style.cursor = cursorForHit(hitTest(cx, cy));
    return;
  }

  if (S.drag.type === 'draw') {
    S.drag.x1 = cx; S.drag.y1 = cy;
    drawCanvas();
    return;
  }

  const dx = cx - S.drag.startCX;
  const dy = cy - S.drag.startCY;
  const o  = S.drag.orig;
  const b  = (S.frames[S.fi] || [])[S.drag.idx];
  if (!b) return;

  if (S.drag.type === 'move') {
    b.x1 = o.x1 + dx; b.y1 = o.y1 + dy;
    b.x2 = o.x2 + dx; b.y2 = o.y2 + dy;
  } else {
    switch (S.drag.hit) {
      case 'corner-tl': b.x1 = o.x1 + dx; b.y1 = o.y1 + dy; break;
      case 'corner-tr': b.x2 = o.x2 + dx; b.y1 = o.y1 + dy; break;
      case 'corner-bl': b.x1 = o.x1 + dx; b.y2 = o.y2 + dy; break;
      case 'corner-br': b.x2 = o.x2 + dx; b.y2 = o.y2 + dy; break;
    }
  }
  drawCanvas();
}

function onMouseUp(e) {
  if (!S.drag) return;

  if (S.drag.type === 'draw') {
    const x1 = Math.min(S.drag.x0, S.drag.x1);
    const y1 = Math.min(S.drag.y0, S.drag.y1);
    const x2 = Math.max(S.drag.x0, S.drag.x1);
    const y2 = Math.max(S.drag.y0, S.drag.y1);
    if (x2 - x1 > 4 && y2 - y1 > 4 && S.activeDrone) {
      const boxes = S.frames[S.fi] || (S.frames[S.fi] = []);
      const usedNums = Object.values(S.frames).flat().map(b => b.drone_num);
      const drone_num = usedNums.length ? Math.max(...usedNums) + 1 : 1;
      boxes.push({ x1, y1, x2, y2, drone_num, drone_name: S.activeDrone.name, t: null, _isNew: true });
      S.selectedBox = { fi: S.fi, idx: boxes.length - 1 };
      pushFrameUpdate();
    }
  } else {
    const b = (S.frames[S.fi] || [])[S.drag.idx];
    if (b) {
      if (b.x1 > b.x2) [b.x1, b.x2] = [b.x2, b.x1];
      if (b.y1 > b.y2) [b.y1, b.y2] = [b.y2, b.y1];
      pushFrameUpdate();
    }
  }

  S.drag = null;
  drawCanvas();
}

// ── Frame editing ─────────────────────────────────────────────────────────────

// Serialised push queue — every update waits for the previous to finish,
// so Save can await this and be sure the temp file is up to date.
let _pushQueue = Promise.resolve();

function pushFrameUpdate(fi = S.fi) {
  if (!S.seqData) return;
  const { split, seq } = S.seqData;
  const boxes = (S.frames[fi] || []).map(b => ({
    x1: Math.round(b.x1 * 10) / 10,
    y1: Math.round(b.y1 * 10) / 10,
    x2: Math.round(b.x2 * 10) / 10,
    y2: Math.round(b.y2 * 10) / 10,
    drone_num:  b.drone_num,
    drone_name: b.drone_name,
    t: b._isNew ? null : (b.t ?? null),
  }));
  _pushQueue = _pushQueue.then(() =>
    fetch(`/api/gt/${split}/${seq}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fi, boxes }),
    }).then(() => { S.dirty = true; renderSeqList(); })
      .catch(err => console.error('pushFrameUpdate failed:', err))
  );
}

function deleteSelectedBox() {
  if (!S.selectedBox || S.selectedBox.fi !== S.fi) return;
  const boxes = S.frames[S.fi];
  if (!boxes) return;
  boxes.splice(S.selectedBox.idx, 1);
  S.selectedBox = null;
  drawCanvas();
  pushFrameUpdate();
}

// ── Memorise mode ────────────────────────────────────────────────────────────

function toggleMemorise() {
  S.memorise = !S.memorise;
  elBtnMemorise.classList.toggle('selected', S.memorise);
}

function _biggestBoxInFrame(fi) {
  const boxes = S.frames[fi] || [];
  if (!boxes.length) return null;
  return boxes.reduce((best, b) => {
    const area = (b.x2 - b.x1) * (b.y2 - b.y1);
    return area > (best.x2 - best.x1) * (best.y2 - best.y1) ? b : best;
  });
}

function placeMemoriseBox(cx, cy) {
  if (!S.activeDrone) return;
  let ref = null;
  for (let f = S.fi - 1; f >= 0; f--) {
    ref = _biggestBoxInFrame(f);
    if (ref) break;
  }
  if (!ref) return;
  const w  = ref.x2 - ref.x1;
  const h  = ref.y2 - ref.y1;
  const x1 = cx - w / 2;
  const y1 = cy - h / 2;
  const x2 = cx + w / 2;
  const y2 = cy + h / 2;
  const boxes    = S.frames[S.fi] || (S.frames[S.fi] = []);
  const usedNums = Object.values(S.frames).flat().map(b => b.drone_num);
  const drone_num = usedNums.length ? Math.max(...usedNums) + 1 : 1;
  boxes.push({ x1, y1, x2, y2, drone_num, drone_name: S.activeDrone.name, t: null, _isNew: true });
  S.selectedBox = { fi: S.fi, idx: boxes.length - 1 };
  drawCanvas();
  pushFrameUpdate();
}

// ── Zoom ─────────────────────────────────────────────────────────────────────

elViewerOuter.addEventListener('wheel', (e) => {
  e.preventDefault();

  const factor  = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newZoom = Math.max(0.25, Math.min(8, S.zoom * factor));
  if (newZoom === S.zoom) return;

  // Cursor's fractional position on the canvas before zoom
  const viewerRect  = elViewerOuter.getBoundingClientRect();
  const canvasRect  = elCanvas.getBoundingClientRect();
  const fracX = (e.clientX - canvasRect.left)  / canvasRect.width;
  const fracY = (e.clientY - canvasRect.top)   / canvasRect.height;

  S.zoom = newZoom;
  fitCanvas();

  // New canvas CSS size (mirrors fitCanvas formula)
  const scale  = Math.min(elViewerOuter.clientWidth  / S.videoW,
                           elViewerOuter.clientHeight / S.videoH);
  const newW   = Math.floor(S.videoW * scale * newZoom);
  const newH   = Math.floor(S.videoH * scale * newZoom);

  // Canvas origin in scroll-space (margin:auto centres when smaller than viewer)
  const canvasLeft = Math.max(0, (elViewerOuter.clientWidth  - newW) / 2);
  const canvasTop  = Math.max(0, (elViewerOuter.clientHeight - newH) / 2);

  // Scroll so the canvas point under the cursor stays under the cursor
  elViewerOuter.scrollLeft = canvasLeft + fracX * newW - (e.clientX - viewerRect.left);
  elViewerOuter.scrollTop  = canvasTop  + fracY * newH - (e.clientY - viewerRect.top);
}, { passive: false });

// ── Expand boxes ──────────────────────────────────────────────────────────────

function _expandFrame(fi) {
  const boxes = S.frames[fi];
  if (!boxes || !boxes.length) return false;
  boxes.forEach(b => {
    const cx = (b.x1 + b.x2) / 2;
    const cy = (b.y1 + b.y2) / 2;
    const w  = (b.x2 - b.x1) * 1.1;
    const h  = (b.y2 - b.y1) * 1.1;
    b.x1 = cx - w / 2;
    b.y1 = cy - h / 2;
    b.x2 = cx + w / 2;
    b.y2 = cy + h / 2;
  });
  return true;
}

function expandBoxes() {
  if (_expandFrame(S.fi)) { drawCanvas(); pushFrameUpdate(); }
}

function expandAllFromCurrent() {
  if (!S.seqData) return;
  let changed = false;
  for (let f = S.fi; f < S.seqData.n_frames; f++) {
    if (_expandFrame(f)) { pushFrameUpdate(f); changed = true; }
  }
  if (changed) drawCanvas();
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (document.activeElement === elSeqSearch) return;
  if (e.key === 'Escape' && elHelpOverlay.classList.contains('visible')) {
    toggleHelp(); return;
  }
  if (elHelpOverlay.classList.contains('visible')) return;
  switch (e.key) {
    case 'ArrowLeft':
    case 'a': case 'A':
      e.preventDefault(); seekToFrame(S.fi - 1); break;
    case 'ArrowRight':
    case 'd': case 'D':
      e.preventDefault(); seekToFrame(S.fi + 1); break;
    case ' ':
      e.preventDefault(); togglePlay(); break;
    case 'm': case 'M':
      toggleMemorise(); break;
    case 'r': case 'R':
      if (!S.seqData) break;
      S.frames[S.fi] = []; S.selectedBox = null;
      drawCanvas(); pushFrameUpdate(); break;
    case 'e': case 'E':
      expandBoxes(); break;
    case '?':
      toggleHelp(); break;
    case 'Escape':
      S.activeDrone = null; S.selectedBox = null;
      updateDroneBar(); drawCanvas(); break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault(); deleteSelectedBox(); break;
  }
});

// ── Play/pause ────────────────────────────────────────────────────────────────

function togglePlay() {
  if (!S.seqData) return;
  if (S.playing) {
    clearInterval(S._playTimer);
    S.playing = false;
    elBtnPlay.textContent = '▶';
  } else {
    S.playing = true;
    elBtnPlay.textContent = '⏸';
    _prefetch(S.fi);
    S._playTimer = setInterval(() => {
      if (S.fi >= S.seqData.n_frames - 1) { togglePlay(); return; }
      seekToFrame(S.fi + 1);
    }, 1000 / (30 * S.playSpeed));
  }
}

function setSpeed(x) {
  const wasPlaying = S.playing;
  if (wasPlaying) togglePlay();
  S.playSpeed = x;
  elBtn2x.classList.toggle('selected', x === 2);
  elBtn4x.classList.toggle('selected', x === 4);
  if (wasPlaying) togglePlay();
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

elBtnPlay.addEventListener('click',  togglePlay);
elBtn2x.addEventListener('click',       () => setSpeed(S.playSpeed === 2 ? 1 : 2));
elBtn4x.addEventListener('click',       () => setSpeed(S.playSpeed === 4 ? 1 : 4));
elBtnMemorise.addEventListener('click', toggleMemorise);
elBtnExpandAll.addEventListener('click', expandAllFromCurrent);
elBtnPrev.addEventListener('click',  () => seekToFrame(S.fi - 1));
elBtnNext.addEventListener('click',  () => seekToFrame(S.fi + 1));

elBtnErase.addEventListener('click', () => {
  if (!S.seqData) return;
  S.frames[S.fi] = [];
  S.selectedBox = null;
  drawCanvas();
  pushFrameUpdate();
});

elBtnReload.addEventListener('click', async () => {
  if (!S.seqData) return;
  const { split, seq } = S.seqData;
  const fi = S.fi;
  const fresh = await fetch(`/api/sequence/${split}/${seq}`).then(r => r.json());
  S.frames = {};
  for (const [k, v] of Object.entries(fresh.frames)) {
    S.frames[parseInt(k)] = v.map(r => ({ ...r }));
  }
  S.dirty       = fresh.has_temp;
  S.selectedBox = null;
  S.fi          = fi;
  drawCanvas();
  updateFrameLabel();
  updateTimeBar();
  updateSaveStatus('Reloaded', 'ok');
  renderSeqList();
});

elBtnRevert.addEventListener('click', async () => {
  if (!S.seqData) return;
  const { split, seq } = S.seqData;
  await fetch(`/api/revert_frame/${split}/${seq}/${S.fi}`, { method: 'POST' });
  const fresh = await fetch(`/api/sequence/${split}/${seq}`).then(r => r.json());
  const fi = S.fi;
  delete S.frames[fi];
  if (fresh.frames[String(fi)]) S.frames[fi] = fresh.frames[String(fi)].map(r => ({ ...r }));
  S.selectedBox = null;
  drawCanvas();
  updateSaveStatus('Reverted');
});

elBtnSave.addEventListener('click', async () => {
  if (!S.seqData) return;
  const { split, seq } = S.seqData;
  await _pushQueue;  // wait for all in-flight frame updates to land first
  const res = await fetch(`/api/save/${split}/${seq}`, { method: 'POST' }).then(r => r.json());
  if (res.ok) {
    S.dirty = false;
    updateSaveStatus('Saved ✓', 'ok');
    const s = S.seqList.find(s => s.split === split && s.seq === seq);
    if (s) s.has_temp = false;
    // Reload from disk to confirm what was written
    const fresh = await fetch(`/api/sequence/${split}/${seq}`).then(r => r.json());
    S.frames = {};
    for (const [k, v] of Object.entries(fresh.frames)) {
      S.frames[parseInt(k)] = v.map(r => ({ ...r }));
    }
    S.selectedBox = null;
    drawCanvas();
    updateFrameLabel();
    renderSeqList();
  } else {
    updateSaveStatus('Error: ' + res.error, 'error');
  }
});

function updateSaveStatus(msg, cls) {
  elSaveStatus.textContent = msg;
  elSaveStatus.className   = cls || '';
  if (msg && cls === 'ok') setTimeout(() => { elSaveStatus.textContent = ''; }, 3000);
}

elBtnRevertSeq.addEventListener('click', async () => {
  if (!S.seqData) return;
  if (!confirm('Revert entire sequence to original coordinates.txt? All unsaved changes will be lost.')) return;
  const { split, seq } = S.seqData;
  await _pushQueue;
  const res = await fetch(`/api/revert_seq/${split}/${seq}`, { method: 'POST' }).then(r => r.json());
  if (res.ok) {
    S.frames = {};
    for (const r of res.rows) {
      const fi = Math.floor(r.t / S.seqData.window_s);
      if (!S.frames[fi]) S.frames[fi] = [];
      S.frames[fi].push({ ...r });
    }
    S.dirty       = false;
    S.selectedBox = null;
    drawCanvas();
    updateFrameLabel();
    updateTimeBar();
    updateSaveStatus('Reverted seq', 'ok');
    const s = S.seqList.find(s => s.split === split && s.seq === seq);
    if (s) s.has_temp = false;
    renderSeqList();
  }
});

// ── Time bar interaction ──────────────────────────────────────────────────────

function seekFromBar(e) {
  if (!S.seqData) return;
  const rect = elTimeBarTrack.getBoundingClientRect();
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  seekToFrame(Math.round(pct * (S.seqData.n_frames - 1)));
}

elTimeBarTrack.addEventListener('mousedown', (e) => {
  seekFromBar(e);
  const onMove = (e) => seekFromBar(e);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', () => window.removeEventListener('mousemove', onMove), { once: true });
});

// ── Help modal ────────────────────────────────────────────────────────────────

const elHelpOverlay = document.getElementById('help-overlay');

function toggleHelp() {
  elHelpOverlay.classList.toggle('visible');
}

elBtnHelp.addEventListener('click', toggleHelp);
document.getElementById('help-close').addEventListener('click', toggleHelp);
elHelpOverlay.addEventListener('click', (e) => {
  if (e.target === elHelpOverlay) toggleHelp();
});

// ── Init ─────────────────────────────────────────────────────────────────────

loadSeqList();
