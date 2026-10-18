# mars-surface

A real-time Mars surface on WebGPU, with a six-wheel rover you can drive. No engine or rendering library.

It is built on [moon-surface](https://github.com/TarasShyn/moon-surface), which itself exists because of [web-ocean](https://github.com/Noniv/web-ocean) by Maksymilian Dendura ([@Noniv](https://github.com/Noniv)). The terrain mesh, camera-centred clipmaps, bloom and AgX tone mapping all come from that line of work. The bloom and tone mapping code in `js/wgsl/post.js` is his, used under the MIT license.

## Run it

```
npm start        # http://localhost:8091/
npm run build    # mars.html, one self-contained page that also opens from file://
```

Needs a recent Chrome with WebGPU.

## Controls

| Input | Action |
|---|---|
| Click | Capture the mouse (Esc releases). Right-drag also looks around. |
| W A S D | Drive the rover, or fly |
| Space or E / Q or C | Up / down while flying |
| Shift | Faster |
| Wheel | Flying speed, or chase-camera distance |
| G | Switch between driving the rover (the default) and flying |
| Z | Zoom to 6 degrees |
| H | Settings: sun, exposure, dust, haze, ice clouds, sky time lapse, albedo, stars, shadow steps, resolution |

URL parameters: `cam=x,altitude,z,yawDeg,pitchDeg`, `rover=0` to start flying, `fov=deg`, `scale=0.5`, `ui=0`, and any settings key, for example `sunElev=4&dust=1.5`.

## How it works

**Terrain.** Six tileable 1024x1024 layers, 131 km down to 3.3 m, generated on the GPU at start-up. The largest holds an 80 km eroded crater with a 4.5 km layered mound, terraced and cut by gullies, in the spirit of Gale crater and Mount Sharp. Smaller layers add flat-topped mesas, dune fields with gentle stoss slopes and steep lee faces, megaripples and sand ripples, cracked mudstone plates, terraced bedrock outcrops, eroded craters, and wind-faceted rocks from metres down to pebbles. Steep faces get bands of layered sediment.

**Sky.** Mars dust scatters strongly forward and absorbs blue, so the sky comes out butterscotch with a bluish halo around the sun. The sky is single scattering in a plane-parallel dust layer, with an analytic path integral, a little CO2 Rayleigh, and a rough multiple-scattering term. The same function lights everything else. A small compute pass integrates it into ambient light for each axis, so shadows are lit by the sky instead of going black. It also colours the haze that fades distant terrain into the horizon. Thin water-ice clouds drift overhead. At night the stars turn, Phobos crosses west to east, Deimos drifts the other way, and the Earth shows as a blue evening star near the sun.

**Shadows.** Shadows use the same scheme as the Moon. Long-range horizons come from camera-centred world-space clipmaps, rebuilt a few rows per frame, and each pixel marches only the short range. The surface curves at the Mars radius of 3389.5 km.

**Rover.** The rover is about Curiosity's size and is built from instanced boxes and cylinders: chassis, RTG with fins, mast and camera head, high-gain antenna, stowed arm, and six wheels with chevron grousers. It rides on a rocker-bogie. Each bogie averages its two wheels, each rocker links the bogie to the front wheel, and the differential sets body pitch to the mean rocker angle and roll from the two sides. The GPU reports the ground height under every wheel each frame. The rover casts shadows on the terrain by ray-testing its parts as oriented boxes, and darkens the ground under its chassis. Its wheels press chevron tracks into a 128 m toroidal world-space map, and the terrain shades them as darker, freshly turned soil.

## License

MIT. See [LICENSE](LICENSE). The web-ocean copyright notice for `js/wgsl/post.js` is kept there as its license requires.
