"""
render_video_with_GT.py — Render event frames with GT bounding boxes as MP4
===========================================================================
Accumulates events into 1/30 s frames, overlays GT bounding boxes, and
writes an MP4 video for visual inspection of GT annotations.

Usage
-----
    python render_video_with_GT.py --dataset /path/to/dataset
    python render_video_with_GT.py --dataset /path/to/dataset --split test_equal_duration --seq 34
    python render_video_with_GT.py --dataset /path/to/dataset --out-dir /path/to/videos
"""

import argparse
import sys
import numpy as np
import h5py
import cv2
from pathlib import Path

_SCRIPT_DIR  = Path(__file__).resolve().parent

WINDOW_S = 1 / 30   # frame duration (s)


# ── GT loading ────────────────────────────────────────────────────────────────

def load_gt(coord_file):
    gt = []
    path = Path(coord_file)
    if not path.exists():
        return gt
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            time_part, rest = line.split(':', 1)
            parts = [p.strip() for p in rest.split(',')]
            x1, y1, x2, y2 = float(parts[0]), float(parts[1]), float(parts[2]), float(parts[3])
            drone_name = parts[5].strip() if len(parts) > 5 else ''
            gt.append({
                't': float(time_part),
                'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2,
                'drone_name': drone_name,
            })
    gt.sort(key=lambda g: g['t'])
    return gt


def gt_in_frame(gt_list, t0, t1):
    return [g for g in gt_list if t0 <= g['t'] < t1]


# ── Event loading ─────────────────────────────────────────────────────────────

def _detect_scale(t0_raw, t1_raw):
    span = t1_raw - t0_raw
    for scale in (1.0, 1e-3, 1e-6, 1e-9):
        if 2.0 <= span * scale <= 1200.0:
            return scale
    return 1e-6


def load_events(events_file):
    with h5py.File(events_file, 'r') as hf:
        ev    = hf['CD']['events'][()]
    x     = ev['x'].astype(np.int32)
    y     = ev['y'].astype(np.int32)
    t_raw = ev['t'].astype(np.int64)
    p     = ev['p'].astype(np.int8)
    scale = _detect_scale(int(t_raw[0]), int(t_raw[-1]))
    t_sec = (t_raw - t_raw[0]).astype(np.float64) * scale
    return x, y, t_sec, p


# ── Frame rendering ───────────────────────────────────────────────────────────

# Distinct colours for up to 8 drone labels
_COLOURS = [
    (0,   255,   0),   # green
    (0,   200, 255),   # cyan
    (255, 100,   0),   # orange
    (255,   0, 200),   # magenta
    (255, 255,   0),   # yellow
    (0,   100, 255),   # blue
    (180,   0, 255),   # purple
    (255,   0,   0),   # red
]
_label_colour_map = {}

def _colour_for(label):
    if label not in _label_colour_map:
        _label_colour_map[label] = _COLOURS[len(_label_colour_map) % len(_COLOURS)]
    return _label_colour_map[label]


def render_frame(xs, ys, ps, sensor_h, sensor_w, gt_boxes, fi, t0, t1):
    """
    Returns a BGR uint8 image (sensor_h × sensor_w × 3).
    ON events → white, OFF events → black, background → gray.
    GT boxes drawn in colour with label.
    """
    img = np.full((sensor_h, sensor_w, 3), 128, dtype=np.uint8)

    if len(xs) > 0:
        on_mask  = ps > 0
        off_mask = ~on_mask
        img[ys[on_mask],  xs[on_mask]]  = (255, 255, 255)
        img[ys[off_mask], xs[off_mask]] = (0,   0,   0)

    for g in gt_boxes:
        x1 = max(0, int(round(g['x1'])))
        y1 = max(0, int(round(g['y1'])))
        x2 = min(sensor_w - 1, int(round(g['x2'])))
        y2 = min(sensor_h - 1, int(round(g['y2'])))
        colour = _colour_for(g['drone_name'])
        cv2.rectangle(img, (x1, y1), (x2, y2), colour, 2)
        label = g['drone_name'] if g['drone_name'] else 'drone'
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        ty = max(y1 - 4, th + 2)
        cv2.rectangle(img, (x1, ty - th - 2), (x1 + tw + 2, ty + 2), colour, -1)
        cv2.putText(img, label, (x1 + 1, ty), cv2.FONT_HERSHEY_SIMPLEX,
                    0.45, (0, 0, 0), 1, cv2.LINE_AA)

    # Legend (top-right): one coloured swatch per known drone label
    if _label_colour_map:
        line_h = 18
        pad    = 6
        for li, (lbl, col) in enumerate(_label_colour_map.items()):
            ty = pad + li * line_h
            cv2.rectangle(img, (sensor_w - 140, ty), (sensor_w - 124, ty + 12), col, -1)
            cv2.putText(img, lbl, (sensor_w - 120, ty + 11),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, col, 1, cv2.LINE_AA)

    # Frame info overlay (bottom-left)
    info = f'frame {fi:05d}  t=[{t0:.3f}, {t1:.3f}]s  GT={len(gt_boxes)}'
    cv2.putText(img, info, (6, sensor_h - 8), cv2.FONT_HERSHEY_SIMPLEX,
                0.4, (200, 200, 200), 1, cv2.LINE_AA)

    return img


