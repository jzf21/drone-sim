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
aboard. Then run it home to the safehouse. Get shot down carrying it and the pod
resets to the enemy pad. Progress is tracked in the MISSION panel; no extra keys.

### The safehouse

A dug-in hangar on the blind side of the mountain, roughly 860 m west of the
enemy pad. An on-screen waypoint marks it from anywhere on the map: a reticle
with a distance readout when it is in view, a chevron pinned to the screen edge
pointing the way when it is not. It reads SAFEHOUSE while you are outbound and
switches to DELIVER HERE once the pod is aboard, when the hangar also lights a
green column of its own.

Its mouth faces **west, away from hostile airspace**, so you overshoot and turn
back into it rather than diving straight in, and anything chasing you from the
east is looking at a solid back wall. Fly in through the mouth and hold over the
lit pad for ~1.6 s to unload.

The delivery is not gated on shaking pursuit — you can land the pod hot, with
rivals still on you. Breaking contact is a survival problem, not a win
condition. The hangar is also simply the best hard cover on the map, and it is
there from the start: three walls and a roof mean that once you are inside,
every sightline but the mouth is blocked. You can duck into it any time.

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
- A friendly safehouse hangar tucked behind the mountain, with an apron,
  approach lights, a windsock and a roof antenna.
- Buildings everywhere: a fortified enemy compound (hangars, fuel tanks,
  container stacks, a blast-wall ring around the pad, a radar mast) plus
  warehouses, barns, silos and water towers scattered across the map, and
  substations flanking the powerline corridor. All of it is solid — it blocks
  movement, sightlines and gunfire, and the roofs are landable.
- A hostile airspace zone (red perimeter, southeast beyond the pond). Crossing
  the perimeter no longer gives you away by itself; it just puts you inside the
  rivals' patrol envelope. Watch the INTEGRITY bar — collisions and hits drain
  it; at 0% you're down (press R to redeploy). Integrity regenerates once the
  squad has lost you.

## Stealth — hiding from the rival drones

The rivals have to actually see you. Each one carries an awareness meter that
only fills while you are inside its sensor range, inside its forward-facing
cone, and not behind something. The EXPOSURE panel reads that back:

| State | Meaning |
| --- | --- |
| **UNDETECTED** | Nothing has eyes on you. |
| **SEARCHING** | They are sweeping a last known position — yours or a radio call. |
| **IN SIGHT** | Someone can see you and the lock is filling. Break line of sight. |
| **LOCKED ON** | Weapons free. |

What actually helps:

- **Hard cover.** Hangars, silos, containers, blast walls and hillsides all
  block their view *and* stop their rounds. Ducking behind a building drops the
  drones that lose sight of you out of pursuit while the ones with a clear angle
  keep shooting — so which side of the building you pick matters.
- **Flying low and slow.** Speed and altitude both raise how fast they acquire
  you. Hugging terrain buys real time; sprinting across open ground does not.
- **Flanking.** Their sensor cone points forward and they can only turn so fast,
  so coming in behind a patrolling drone works.

What does not help:

- **Trees.** They screen you from the drones' optics but the base radar sees
  straight through foliage. Only buildings and terrain stop the radar sweep.
- **Standing still after being spotted.** Losing line of sight sends them to
  where you *were*, and the search orbit widens from there until it finds you.
  Break contact, then relocate.
- **Hiding from one drone.** A spotter radios your position to the others; they
  will come and look, though only a drone's own eyes let it open fire.
- **Grabbing the pod quietly.** The winch and the pod itself are loud —
  detection rates rise sharply while securing and carrying, so the long run home
  to the safehouse is where cover earns its keep.

## Credits

- Drone model: ["Drone" by NateGazzard](https://poly.pizza/m/DNbUoMtG3H) via poly.pizza (CC-BY)
- Built with [Three.js](https://threejs.org/), [React](https://react.dev/) and [Vite](https://vitejs.dev/)
