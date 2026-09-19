// ---------------------------------------------------------------------------
// Backwater run: the timed gate race through the Kerala fun zone.
//
// Pure state — no three.js, no scene — so it can be unit tested on its own.
// A gate is { x, z, y, heading, halfW, top }: `heading` is the direction of
// travel through it (same convention as the drone's yaw: forward is
// (sin h, 0, cos h)), `y` the water level under it, `top` the bar height above
// that, `halfW` half the distance between its poles.
// ---------------------------------------------------------------------------

// Where the path prev->cur crosses the gate's plane going forward, or null.
// The aperture is tested at the crossing point itself: a diagonal that threads
// the poles counts even if both endpoints are wide of them, and one that
// crosses the plane outside the poles does not, even if an endpoint is inside.
export function gateCrossing(gate, prev, cur) {
  const nx = Math.sin(gate.heading)
  const nz = Math.cos(gate.heading)
  const u0 = (prev.x - gate.x) * nx + (prev.z - gate.z) * nz
  const u1 = (cur.x - gate.x) * nx + (cur.z - gate.z) * nz
  if (!(u0 < 0 && u1 >= 0)) return null
  const f = u0 / (u0 - u1)
  const cx = prev.x + (cur.x - prev.x) * f
  const cy = prev.y + (cur.y - prev.y) * f
  const cz = prev.z + (cur.z - prev.z) * f
  // across-gate offset: right-hand vector of the travel direction
  const v = (cx - gate.x) * nz - (cz - gate.z) * nx
  if (Math.abs(v) > gate.halfW) return null
  if (cy < gate.y || cy > gate.y + gate.top) return null
  return { f, x: cx, y: cy, z: cz }
}

// IDLE (outside the zone) -> READY (inside, waiting at the start) -> RUNNING
// (timing, gates in order) -> back to READY when the start gate closes the lap.
export function createRace(gates) {
  const race = {
    gates,
    state: 'IDLE',
    next: 0,        // index of the gate to take next; 0 is start/finish
    startT: 0,
    time: 0,        // seconds into the current run
    lastLap: null,
    lapAt: -Infinity,   // when the last lap closed, for the HUD's celebration
    best: null,
    newBest: false,

    // Everything but the record resets: the run is void if you crash out.
    reset() {
      race.state = 'IDLE'
      race.next = 0
      race.time = 0
    },

    // Returns the events raised this step: 'START', 'GATE', 'LAP', 'ABORT'.
    step({ prev, cur, t, inZone, down }) {
      const events = []
      if (!inZone || down) {
        if (race.state === 'RUNNING') events.push('ABORT')
        race.reset()
        return events
      }
      if (race.state === 'IDLE') race.state = 'READY'

      if (race.state === 'READY') {
        if (gateCrossing(gates[0], prev, cur)) {
          race.state = 'RUNNING'
          race.startT = t
          race.next = 1 % gates.length
          events.push('START')
        }
        race.time = 0
        return events
      }

      // RUNNING
      race.time = t - race.startT
      if (gateCrossing(gates[race.next], prev, cur)) {
        if (race.next === 0) {
          race.lastLap = race.time
          race.lapAt = t
          race.newBest = race.best === null || race.lastLap < race.best
          if (race.newBest) race.best = race.lastLap
          race.state = 'READY'
          race.time = 0
          events.push('LAP')
        } else {
          race.next = (race.next + 1) % gates.length
          events.push('GATE')
        }
      }
      return events
    },
  }
  return race
}

export function formatLap(s) {
  if (s === null || s === undefined) return '--:--.-'
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`
}
