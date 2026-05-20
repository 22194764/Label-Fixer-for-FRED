# Label Fixer

A lightweight browser-based tool for reviewing and correcting bounding-box annotations on event camera data, frame by frame.

---

## Motivation

Event camera datasets often contain annotation artefacts: missed frames, misaligned boxes, duplicate labels, or wrong drone IDs introduced during automated labelling pipelines. Fixing these in a raw text file is error-prone and slow.

Label Fixer provides a minimal GUI that renders each 1/30 s event frame as an image (ON events white, OFF events black, background grey), overlays the existing ground-truth bounding boxes, and lets you add, move, resize, delete, or copy boxes with the mouse — then commit the result back to the original `coordinates.txt` format. A non-destructive temp file is kept until you explicitly save, so you can always revert individual frames or reload from disk.

---

## Credits

Built to support annotation correction on the **FRED** (Fast-moving object Recognition using Event-based Detection) dataset.

> Cannici, M., Pinchetti, L., Cacciabaudo, S., & Matteucci, M. (2024).  
> *FRED: A Framework for Drone Detection using Event Cameras.*  
> [https://github.com/miccunifi/FRED](https://github.com/miccunifi/FRED)

---

## Installation

Python 3.10+ is required. Install dependencies with:

```bash
pip install -r requirements.txt
```

Dependencies (`requirements.txt`):
```
flask>=3.0
opencv-python>=4.8
numpy>=1.24
```

---

## Configuration

Before running, open `server.py` and set the two path constants near the top to match your dataset layout:

```python
VIDEOS_DIR = ROOT / 'analysis' / 'videos_test_equal_duration_GT'
SPLIT      = 'test_equal_duration'
```

| Constant | What it points to |
|---|---|
| `VIDEOS_DIR` | Folder containing pre-rendered MP4s named `{split}_{seq}_GT.mp4` |
| `SPLIT` | Name of the dataset split folder under `dataset/` to load sequences from |

`ROOT` is resolved automatically as three directories above `server.py`.  
Expected dataset layout:

```
<ROOT>/
├── dataset/
│   └── <SPLIT>/
│       ├── 34/
│       │   ├── events.hdf5
│       │   └── coordinates.txt
│       └── ...
└── analysis/
    └── <VIDEOS_DIR_NAME>/
        ├── test_equal_duration_34_GT.mp4
        └── ...
```

Videos are optional — sequences without a matching MP4 show a grey canvas but are still fully editable.

To render videos from your event data, use the companion script:

```bash
python analysis/render_video_with_GT.py
# or for a single sequence:
python analysis/render_video_with_GT.py --seq 34
```

---

## Running the server

```bash
cd tools/label_fixer
python server.py
```

Then open [http://localhost:5000](http://localhost:5000) in your browser.

---

## Using the app

### Sidebar

The left panel lists every sequence in the configured split. Badges indicate:
- **no video** — no MP4 found; annotations still editable
- **unsaved** — unsaved changes exist in the temp file

Click any sequence to open it.

### Navigation

| Action | Control |
|---|---|
| Next / previous frame | `→` / `←` arrow keys, or the `→` `←` buttons |
| Jump to any time | Click or drag the time bar at the bottom |
| Play / pause | `Space` or the `▶` button |
| Playback speed | `2x` / `4x` buttons (toggle; click again to return to 1×) |

### Drawing boxes

1. Click a drone name in the **Active drone** bar to select it (highlighted border).
2. Click and drag on the canvas to draw a bounding box.
3. Click a box to select it; drag its corners to resize or drag its interior to move.
4. Press `Esc` to deselect the active drone / selected box.
5. Press `Delete` or `Backspace` to delete the selected box.

### Memorise mode

Memorise mode lets you quickly stamp a box onto frames where the drone is present but unannotated, using the size of the most recent annotated box as a template.

1. Select the active drone.
2. Press `M` (or click the **Memorise** button) to toggle memorise mode on — the button highlights.
3. Click anywhere on the canvas. A box of the same size as the largest box in the **last frame that has any annotation** is centred on your click point.
4. Press `M` again to turn memorise mode off.

This is particularly useful for filling gaps when a drone is continuously visible but annotations are missing for a run of frames.

### Frame operations

| Button | Action |
|---|---|
| **Erase** | Remove all boxes from the current frame |
| **Revert frame** | Reset the current frame to the original `coordinates.txt` (or `.bak` if it exists) |
| **Reload** | Reload all annotations from the temp file on disk |
| **Save** | Commit all changes to `coordinates.txt` (a `.bak` backup is created on first save) |

Changes are pushed to a `coordinates_temp.json` file per sequence as you edit. Nothing is written to `coordinates.txt` until you click **Save**.

---

## File format

Annotations are stored in `coordinates.txt`, one line per annotation:

```
<timestamp_s>: <x1>, <y1>, <x2>, <y2>, <drone_num>, <drone_name>
```

Example:
```
0.033000: 120.0, 45.0, 198.0, 112.0, 1, DJI Mini 2
```

Coordinates are in pixels relative to the sensor resolution. Timestamps correspond to the midpoint sampling within each 1/30 s window.