# ── Main ──────────────────────────────────────────────────────────────────────

def render_sequence(seq_dir, split, fps, out_path):
    """Render one sequence to MP4. Returns True on success."""
    seq_id      = seq_dir.name
    events_file = seq_dir / 'events.hdf5'
    coord_file  = seq_dir / 'coordinates.txt'

    if not events_file.exists():
        print(f'  SKIP: events.hdf5 not found')
        return False

    print(f'Loading events ...', flush=True)
    x, y, t_sec, p = load_events(events_file)
    print(f'  {len(t_sec):,} events  |  duration {t_sec[-1]:.1f} s')

    sensor_h = int(y.max()) + 1
    sensor_w = int(x.max()) + 1
    print(f'  Sensor : {sensor_h} × {sensor_w}')

    gt_list = load_gt(coord_file)
    print(f'  GT     : {len(gt_list)} annotations')
    if gt_list:
        drones = sorted(set(g['drone_name'] for g in gt_list))
        print(f'  Drones : {drones}')

    t0_seq   = float(t_sec[0])
    t1_seq   = float(t_sec[-1])
    n_frames = int(np.ceil((t1_seq - t0_seq) / WINDOW_S))
    print(f'  Frames : {n_frames} @ {fps} fps')
    print(f'  Output : {out_path}')

    order = np.argsort(t_sec, kind='stable')
    x_s = x[order]; y_s = y[order]
    t_s = t_sec[order]; p_s = p[order]

    # Reset colour map per sequence so colours are consistent
    _label_colour_map.clear()

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(str(out_path), fourcc, fps, (sensor_w, sensor_h))
    if not writer.isOpened():
        print('  ERROR: could not open VideoWriter.')
        return False

    for fi in range(n_frames):
        t0 = t0_seq + fi * WINDOW_S
        t1 = t0 + WINDOW_S
        lo = int(np.searchsorted(t_s, t0, side='left'))
        hi = int(np.searchsorted(t_s, t1, side='left'))

        gt_boxes = gt_in_frame(gt_list, t0, t1)
        img = render_frame(x_s[lo:hi], y_s[lo:hi], p_s[lo:hi],
                           sensor_h, sensor_w, gt_boxes, fi, t0, t1)
        writer.write(img)

        if fi % 150 == 0:
            print(f'  [{100*fi/n_frames:5.1f}%] frame {fi}/{n_frames}', flush=True)

    writer.release()
    return True


def main():
    parser = argparse.ArgumentParser(description='Render event videos with GT boxes')
    parser.add_argument('--dataset', required=True,
                        help='Path to dataset root (directory that contains split sub-folders)')
    parser.add_argument('--seq',   default=None,
                        help='Single sequence ID (e.g. 65). Omit to render all sequences.')
    parser.add_argument('--split', default='test_equal_duration',
                        help='Dataset split sub-folder name (default: test_equal_duration)')
    parser.add_argument('--out-dir', default=None,
                        help='Output directory for rendered MP4s '
                             '(default: videos_<split>_GT/ next to this script)')
    parser.add_argument('--fps',   type=float, default=30.0, help='Output video FPS (default: 30)')
    parser.add_argument('--out',   default=None,
                        help='Output MP4 path (single-seq mode only)')
    args = parser.parse_args()

    dataset_root = Path(args.dataset).resolve()
    out_dir      = Path(args.out_dir).resolve() if args.out_dir \
                   else _SCRIPT_DIR / f'videos_{args.split}_GT'
    split_dir    = dataset_root / args.split

    if not split_dir.exists():
        print(f'ERROR: split directory not found: {split_dir}')
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)

    if args.seq:
        sequences = [split_dir / args.seq]
    else:
        sequences = sorted(p for p in split_dir.iterdir()
                           if p.is_dir() and (p / 'events.hdf5').exists())

    print(f'Split     : {args.split}')
    print(f'Sequences : {len(sequences)}')
    print(f'Output dir: {out_dir}\n')

    failed = []
    for i, seq_dir in enumerate(sequences, 1):
        seq_id   = seq_dir.name
        out_path = (Path(args.out) if (args.out and args.seq)
                    else out_dir / f'{args.split}_{seq_id}_GT.mp4')

        # Skip if video already exists
        if out_path.exists():
            print(f'[{i}/{len(sequences)}] {seq_id} — already exists, skipping.')
            continue

        print(f'[{i}/{len(sequences)}] {args.split}/{seq_id}')
        try:
            ok = render_sequence(seq_dir, args.split, args.fps, out_path)
            if ok:
                print(f'  Done.\n')
            else:
                failed.append(seq_id)
                print()
        except Exception as e:
            print(f'  FAILED: {e}\n')
            failed.append(seq_id)

    print('=' * 50)
    print(f'Done. {len(sequences) - len(failed)}/{len(sequences)} sequences rendered.')
    if failed:
        print(f'Failed: {", ".join(failed)}')


if __name__ == '__main__':
    main()
