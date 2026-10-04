# Evoid Droid — WebGL

**▶ [Watch it in your browser](https://gmegidish.github.io/evoid-droid-webgl/)** · press **F** for fullscreen

*Evoid Droid* by [Excess](https://www.pouet.net/groups.php?which=1360) & [Portal Process](https://www.pouet.net/groups.php?which=3466) took **4th place in the combined demo competition at Assembly 2007**. It ran on the Xbox 360 as an XNA Creators Club game. This is a port to the browser with Three.js, rebuilt from the original binary: same timeline, same music, same random seeds.

[Evoid Droid on Pouët](https://www.pouet.net/prod.php?which=31587)

| | |
|---|---|
| ![Intro: growing splines and the Evoid Droid logo](docs/screenshots/01-intro.jpg) | ![Claws: the machine, with credits](docs/screenshots/02-claws.jpg) |
| ![Tunnel: 640 deferred lights falling down a shaft](docs/screenshots/03-tunnel.jpg) | ![Waves: water simulation with a spiked ball](docs/screenshots/04-waves.jpg) |
| ![Scroller: parallax landscape with greetings](docs/screenshots/05-scroller.jpg) | ![Bee box: bees over a field of cubes](docs/screenshots/06-beebox.jpg) |
| ![Robot: running through the tunnel](docs/screenshots/07-robot.jpg) | ![Metal: liquid boids around the ExP logo](docs/screenshots/08-metal.jpg) |
| ![Liquid: SPH fluid inside a glass ball](docs/screenshots/09-liquid.jpg) | ![End picture](docs/screenshots/10-end.jpg) |

## Controls

| Key | Action |
|---|---|
| Click | Start |
| **F** | Toggle fullscreen |
| Space | Pause / resume |
| ← / → | Seek 5 s |
| H | Show time |

Add `#t=42` to the URL to start at 42 s.

## Credits

- [gloom](https://www.pouet.net/user.php?who=1265): graphics, music
- [svok](https://www.pouet.net/user.php?who=998): code
- In-demo credits: graphics by am and snarling · music by gloom and flipside · code by kmk, krav and svok

All visuals, models and music belong to their authors. This repository only re-hosts them in browser-friendly formats.

## How it was ported

1. The `.ccgame` package is a Microsoft Cabinet archive. Its `XCabInfo.resources` manifest maps numbered files to real names.
2. `Demo360.exe` was decompiled with ILSpy. The timeline, cameras, scenes, physics (boids, SPH, water) and seeded `System.Random` geometry were ported to JavaScript by hand from the C#.
3. Assets were converted from big-endian Xbox 360 XNB with the scripts in `tools/`:
   - `xnb_textures.py`: Color / DXT / cube textures → PNG
   - `xnb_models.py`: XNA 1.x models + SkinnedModel animation → JSON + BIN
   - `xnb_fonts.py`: SpriteFont glyph metrics → JSON
   - music: XMA2 wave bank decoded with vgmstream → MP3
4. Shaders are reconstructed, not ported. The originals are compiled Xbox 360 microcode, so each one was rewritten in GLSL from its parameter names, default values and C# usage.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000/
```

## Layout

```
index.html   the demo page
src/         engine, timeline, effects/*
assets/      converted textures, models, fonts, audio
tools/       the XNB converters
docs/        screenshots
```
