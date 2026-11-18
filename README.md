# Verdance

A quiet first-person walk through a photoreal-leaning forest valley that runs in the browser. Rolling meadows of tall grass and wildflowers, broadleaf woods with dappled light, a stony creek, limestone ridges, steel lattice relay towers, and a giant sphere hung over a misty chasm. The weather drifts on its own between clear skies, cumulus, overcast, fog, rain and storms.

**Play:** https://brinleyww.github.io/verdance/

Everything is generated when the page loads: terrain, trees, textures and sound. There are no image, model or audio files.

## The loop

Five relay towers across the valley have gone silent. Find each one, walk up to its equipment cabinet and hold **E** to bring it back; its red beacon starts blinking again. Hold **R** to listen to your radio: the static clears into a tone when you face the nearest silent relay. When all five are restored, something wakes over the chasm. Progress is saved in your browser.

There is no timer, no enemies and almost no HUD. Wander as long as you like.

| Key | Action |
| --- | --- |
| W A S D / arrows | walk |
| Shift | run |
| Space | jump |
| E (hold) | restore a relay |
| R (hold) | radio |
| M | field map |
| H | hide the HUD |
| Esc | menu and settings |

Touch devices get an on-screen stick, look-drag and buttons.

## Running smoothly on modest hardware

The renderer picks a quality tier from your GPU (Low / Medium / High / Ultra, changeable in the menu) and then keeps adjusting itself:

- **Amortised volumetric clouds.** Cumulus are raymarched into a sky panorama instead of per screen pixel, and only 1/16 of that panorama is refreshed each frame. Cloud cost no longer depends on screen resolution or on how much sky is visible.
- **Adaptive resolution.** A GPU timer query measures real frame cost; render resolution drops in steps when a frame runs long and climbs back when there is headroom. Detail stays put; only pixel count moves.
- **GPU-driven grass.** Blades are positioned, bent by wind and shaded entirely in the vertex shader from the heightmap. The CPU only picks visible 8 m tiles. Far tiles use rank-ordered subsets of the near patch, so density thins out smoothly instead of popping.
- **Tree LODs and impostors.** Full trees near you, simplified trees further out, then camera-facing impostors baked at load time from the real tree models. Transitions crossfade with a dither, and instance buffers are rebuilt only when the camera has moved.
- **Cascaded shadows on a budget.** Far cascades refresh every 2–4 frames. Near trees are distance-sorted so the near cascades draw only a prefix of them. The far tree LOD never renders into the near cascades, and grass never casts.
- **Geometry-clipmap terrain** with geomorphing: about 200k triangles out to the horizon, with no cracks and no swimming.
- **No readbacks, no stalls:** world generation runs in a Web Worker, every shader is compiled before the first frame, and eye adaptation is driven by canopy density instead of reading pixels back.

## Tech

Plain ES modules and [three.js](https://threejs.org) r170 loaded from a CDN. There is no build step. To run it locally, serve the folder with any static server:

```bash
python -m http.server 8137
```

Then open http://localhost:8137. WebGL 2 is required.

| File | What it does |
| --- | --- |
| `src/worldgen.js` | heightmap, chasm, creek, trails, forest masks, placements (worker) |
| `src/sky.js` | atmosphere, cumulus raymarcher, panorama, sun, sky lighting |
| `src/terrain.js` | clipmap terrain and its procedural ground materials |
| `src/grass.js` | tiled GPU grass and wildflowers |
| `src/trees.js` | procedural trees, LODs, impostor baking |
| `src/props.js` | shrubs, ferns, rocks, fallen logs |
| `src/structures.js` | lattice towers, transmission line, chasm megastructure, bridge |
| `src/weather.js` | time of day, weather states, rain, lightning |
| `src/audio.js` | procedural soundscape (wind, birds, creek, rain, thunder, steps) |
| `src/game.js` | relays, radio, area titles, map, saving |

## License

MIT. three.js is MIT-licensed by its authors.
