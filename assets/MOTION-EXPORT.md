# Tildone motion — export to MP4 / GIF / Lottie

The looping marks live in `Tildone Logo.dc.html` (2a, 2c, 3a–3d) and as standalone,
self-contained files in `assets/`:

- `tildone-mark-animated.svg` / `-white.svg` — the wave-to-check mark
- `tildone-icon-animated.svg` — animated app icon
- `tildone-wordmark-animated.svg` — the tilde-dot wordmark

These SVGs loop forever anywhere you use them as `<img src>` or a CSS background — no
build step. Use the steps below only when a partner needs a real video/GIF/Lottie file.

---

## 1 · MP4  (best quality, smallest file)

Render exact frames with headless Chrome, then mux with ffmpeg.

```bash
npm i puppeteer   # ffmpeg must be on PATH
```

**capture.js**
```js
const puppeteer = require('puppeteer');
const fs = require('fs');
(async () => {
  fs.mkdirSync('f', { recursive: true });
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400, deviceScaleFactor: 3 });
  // frame.html = a bare page that embeds ONE animated SVG, centered, at your size
  await page.goto('file://' + process.cwd() + '/frame.html');
  const fps = 30, seconds = 2.8;                 // match the SVG's loop length
  const frames = Math.round(fps * seconds);
  for (let i = 0; i < frames; i++) {
    const t = (i / fps) * 1000;                  // ms
    await page.evaluate(ms => {
      document.getAnimations().forEach(a => { a.currentTime = ms; a.pause(); });
    }, t);
    await page.screenshot({ path: `f/${String(i).padStart(3,'0')}.png`, omitBackground: true });
  }
  await browser.close();
})();
```

**mux**
```bash
ffmpeg -framerate 30 -i f/%03d.png -c:v libx264 -pix_fmt yuv420p -crf 18 tildone.mp4
```
Loop length per mark: 2a / 2c = 2.8s · 3a = 5.6s · 3b = 6s · 3c = 7s · 3d = 7.5s.

---

## 2 · GIF  (universal, larger, 256-color)

Reuse the `f/` frames from step 1:
```bash
ffmpeg -framerate 30 -i f/%03d.png \
  -vf "split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse" \
  -gifflags +transdiff tildone.gif
```

---

## 3 · Lottie  (tiny, scriptable — web / React Native)

These marks are CSS/SMIL, not After Effects, so there's no automatic converter. Two routes:

1. **AE + Bodymovin** — rebuild the mark in After Effects, export JSON with the
   LottieFiles / Bodymovin plugin, play with `lottie-web` or `lottie-react`.
2. **Hand-authored trim-path** — the wave-to-check (2a) is a single stroked path, which
   maps cleanly to a Lottie `trim path` (start/end) keyframe. This one I can generate
   for you as ready-to-play `tildone-mark.lottie.json` — just ask.

---

## Fastest, no tools

Open any `assets/*-animated.svg` in a browser at 2×–3× zoom and screen-record a couple of
loops; trim to one cycle. Good enough for Slack, decks, and quick shares.
