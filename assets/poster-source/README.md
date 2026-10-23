# Poster Source

`generate_posters.py` deterministically renders:

- `assets/poster-horizontal.png` — 1280×640 GitHub Social Preview and README banner.
- `assets/poster-vertical.png` — 1080×1440 vertical sharing poster.

The compositor uses the local product screenshot at `assets/guardian-ui.png`, dark HUD grid/glow layers, and exact text rendered with system fonts. This avoids generated text errors.

Run:

```bash
python3 assets/poster-source/generate_posters.py
```

Required local fonts:

- `/System/Library/Fonts/Avenir Next.ttc`
- `/System/Library/Fonts/Hiragino Sans GB.ttc`

No API key or image-generation service is required.
