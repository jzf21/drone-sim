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
| R | Redeploy after being shot down |

Fly within the cyan scan ring of line hardware to log it. Green = OK,
red = needs service (blinks in the scene, reason shown in the inspection log).

## Mission — cargo recovery

A cargo pod sits on the enemy landing pad at the centre of the hostile zone,
marked by a cyan light column visible from outside the perimeter. Fly in, hover
within 7 m of the pad and under 9 m above it, and hold for ~1.6 s to winch it
aboard — then outrun the rival drones until they break contact. Get shot down
carrying it and the pod resets to the pad. Progress is tracked in the MISSION
panel; no extra keys.

## World

- Rolling hills with a flat powerline corridor, distant mountain ring, pond,
  trees, bushes and rocks — all collidable (terrain, towers, wires, trees),
  with bounce physics, camera shake and an obstacle proximity warning.
- A mountain with a waterfall cascading into a plunge pool, feeding a river
  that winds across the hills into the pond.
- Sky dome with a sun disc and drifting cloud deck; ground painted by height
  and slope (grass, dirt on the steeps, bare rock, snow on the summit) with
  sand along the pond and river banks; sun and shadow frustum ride with the
  drone so everything casts shadows.
- Nav lights and a tail strobe on the airframe, corona glow and arc sparks on
  faulted hardware, tracer rounds, impact sparks and damage smoke.
- A hostile airspace zone (red perimeter, southeast beyond the pond): enter it
  and rival drones scramble from their base and open fire. Watch the INTEGRITY
  bar — collisions and hits drain it; at 0% you're down (press R to redeploy).
  Integrity slowly regenerates once you're clear of the zone.

## Credits

- Drone model: ["Drone" by NateGazzard](https://poly.pizza/m/DNbUoMtG3H) via poly.pizza (CC-BY)
- Built with [Three.js](https://threejs.org/), [React](https://react.dev/) and [Vite](https://vitejs.dev/)
