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
import math
import shutil
import threading
from pathlib import Path

import cv2
from flask import Flask, jsonify, request, send_file, abort, render_template

# Per-sequence VideoCapture kept open for sequential reads
_caps: dict = {}       # (split, seq) -> {'cap', 'last_fi', 'lock'}

ROOT        = Path(__file__).resolve().parent.parent.parent
DATASET_DIR = ROOT / 'dataset'
VIDEOS_DIR  = ROOT / 'analysis' / 'videos_test_equal_duration_GT'
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


def new_box_t(fi: int) -> float:
    """
    Timestamp for a newly created box in frame fi — strictly inside [fi*W, (fi+1)*W).
    e.g. fi=0 → 0.033000, fi=1 → 0.066000, fi=215 → 7.199000
    """
    t1  = (fi + 1) * WINDOW_S          # exact upper bound of frame
    t   = math.floor(t1 * 1000) / 1000
    if t >= t1 - 1e-9:                 # landed on or past boundary (e.g. fi=215 → 7.200)
        t -= 0.001
    return round(t, 6)


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


def load_temp(split: str, seq: str) -> list[dict]:
    tp = temp_path(split, seq)
    if tp.exists():
        return json.loads(tp.read_text())
    return _parse_orig(orig_path(split, seq))


def save_temp(split: str, seq: str, rows: list[dict]):
    temp_path(split, seq).write_text(json.dumps(rows))


# ── routes ─────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/sequences')
def api_sequences():
    """List all splits + sequence IDs that have a coordinates.txt or events.hdf5."""
    result = []
    for split_dir in sorted(DATASET_DIR.iterdir()):
        if not split_dir.is_dir():
            continue
        split = split_dir.name
        for s in sorted(split_dir.iterdir(), key=lambda p: p.name):
            if not s.is_dir():
                continue
            if not (s / 'events.hdf5').exists() and not (s / 'coordinates.txt').exists():
                continue
            has_video = video_path(split, s.name).exists()
            has_gt    = orig_path(split, s.name).exists()
            has_temp  = temp_path(split, s.name).exists()
            result.append({
                'split':     split,
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


@app.route('/api/gt/<split>/<seq>', methods=['POST'])
def api_gt_update(split, seq):
    """
    Replace all annotations for a given frame index.
    Body: { fi: int, boxes: [{x1,y1,x2,y2,drone_num,drone_name,t?}, ...] }

    Timestamp rules:
    - Existing box (t provided): keep original t unchanged.
    - New box (t null/absent): assign new_box_t(fi).
    """
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)

    body      = request.get_json()
    fi        = int(body['fi'])
    new_boxes = body['boxes']

    rows = load_temp(split, seq)
    # Remove all existing annotations for this frame
    rows = [r for r in rows if frame_index(r['t']) != fi]

    # Add incoming boxes
    t_new = new_box_t(fi)
    for b in new_boxes:
        t = b.get('t')
        rows.append({
            't':          float(t) if t is not None else t_new,
            'x1':         float(b['x1']),
            'y1':         float(b['y1']),
            'x2':         float(b['x2']),
            'y2':         float(b['y2']),
            'drone_num':  int(b['drone_num']),
            'drone_name': str(b['drone_name']),
        })

    rows.sort(key=lambda r: r['t'])
    save_temp(split, seq, rows)
    return jsonify({'ok': True, 'n_annotations': len(rows)})


@app.route('/api/revert_frame/<split>/<seq>/<int:fi>', methods=['POST'])
def api_revert_frame(split, seq, fi):
    """Revert a single frame's annotations to the original .bak / coordinates.txt."""
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)

    bak  = bak_path(split, seq)
    orig = orig_path(split, seq)
    source    = bak if bak.exists() else orig
    orig_rows = _parse_orig(source)

    current_rows = load_temp(split, seq)
    current_rows = [r for r in current_rows if frame_index(r['t']) != fi]
    for r in orig_rows:
        if frame_index(r['t']) == fi:
            current_rows.append(r)

    current_rows.sort(key=lambda r: r['t'])
    save_temp(split, seq, current_rows)
    return jsonify({'ok': True})


@app.route('/api/save/<split>/<seq>', methods=['POST'])
def api_save(split, seq):
    """Commit temp JSON → coordinates.txt (creates .bak first)."""
    d = seq_dir(split, seq)
    if not d.exists():
        abort(404)

    orig = orig_path(split, seq)
    bak  = bak_path(split, seq)
    tp   = temp_path(split, seq)

    if not tp.exists():
        return jsonify({'ok': False, 'error': 'No unsaved changes'})

    # Create backup once
    if orig.exists() and not bak.exists():
        shutil.copy2(orig, bak)

    rows = json.loads(tp.read_text())
    _write_orig(orig, rows)
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
