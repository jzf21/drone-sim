import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateCrossing, createRace } from '../src/race.js'

// A gate at the origin facing +z: travel direction is +z, aperture spans x.
const G = { x: 0, z: 0, y: 0, heading: 0, halfW: 7, top: 11 }
const p = (x, y, z) => ({ x, y, z })

test('crossing the gate plane forward inside the aperture counts', () => {
  const hit = gateCrossing(G, p(1, 4, -2), p(1, 4, 3))
  assert.ok(hit)
  assert.equal(+hit.f.toFixed(3), 0.4)
})

test('crossing backwards, wide, over the bar or under water does not count', () => {
  assert.equal(gateCrossing(G, p(0, 4, 3), p(0, 4, -2)), null)      // wrong way
  assert.equal(gateCrossing(G, p(9, 4, -2), p(9, 4, 3)), null)      // outside a pole
  assert.equal(gateCrossing(G, p(0, 14, -2), p(0, 14, 3)), null)    // over the bar
  assert.equal(gateCrossing(G, p(0, -1, -2), p(0, -1, 3)), null)    // below the water
  assert.equal(gateCrossing(G, p(0, 4, 1), p(0, 4, 3)), null)       // already past it
})

test('the aperture is tested where the path meets the plane, not at the endpoints', () => {
  // starts wide, ends wide, but threads the gate at the crossing point
  const hit = gateCrossing(G, p(-12, 4, -2), p(12, 4, 2))
  assert.ok(hit)
  // a diagonal that crosses the plane outside the poles is a miss even though
  // one endpoint is inside the aperture's x-range
  assert.equal(gateCrossing(G, p(6, 4, -10), p(20, 4, 4)), null)
})

test('a rotated gate uses its own travel direction', () => {
  const g = { x: 50, z: 50, y: 0, heading: Math.PI / 2, halfW: 7, top: 11 }   // travel +x
  assert.ok(gateCrossing(g, p(48, 3, 51), p(52, 3, 51)))
  assert.equal(gateCrossing(g, p(52, 3, 51), p(48, 3, 51)), null)
  assert.equal(gateCrossing(g, p(48, 3, 60), p(52, 3, 60)), null)
})

// Three gates in a row along +z, 30 m apart. Gate 0 is start/finish.
const gates = [0, 30, 60].map((z) => ({ x: 0, z, y: 0, heading: 0, halfW: 7, top: 11 }))
const through = (race, i, t, extra = {}) =>
  race.step({ prev: p(0, 4, gates[i].z - 1), cur: p(0, 4, gates[i].z + 1), t, inZone: true, down: false, ...extra })
const idle = (race, t, extra = {}) =>
  race.step({ prev: p(0, 4, 200), cur: p(0, 4, 200), t, inZone: true, down: false, ...extra })

test('entering the zone arms the run; the start gate begins timing', () => {
  const race = createRace(gates)
  assert.equal(race.state, 'IDLE')
  idle(race, 0)
  assert.equal(race.state, 'READY')
  assert.equal(race.next, 0)
  through(race, 0, 10)
  assert.equal(race.state, 'RUNNING')
  assert.equal(race.next, 1)
  idle(race, 12.5)
  assert.equal(+race.time.toFixed(2), 2.5)
})

test('gates must be taken in order; the wrong one is ignored', () => {
  const race = createRace(gates)
  idle(race, 0)
  through(race, 0, 1)
  through(race, 2, 2)             // skipped gate 1
  assert.equal(race.next, 1)
  through(race, 1, 3)
  assert.equal(race.next, 2)
  through(race, 2, 4)
  assert.equal(race.next, 0)      // back round to the start/finish
  assert.equal(race.state, 'RUNNING')
})

test('crossing the start gate again finishes the lap and records the best', () => {
  const race = createRace(gates)
  idle(race, 0)
  through(race, 0, 1)
  through(race, 1, 2)
  through(race, 2, 3)
  const ev = through(race, 0, 21)
  assert.deepEqual(ev, ['LAP'])
  assert.equal(race.state, 'READY')
  assert.equal(race.lastLap, 20)
  assert.equal(race.best, 20)
  assert.equal(race.newBest, true)
  assert.equal(race.lapAt, 21)

  // a slower second lap keeps the best
  through(race, 0, 30)
  through(race, 1, 31); through(race, 2, 32)
  through(race, 0, 55)
  assert.equal(race.lastLap, 25)
  assert.equal(race.best, 20)
  assert.equal(race.newBest, false)
})

test('leaving the zone or going down aborts a run in progress', () => {
  const race = createRace(gates)
  idle(race, 0)
  through(race, 0, 1)
  through(race, 1, 2)
  let ev = idle(race, 3, { inZone: false })
  assert.deepEqual(ev, ['ABORT'])
  assert.equal(race.state, 'IDLE')
  assert.equal(race.next, 0)
  assert.equal(race.time, 0)

  idle(race, 4)
  through(race, 0, 5)
  ev = idle(race, 6, { down: true })
  assert.deepEqual(ev, ['ABORT'])
  assert.equal(race.state, 'IDLE')

  // a redeploy clears everything but the best time
  race.best = 20
  race.reset()
  assert.equal(race.state, 'IDLE')
  assert.equal(race.best, 20)
})

test('leaving the zone while merely armed just disarms, quietly', () => {
  const race = createRace(gates)
  idle(race, 0)
  const ev = idle(race, 1, { inZone: false })
  assert.deepEqual(ev, [])
  assert.equal(race.state, 'IDLE')
})
