"""
server.py — Label Fixer Flask backend
======================================
Serves sequences, GT annotations, and videos for the label fixer GUI.

Usage
-----
    cd tools/label_fixer
    pip install flask
    python server.py
    # Open http://localhost:5000
"""

import io
import json
import shutil
import threading
from pathlib import Path

import cv2
from flask import Flask, jsonify, request, send_file, abort, render_template

# Per-sequence VideoCapture kept open for sequential reads
_caps: dict = {}       # (split, seq) -> {'cap', 'last_fi', 'lock'}

ROOT        = Path(__file__).resolve().parent.parent.parent
# ROOT        = Path(__file__).resolve()
DATASET_DIR = ROOT / 'dataset'
# DATASET_DIR = ROOT / 'samples'
VIDEOS_DIR  = ROOT / 'analysis' / 'videos_test_equal_duration_GT'
# VIDEOS_DIR  = ROOT / 'samples' / 'videos_test_equal_duration_GT'
SPLIT       = 'test_equal_duration'
WINDOW_S    = 1.0 / 30.0

DRONE_NAMES = [
    'DJI Mini 2',
    'DJI Mini 3',
    'DJI Tello EDU',
    'DarwinFPV cineape20',
    'Betafpv air75',
]

app = Flask(__name__)


# ── helpers ────────────────────────────────────────────────────────────────────

def seq_dir(split: str, seq: str) -> Path:
    return DATASET_DIR / split / seq


def temp_path(split: str, seq: str) -> Path:
    return seq_dir(split, seq) / 'coordinates_temp.json'


def orig_path(split: str, seq: str) -> Path:
    return seq_dir(split, seq) / 'coordinates.txt'


def bak_path(split: str, seq: str) -> Path:
    return seq_dir(split, seq) / 'coordinates.txt.bak'


def video_path(split: str, seq: str) -> Path:
    return VIDEOS_DIR / f'{split}_{seq}_GT.mp4'


def _read_frame(split: str, seq: str, fi: int):
    """Read a single frame, keeping the VideoCapture open for sequential access."""
    key = (split, seq)
    if key not in _caps:
        _caps[key] = {'cap': cv2.VideoCapture(str(video_path(split, seq))),
                      'last_fi': -1,
                      'lock': threading.Lock()}
    entry = _caps[key]
    with entry['lock']:
        cap = entry['cap']
        if not cap.isOpened():
            cap = cv2.VideoCapture(str(video_path(split, seq)))
            entry['cap'] = cap
            entry['last_fi'] = -1
        if entry['last_fi'] + 1 != fi:
            cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
        ret, frame = cap.read()
        if ret:
            entry['last_fi'] = fi
        return ret, frame


def frame_index(t: float) -> int:
    """Return 0-based frame index for a timestamp (t0_seq is always 0)."""
    return int(t / WINDOW_S)

def _parse_orig(path: Path) -> list[dict]:
    """Parse coordinates.txt into list of annotation dicts."""
    rows = []
    if not path.exists():
        return rows
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            time_part, rest = line.split(':', 1)
            parts = [p.strip() for p in rest.split(',')]
            rows.append({
                't':          float(time_part),
                'x1':         float(parts[0]),
                'y1':         float(parts[1]),
                'x2':         float(parts[2]),
                'y2':         float(parts[3]),
                'drone_num':  int(parts[4]),
                'drone_name': parts[5].strip() if len(parts) > 5 else '',
            })
    rows.sort(key=lambda r: r['t'])
    return rows


def _write_orig(path: Path, rows: list[dict]):
    """Write annotation list back to coordinates.txt format."""
    rows_s = sorted(rows, key=lambda r: r['t'])
    with path.open('w') as f:
        for r in rows_s:
            f.write(
                f"{r['t']:.6f}: {r['x1']}, {r['y1']}, {r['x2']}, {r['y2']}, "
                f"{r['drone_num']}, {r['drone_name']}\n"
            )


def _coerce_rows(raw: list) -> list[dict]:
    """Validate and coerce a list of row dicts from the frontend."""
    rows = []
    for b in raw:
        rows.append({
            't':          float(b['t']),
            'x1':         float(b['x1']),
            'y1':         float(b['y1']),
            'x2':         float(b['x2']),
            'y2':         float(b['y2']),
            'drone_num':  int(b['drone_num']),
            'drone_name': str(b['drone_name']),
        })
    rows.sort(key=lambda r: r['t'])
    return rows


def load_temp(split: str, seq: str) -> list[dict]:
    tp = temp_path(split, seq)
    if tp.exists():
        return json.loads(tp.read_text())
    return _parse_orig(orig_path(split, seq))


def save_temp(split: str, seq: str, rows: list[dict]):
    temp_path(split, seq).write_text(json.dumps(rows))


# ── routes ─────────────────────────────────────────────────────────────────────

