import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KERALA, ISLANDS, COURSE, MOORINGS, courseGates, keralaTerrain, LAGOON_Y, GATE_COUNT } from '../src/kerala.js'

const SHORE = 0.75

test('the run keeps clear of every island and stays inside the lagoon', () => {
  const pts = COURSE.getSpacedPoints(240)
  for (const p of pts) {
    const d = Math.hypot(p.x - KERALA.x, p.z - KERALA.z)
    assert.ok(d < KERALA.r * 0.88, `course leaves the lagoon at ${p.x.toFixed(0)},${p.z.toFixed(0)} (d=${d.toFixed(0)})`)
    for (const isl of ISLANDS) {
      const e = Math.hypot(p.x - isl.x, p.z - isl.z)
      assert.ok(e > isl.r * SHORE + 9,
        `course brushes island at ${isl.x},${isl.z}: ${e.toFixed(0)} m from centre, shore at ${(isl.r * SHORE).toFixed(0)}`)
    }
    // and it is over water, not a sandbar
    assert.ok(keralaTerrain(p.x, p.z, 0) < LAGOON_Y - 1.5, `shallows under the course at ${p.x.toFixed(0)},${p.z.toFixed(0)}`)
  }
})

test('gates are spaced out and their poles stand in water', () => {
  const gates = courseGates()
  assert.equal(gates.length, GATE_COUNT)
  for (let i = 0; i < gates.length; i++) {
    const a = gates[i], b = gates[(i + 1) % gates.length]
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 40, `gates ${i} and ${i + 1} too close`)
    for (const side of [-1, 1]) {
      const x = a.x + Math.cos(a.heading) * side * a.halfW
      const z = a.z - Math.sin(a.heading) * side * a.halfW
      assert.ok(keralaTerrain(x, z, 0) < LAGOON_Y, `gate ${i} pole on land`)
    }
  }
})

test('islands rise above the water and the bed lies below it', () => {
  for (const isl of ISLANDS) {
    assert.ok(keralaTerrain(isl.x, isl.z, 0) > LAGOON_Y + 2, 'island top under water')
  }
  assert.ok(keralaTerrain(KERALA.x + 60, KERALA.z + 20, 0) < LAGOON_Y - 3, 'open water is shallow')
  // outside the blend the natural terrain is untouched
  assert.equal(keralaTerrain(KERALA.x + KERALA.r * 1.45, KERALA.z, 7.5), 7.5)
  // and the shore ring just inside the rim stands above the water all the way round
  for (let a = 0; a < 48; a++) {
    const x = KERALA.x + Math.cos((a / 48) * Math.PI * 2) * KERALA.r * 0.985
    const z = KERALA.z + Math.sin((a / 48) * Math.PI * 2) * KERALA.r * 0.985
    assert.ok(keralaTerrain(x, z, -30) > LAGOON_Y, `shore dips under water at bearing ${a}`)
  }
})

test('moored houseboats float in open water off the racing line', () => {
  const pts = COURSE.getSpacedPoints(240)
  for (const [x, z] of MOORINGS) {
    assert.ok(keralaTerrain(x, z, 0) < LAGOON_Y - 1.5, `mooring at ${x.toFixed(0)},${z.toFixed(0)} is aground`)
    let mn = Infinity
    for (const p of pts) mn = Math.min(mn, Math.hypot(p.x - x, p.z - z))
    assert.ok(mn > 22, `mooring at ${x.toFixed(0)},${z.toFixed(0)} sits ${mn.toFixed(0)} m from the course`)
  }
})
