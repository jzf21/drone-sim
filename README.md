# Powerline Inspection Drone Sim

A Three.js + React drone simulator for inspecting high-voltage powerline hardware.
Fly along a 7-tower transmission line and scan components (suspension insulators,
vibration dampers, splice sleeves). Parts that need service are flagged red and
logged in the inspection HUD, along with telemetry and a minimap.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click the page to give it keyboard focus.

## Controls

| Key | Action |
| --- | --- |
| W / A / S / D | Move forward / left / back / right |
| Space / Shift | Ascend / descend |
| Q / E or ← / → | Yaw |

Fly within the cyan scan ring of line hardware to log it. Green = OK,
red = needs service (blinks in the scene, reason shown in the inspection log).

## Credits

- Drone model: ["Drone" by NateGazzard](https://poly.pizza/m/DNbUoMtG3H) via poly.pizza (CC-BY)
- Built with [Three.js](https://threejs.org/), [React](https://react.dev/) and [Vite](https://vitejs.dev/)
