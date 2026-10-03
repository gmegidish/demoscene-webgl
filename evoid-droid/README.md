# Evoid Droid — Excess & Portal Process (2007)

A browser port of *Evoid Droid*, an Xbox 360 demo released as an XNA Creators Club package (`.ccgame`).

On Pouët: [Evoid Droid](https://www.pouet.net/prod.php?which=31587) by [Excess](https://www.pouet.net/groups.php?which=1360) & [Portal Process](https://www.pouet.net/groups.php?which=3466)

**Credits**
- [gloom](https://www.pouet.net/user.php?who=1265): graphics, music
- [svok](https://www.pouet.net/user.php?who=998): code
- In-demo credits: graphics by am and snarling · music by gloom and flipside · code by kmk, krav and svok

All visuals, models and music belong to their authors; this folder only re-hosts them in browser-friendly formats.

## Run

```bash
# from the repo root
python3 -m http.server 8000
# open http://localhost:8000/evoid-droid/web/
```

Controls: click to start · Space pause · ←/→ seek 5 s · H shows time · `#t=42` starts at 42 s.

## How it was ported

1. The `.ccgame` is a Microsoft Cabinet archive; its `XCabInfo.resources` manifest maps numbered files to real names.
2. `Demo360.exe` was decompiled with ILSpy. The timeline, scenes, physics (boids, SPH, water) and seeded `System.Random` geometry are ported 1:1 to JavaScript.
3. Assets were converted from big-endian Xbox 360 XNB with the scripts in `tools/`:
   - `xnb_textures.py` — Color / DXT / cube textures → PNG
   - `xnb_models.py` — XNA 1.x models + SkinnedModel animation → JSON + BIN
   - `xnb_fonts.py` — SpriteFont glyph metrics → JSON
   - music: XMA2 wave bank decoded with vgmstream → MP3
4. Shaders are the one part that is reconstructed, not ported: the originals are compiled Xbox 360 microcode, so each is rewritten in GLSL from its parameter names, default values and C# usage.

## Layout

```
web/       index.html + src/ (engine, timeline, effects/*)
assets/    converted textures, models, fonts, audio
tools/     the XNB converters
```