@app.route('/api/gt/<split>/<seq>', methods=['POST'])
def api_gt_update(split, seq):
    """Replace all annotations for a given frame. Called on every edit."""
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)
    body  = request.get_json()
    fi    = int(body['fi'])
    rows  = load_temp(split, seq)
    rows  = [r for r in rows if frame_index(r['t']) != fi]
    rows.extend(_coerce_rows(body.get('boxes', [])))
    rows.sort(key=lambda r: r['t'])
    save_temp(split, seq, rows)
    return jsonify({'ok': True})

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/sequences')
def api_sequences():
    """List sequence IDs from the configured SPLIT folder."""
    result = []
    split_dir = DATASET_DIR / SPLIT
    if not split_dir.is_dir():
        return jsonify(result)
    for s in sorted(split_dir.iterdir(), key=lambda p: p.name):
        if not s.is_dir():
            continue
        if not (s / 'events.hdf5').exists() and not (s / 'coordinates.txt').exists():
            continue
        has_video = video_path(SPLIT, s.name).exists()
        has_gt    = orig_path(SPLIT, s.name).exists()
        has_temp  = temp_path(SPLIT, s.name).exists()
        result.append({
            'split':     SPLIT,
            'seq':       s.name,
            'has_video': has_video,
            'has_gt':    has_gt,
            'has_temp':  has_temp,
        })
    return jsonify(result)


@app.route('/api/sequence/<split>/<seq>')
def api_sequence(split, seq):
    """Return sequence metadata + all annotations grouped by frame."""
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)

    rows = load_temp(split, seq)

    # Derive frame count from annotations (authoritative).
    # Do NOT use CAP_PROP_FRAME_COUNT — OpenCV duplicates the last frame on
    # release, giving one phantom extra frame with no annotations.
    n_frames = 0
    if rows:
        last_t = max(r['t'] for r in rows)
        n_frames = frame_index(last_t) + 1

    # Group annotations by frame index
    frames: dict[int, list] = {}
    for r in rows:
        fi = frame_index(r['t'])
        frames.setdefault(fi, []).append(r)

    return jsonify({
        'split':       split,
        'seq':         seq,
        'window_s':    WINDOW_S,
        'n_frames':    n_frames,
        'drone_names': DRONE_NAMES,
        'frames':      {str(k): v for k, v in frames.items()},
        'has_temp':    temp_path(split, seq).exists(),
    })




@app.route('/api/revert_frame/<split>/<seq>/<int:fi>', methods=['POST'])
def api_revert_frame(split, seq, fi):
    """Return the original annotations for a single frame (does not write anything)."""
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)

    bak    = bak_path(split, seq)
    orig   = orig_path(split, seq)
    source = bak if bak.exists() else orig
    rows   = [r for r in _parse_orig(source) if frame_index(r['t']) == fi]
    return jsonify({'ok': True, 'rows': rows})


@app.route('/api/revert_seq/<split>/<seq>', methods=['POST'])
def api_revert_seq(split, seq):
    """Delete temp file, restore coordinates.txt from .bak (if it exists), return fresh rows."""
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)

    tp   = temp_path(split, seq)
    orig = orig_path(split, seq)
    bak  = bak_path(split, seq)

    if tp.exists():
        tp.unlink()

    if bak.exists():
        shutil.copy2(bak, orig)

    rows = _parse_orig(orig)
    return jsonify({'ok': True, 'n_annotations': len(rows),
                    'rows': rows})


@app.route('/api/autosave/<split>/<seq>', methods=['POST'])
def api_autosave(split, seq):
    """Write rows to temp file (crash recovery, called via sendBeacon on page unload)."""
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    rows = _coerce_rows(body.get('rows', []))
    save_temp(split, seq, rows)
    return jsonify({'ok': True})


@app.route('/api/save/<split>/<seq>', methods=['POST'])
def api_save(split, seq):
    """Write rows directly to coordinates.txt (creates .bak on first save)."""
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)

    body = request.get_json(force=True, silent=True) or {}
    rows = _coerce_rows(body.get('rows', []))

    orig = orig_path(split, seq)
    bak  = bak_path(split, seq)
    tp   = temp_path(split, seq)

    if orig.exists() and not bak.exists():
        shutil.copy2(orig, bak)

    _write_orig(orig, rows)

    if tp.exists():
        tp.unlink()

    return jsonify({'ok': True, 'n_annotations': len(rows)})


@app.route('/frame/<split>/<seq>/<int:fi>')
def serve_frame(split, seq, fi):
    """Return a single video frame as JPEG."""
    if not video_path(split, seq).exists():
        abort(404)
    ret, frame = _read_frame(split, seq, fi)
    if not ret:
        abort(404)
    _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return send_file(io.BytesIO(buf.tobytes()), mimetype='image/jpeg')


if __name__ == '__main__':
    app.run(debug=True, port=5000, threaded=True)
