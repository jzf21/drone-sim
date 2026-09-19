import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Kerala backwaters: the fun zone.
//
// A lagoon dug into the hills south-west of the powerline, with an archipelago of
// palm islands, a fishing village, kettuvallam houseboats drifting the
// channels, Chinese fishing nets on the shore, and a loop of lit gates strung
// over the water for the timed backwater run (see race.js).
//
// Nothing here is hostile. The rivals' patrol circuits are ~850 m away and
// their sensors reach 155 m, so the lagoon is genuinely out of their world.
// ---------------------------------------------------------------------------

// West of the racetrack (which owns x 75..405 around z -300) and clear of
// the ridge bands, which start ~894 m out.
export const KERALA = { x: -200, z: -480, r: 175 }
export const LAGOON_Y = -10     // water level
const FLOOR = -16               // lagoon bed
const ISLAND_TOP = LAGOON_Y + 3 // island plateau
const SHELF = LAGOON_Y + 1.5    // the dry shore ring around the water

// Underwater footprints. The shoreline falls at roughly 0.75 r, where the
// island's slope crosses the water level.
const SHORE = 0.75
export const ISLANDS = [
  { x: -10, z: 20, r: 45, village: true },
  { x: 90, z: -70, r: 38 },
  { x: -50, z: -45, r: 28 },
  { x: -95, z: 100, r: 34 },
  { x: 95, z: 120, r: 30 },
  { x: 150, z: 20, r: 22 },
  { x: -145, z: 25, r: 22 },
  { x: 10, z: -120, r: 30 },
].map((i) => ({ ...i, x: i.x + KERALA.x, z: i.z + KERALA.z }))

// The run: a closed loop threading the islands. Gate 0 sits off the village
// jetty and is the start/finish line.
const COURSE_PTS = [
  [40, -25], [95, -20], [105, 60], [40, 70], [-20, 110],
  [-70, 40], [-125, -30], [-60, -110], [10, -70],
].map(([x, z]) => new THREE.Vector3(x + KERALA.x, LAGOON_Y, z + KERALA.z))
export const COURSE = new THREE.CatmullRomCurve3(COURSE_PTS, true, 'centripetal', 0.6)
export const GATE_COUNT = 12
export const GATE_HALF_W = 7
export const GATE_TOP = 11

// Houseboats tied up off the island shores: [x, z, heading]
export const MOORINGS = [
  [ISLANDS[1].x - 30, ISLANDS[1].z + 20, 0.9],
  [ISLANDS[2].x + 32, ISLANDS[2].z + 8, -1.2],
  [ISLANDS[4].x - 22, ISLANDS[4].z - 30, 0.3],
  [ISLANDS[0].x + 36, ISLANDS[0].z - 26, 1.1],
]

export function courseGates() {
  const pts = COURSE.getSpacedPoints(GATE_COUNT)   // last point repeats the first
  const gates = []
  for (let i = 0; i < GATE_COUNT; i++) {
    const u = i / GATE_COUNT
    const tan = COURSE.getTangentAt(u)
    gates.push({
      x: pts[i].x, z: pts[i].z, y: LAGOON_Y,
      heading: Math.atan2(tan.x, tan.z),
      halfW: GATE_HALF_W, top: GATE_TOP,
    })
  }
  return gates
}

const sstep = THREE.MathUtils.smoothstep

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Terrain modifier, applied by terrainHeight. Inside the radius the natural
// hills are replaced outright: the bed, the islands rising from it, and a
// shore shelf just above the water at the edge. Outside, the shelf blends
// back to the hills over another 40% of the radius, so the ~30 m of natural
// relief around this site reads as a valley bowl rather than a crater wall.
export function keralaTerrain(x, z, h) {
  const dx = x - KERALA.x
  const dz = z - KERALA.z
  const d = Math.sqrt(dx * dx + dz * dz)
  const R = KERALA.r
  if (d > R * 1.4) return h
  let inner = FLOOR
  for (const isl of ISLANDS) {
    const e = Math.hypot(x - isl.x, z - isl.z) / isl.r
    if (e >= 1) continue
    inner = Math.max(inner, THREE.MathUtils.lerp(FLOOR, ISLAND_TOP, 1 - sstep(e, 0.5, 1)))
  }
  // the shore rises out of the water just inside the rim
  inner = THREE.MathUtils.lerp(inner, SHELF, sstep(d, R * 0.9, R * 0.98))
  return THREE.MathUtils.lerp(inner, h, sstep(d, R, R * 1.4))
}

// Ground colour weights inside the zone: lush tropical green on the islands
// and the rim, wet sand where the land meets the water.
export function keralaTint(x, z, y) {
  const d = Math.hypot(x - KERALA.x, z - KERALA.z)
  if (d > KERALA.r * 1.4) return null
  const inside = 1 - sstep(d, KERALA.r * 1.0, KERALA.r * 1.4)
  const sand = (1 - sstep(Math.abs(y - LAGOON_Y), 0.6, 2.2)) * inside
  const lush = sstep(y, LAGOON_Y + 1.2, LAGOON_Y + 2.6) * inside
  return { lush, sand }
}

export function isInKerala(x, z) {
  return Math.hypot(x - KERALA.x, z - KERALA.z) < KERALA.r
}

// ---------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------

export function buildKerala(scene, { hdr, waterMat, terrainHeight }) {
  const rand = mulberry32(2718)   // own stream: never re-rolls the fault layout
  const colliders = []
  const treeColliders = []
  const footprints = []
  const gates = courseGates()
  const K = KERALA

  const mats = {
    trunk: new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 1 }),
    frond: new THREE.MeshStandardMaterial({ color: 0x3f8f2f, roughness: 0.9, side: THREE.DoubleSide }),
    hull: new THREE.MeshStandardMaterial({ color: 0x4a2f1c, roughness: 0.9 }),
    deck: new THREE.MeshStandardMaterial({ color: 0xa7885c, roughness: 1 }),
    thatch: new THREE.MeshStandardMaterial({ color: 0xb8965a, roughness: 1 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xe8e0c8, roughness: 0.95 }),
    tile: new THREE.MeshStandardMaterial({ color: 0x9b4a2f, roughness: 0.9 }),
    bamboo: new THREE.MeshStandardMaterial({ color: 0xb9a35c, roughness: 0.8 }),
    net: new THREE.MeshStandardMaterial({
      color: 0x2a2a24, roughness: 1, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    }),
    paddy: new THREE.MeshStandardMaterial({ color: 0x5fb845, roughness: 1 }),
    bund: new THREE.MeshStandardMaterial({ color: 0x8a7a4a, roughness: 1 }),
    stone: new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: 1, flatShading: true }),
    snake: new THREE.MeshStandardMaterial({ color: 0x2b1a10, roughness: 0.7 }),
  }

  // -- water ----------------------------------------------------------------
  // Same reflective surface as the pond, tinted the tea-brown green of a
  // backwater rather than the pond's blue.
  const lagoonMat = waterMat.clone()
  lagoonMat.color.setHex(0x1d4238)
  // the pond's ripple tiling stretches to lake-sized cells on a disc this
  // big, so the lagoon gets its own copy of the normal map, repeated finer
  lagoonMat.normalMap = waterMat.normalMap.clone()
  lagoonMat.normalMap.repeat.set(64, 64)
  lagoonMat.normalMap.needsUpdate = true
  const lagoon = new THREE.Mesh(new THREE.CircleGeometry(K.r * 0.96, 72), lagoonMat)
  lagoon.rotation.x = -Math.PI / 2
  lagoon.position.set(K.x, LAGOON_Y, K.z)
  scene.add(lagoon)

  function waterSurfaceAt(x, z) {
    const dx = x - K.x, dz = z - K.z
    return dx * dx + dz * dz < (K.r * 0.96) ** 2 ? LAGOON_Y : -Infinity
  }

  // -- coconut palms --------------------------------------------------------
  // Leaning trunks with a crown of drooping fronds. Trunk geometry has its
  // origin at the base so a lean rotates about the roots, not the midpoint.
  const palms = []
  const addPalm = (x, z, s) => palms.push({ x, z, s, lean: 0.05 + rand() * 0.13, dir: rand() * Math.PI * 2 })
  for (const isl of ISLANDS) {
    const n = Math.round(isl.r / 3.2)
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2
      const e = isl.r * (0.3 + rand() * 0.38)
      addPalm(isl.x + Math.cos(a) * e, isl.z + Math.sin(a) * e, 0.85 + rand() * 0.45)
    }
  }
  // fringe along the outer shore, wherever the land clears the water
  for (let i = 0; i < 120; i++) {
    const a = rand() * Math.PI * 2
    const d = K.r * (0.95 + rand() * 0.25)
    const x = K.x + Math.cos(a) * d
    const z = K.z + Math.sin(a) * d
    if (terrainHeight(x, z) > LAGOON_Y + 0.8) addPalm(x, z, 0.9 + rand() * 0.5)
  }
  {
    const H = 11
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.42, H, 7)
    trunkGeo.translate(0, H / 2, 0)
    const trunks = new THREE.InstancedMesh(trunkGeo, mats.trunk, palms.length)
    // one frond: a strip that curls downward along its length
    const FRONDS = 8
    const frondGeo = new THREE.PlaneGeometry(0.9, 4.6, 1, 6)
    frondGeo.translate(0, 2.3, 0)
    frondGeo.rotateX(-Math.PI / 2)   // now lies along +z from the origin
    {
      const pos = frondGeo.attributes.position
      for (let i = 0; i < pos.count; i++) {
        const l = pos.getZ(i) / 4.6
        pos.setY(i, 1.1 * l - 2.4 * l * l)   // rises, then droops
      }
      frondGeo.computeVertexNormals()
    }
    const fronds = new THREE.InstancedMesh(frondGeo, mats.frond, palms.length * FRONDS)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const e = new THREE.Euler()
    const v = new THREE.Vector3()
    const tip = new THREE.Vector3()
    palms.forEach((p, i) => {
      const y = terrainHeight(p.x, p.z) - 0.3
      e.set(Math.cos(p.dir) * p.lean, 0, Math.sin(p.dir) * p.lean)
      q.setFromEuler(e)
      m.compose(v.set(p.x, y, p.z), q, tip.set(p.s, p.s, p.s))
      trunks.setMatrixAt(i, m)
      // crown sits at the leaned trunk's tip
      tip.set(0, H * p.s, 0).applyQuaternion(q).add(v)
      for (let k = 0; k < FRONDS; k++) {
        e.set(0, (k / FRONDS) * Math.PI * 2 + p.dir, 0)
        q.setFromEuler(e)
        m.compose(tip, q, new THREE.Vector3(p.s, p.s, p.s))
        fronds.setMatrixAt(i * FRONDS + k, m)
      }
      treeColliders.push({ x: p.x, z: p.z, r: 0.9 * p.s, top: y + H * p.s })
    })
    trunks.castShadow = true
    fronds.castShadow = true
    scene.add(trunks, fronds)
  }

  // -- kettuvallam houseboats ----------------------------------------------
  // Long hull, plank deck, thatched barrel roof. Long axis is local +x, which
  // is the convention the box collider's `rot` expects.
  function makeHouseboat() {
    const g = new THREE.Group()
    const hull = new THREE.Mesh(new THREE.BoxGeometry(18, 2.2, 5), mats.hull)
    hull.position.y = 0.6
    hull.castShadow = true
    g.add(hull)
    for (const side of [-1, 1]) {
      const nose = new THREE.Mesh(new THREE.ConeGeometry(2.5, 4, 4), mats.hull)
      nose.rotation.z = -side * Math.PI / 2
      nose.rotation.y = Math.PI / 4
      nose.scale.set(1, 1, 0.55)
      nose.position.set(side * 11, 0.7, 0)
      g.add(nose)
    }
    const deck = new THREE.Mesh(new THREE.BoxGeometry(18.2, 0.2, 5.2), mats.deck)
    deck.position.y = 1.8
    g.add(deck)
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 12, 14, 1, false, 0, Math.PI), mats.thatch)
    roof.rotation.z = Math.PI / 2   // arch: half-shell's +x half now faces up
    roof.position.set(-1, 2.2, 0)
    roof.castShadow = true
    g.add(roof)
    // end walls under the arch, with a dark doorway
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.CircleGeometry(2.6, 14, 0, Math.PI), mats.wall)
      wall.rotation.y = side * Math.PI / 2
      wall.position.set(-1 + side * 6, 2.2, 0)
      g.add(wall)
    }
    return g
  }
  function addHouseboat(x, z, rot, moving = false) {
    const g = makeHouseboat()
    g.position.set(x, LAGOON_Y - 0.4, z)
    g.rotation.y = rot
    scene.add(g)
    const box = {
      kind: 'box', x, z, hw: 9, hd: 2.5, y0: LAGOON_Y - 1, y1: LAGOON_Y + 5, rot,
      bound: Math.hypot(9, 2.5),
    }
    colliders.push(box)
    return { g, box, moving }
  }
  for (const [x, z, rot] of MOORINGS) addHouseboat(x, z, rot)

  // -- things that move along the course ----------------------------------
  // Two houseboats drift the run at a walking pace, so the lane is never quite
  // clear; a snake boat paces the loop faster, something to race against.
  const courseLen = COURSE.getLength()
  const movers = []
  for (const [u, speed] of [[0.3, 3.2], [0.72, 2.6]]) {
    const hb = addHouseboat(K.x, K.z, 0)
    movers.push({ ...hb, u, speed, sway: rand() * 6 })
  }
  {
    // chundan vallam: a long low hull with the stern swept up
    const g = new THREE.Group()
    const hull = new THREE.Mesh(new THREE.BoxGeometry(30, 1, 2), mats.snake)
    hull.position.y = 0.3
    g.add(hull)
    const stern = new THREE.Mesh(new THREE.BoxGeometry(6, 0.8, 1.2), mats.snake)
    stern.position.set(-16.5, 2.2, 0)
    stern.rotation.z = -0.9
    g.add(stern)
    const bow = new THREE.Mesh(new THREE.ConeGeometry(1, 4, 4), mats.snake)
    bow.rotation.z = -Math.PI / 2
    bow.rotation.y = Math.PI / 4
    bow.scale.set(1, 1, 0.5)
    bow.position.set(17, 0.3, 0)
    g.add(bow)
    // a rank of rowers, as a strip of dark studs
    const rowGeo = new THREE.BoxGeometry(0.6, 1.1, 0.5)
    const rowMat = new THREE.MeshStandardMaterial({ color: 0xc86a3a, roughness: 1 })
    for (let i = 0; i < 14; i++) {
      const r = new THREE.Mesh(rowGeo, rowMat)
      r.position.set(-11 + i * 1.6, 1.2, i % 2 ? 0.6 : -0.6)
      g.add(r)
    }
    // canopy of umbrellas at the stern, the traditional red and gold
    const umbMat = new THREE.MeshStandardMaterial({ color: 0xd8262a, roughness: 0.8 })
    for (let i = 0; i < 2; i++) {
      const u = new THREE.Mesh(new THREE.ConeGeometry(1.3, 0.8, 8), umbMat)
      u.position.set(-12 + i * 2.2, 3.4, 0)
      g.add(u)
    }
    g.position.set(K.x, LAGOON_Y, K.z)
    scene.add(g)
    const box = {
      kind: 'box', x: K.x, z: K.z, hw: 15, hd: 1, y0: LAGOON_Y - 0.5, y1: LAGOON_Y + 2.2, rot: 0,
      bound: Math.hypot(15, 1),
    }
    colliders.push(box)
    movers.push({ g, box, u: 0.05, speed: 7.5, sway: 0, snake: true })
  }
  const TMP_P = new THREE.Vector3()
  const TMP_T = new THREE.Vector3()
  function placeMover(mv) {
    COURSE.getPointAt(mv.u, TMP_P)
    COURSE.getTangentAt(mv.u, TMP_T)
    const rot = Math.atan2(-TMP_T.z, TMP_T.x)
    mv.g.position.set(TMP_P.x, mv.g.position.y, TMP_P.z)
    mv.g.rotation.y = rot
    mv.box.x = TMP_P.x
    mv.box.z = TMP_P.z
    mv.box.rot = rot
  }
  for (const mv of movers) placeMover(mv)

  // -- Chinese fishing nets (cheena vala) -----------------------------------
  // A pivoting frame of poles cantilevered out over the water, the net hung
  // from the far end, counterweighted with stones. They dip and lift slowly.
  const nets = []
  function addNet(x, z, facing) {
    const y = Math.max(terrainHeight(x, z), LAGOON_Y + 0.3)
    const root = new THREE.Group()
    root.position.set(x, y, z)
    root.rotation.y = facing
    // platform on stilts at the shore
    const plat = new THREE.Mesh(new THREE.BoxGeometry(5, 0.3, 4), mats.deck)
    plat.position.set(0, 2.2, 0)
    root.add(plat)
    for (const [px, pz] of [[-2, -1.5], [2, -1.5], [-2, 1.5], [2, 1.5]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3, 5), mats.bamboo)
      leg.position.set(px, 0.9, pz)
      root.add(leg)
    }
    // the tilting frame, pivoted at the platform's water edge
    const arm = new THREE.Group()
    arm.position.set(0, 2.4, 2)
    root.add(arm)
    const L = 15
    for (const [sx, sz] of [[-4.5, 4.5], [4.5, 4.5], [-4.5, L], [4.5, L]]) {
      const len = Math.hypot(sx, sz, 5)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, len, 5), mats.bamboo)
      pole.position.set(sx / 2, 2.5, sz / 2)
      pole.lookAt(sx, 5, sz)
      pole.rotateX(Math.PI / 2)
      arm.add(pole)
    }
    const net = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 10.5), mats.net)
    net.rotation.x = -Math.PI / 2
    net.position.set(0, 4.6, L / 2 + 2.2)
    arm.add(net)
    // sag: a bowl of net hanging below the frame
    const sag = new THREE.Mesh(new THREE.ConeGeometry(4.5, 3.5, 8, 1, true), mats.net)
    sag.rotation.x = Math.PI
    sag.position.set(0, 3, L / 2 + 2.2)
    arm.add(sag)
    for (let i = 0; i < 4; i++) {
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.45, 0), mats.stone)
      st.position.set(-1.2 + i * 0.8, -0.2 - (i % 2) * 0.5, -3.5 - (i % 2) * 0.6)
      arm.add(st)
    }
    scene.add(root)
    nets.push({ arm, phase: rand() * 6 })
    footprints.push({ x, z, r: 8 })
  }
  {
    const v = ISLANDS[0]
    for (const a of [1.9, 2.5]) {
      const d = v.r * SHORE - 2
      addNet(v.x + Math.cos(a) * d, v.z + Math.sin(a) * d, -a - Math.PI / 2)
    }
    for (const a of [-0.55, 1.05, 3.6]) {
      const d = K.r * 0.955
      addNet(K.x + Math.cos(a) * d, K.z + Math.sin(a) * d, -a + Math.PI / 2)
    }
  }

  // -- the village island ---------------------------------------------------
  // Whitewashed houses under clay-tile roofs, a paddy field, and a jetty
  // reaching out toward the start gate.
  {
    const v = ISLANDS[0]
    const TOP = ISLAND_TOP
    const houses = [
      [-14, 8, 0.3, 9, 7], [-4, 16, -0.4, 8, 6], [8, 6, 0.9, 10, 7],
      [-20, -6, 1.2, 8, 6], [4, -8, -0.2, 7, 6],
    ]
    for (const [ox, oz, rot, w, d] of houses) {
      const x = v.x + ox, z = v.z + oz
      const base = terrainHeight(x, z) - 0.2
      const h = 3.6
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats.wall)
      m.position.set(x, base + h / 2, z)
      m.rotation.y = rot
      m.castShadow = true
      m.receiveShadow = true
      scene.add(m)
      // hipped tile roof: a squat pyramid
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.hypot(w, d) / 2 + 0.6, 2.4, 4), mats.tile)
      roof.rotation.y = rot + Math.PI / 4
      roof.scale.set(w / Math.hypot(w, d) * 1.42, 1, d / Math.hypot(w, d) * 1.42)
      roof.position.set(x, base + h + 1.2, z)
      roof.castShadow = true
      scene.add(roof)
      colliders.push({
        kind: 'box', x, z, hw: w / 2, hd: d / 2, y0: base, y1: base + h + 2.4, rot,
        bound: Math.hypot(w / 2, d / 2),
      })
    }
    // paddy: a bright terrace with bunds, on the flat of the plateau
    const px = v.x - 4, pz = v.z - 22
    const paddy = new THREE.Mesh(new THREE.PlaneGeometry(30, 16), mats.paddy)
    paddy.rotation.x = -Math.PI / 2
    paddy.position.set(px, TOP + 0.1, pz)
    scene.add(paddy)
    for (let i = 0; i <= 4; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(30.4, 0.5, 0.5), mats.bund)
      b.position.set(px, TOP + 0.3, pz - 8 + i * 4)
      scene.add(b)
    }
    // jetty out to the water on the start-gate side
    const g0 = gates[0]
    const jx = v.x + 24, jz = v.z - 14
    const dir = Math.atan2(g0.x - jx, g0.z - jz)
    const JL = 22
    for (let i = 0; i < 6; i++) {
      const f = (i + 0.5) / 6
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 4.5, 6), mats.trunk)
      post.position.set(jx + Math.sin(dir) * JL * f, LAGOON_Y + 0.8, jz + Math.cos(dir) * JL * f)
      scene.add(post)
    }
    const planks = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.25, JL), mats.deck)
    planks.position.set(jx + Math.sin(dir) * JL / 2, LAGOON_Y + 3, jz + Math.cos(dir) * JL / 2)
    planks.rotation.y = dir
    scene.add(planks)
    footprints.push({ x: v.x, z: v.z, r: v.r })
  }

  // -- the gates ------------------------------------------------------------
  // Bamboo poles with a crossbar and a string of festival lamps. The lamps are
  // one material per gate so the run can light the next one amber, the ones
  // behind you green, and the rest a dim ember. Poles are collidable; the bar
  // and lamps are not — flying over the bar simply does not count.
  const LAMP = {
    idle: hdr(0xffb020, 0.55),
    next: hdr(0xffb020, 3.2),
    done: hdr(0x21d07a, 1.8),
    start: hdr(0x35e0ff, 3.0),
  }
  const gateLamps = []
  const numTex = (n) => {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const ctx = c.getContext('2d')
    ctx.fillStyle = 'rgba(0,0,0,0)'
    ctx.fillRect(0, 0, 64, 64)
    ctx.fillStyle = '#ffd27a'
    ctx.font = 'bold 44px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(n, 32, 34)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  gates.forEach((g, i) => {
    const c = Math.cos(g.heading), s = Math.sin(g.heading)
    // right-hand vector of travel: poles sit at ±halfW along it
    const rx = c, rz = -s
    const H = g.top + 1
    for (const side of [-1, 1]) {
      const x = g.x + rx * side * g.halfW
      const z = g.z + rz * side * g.halfW
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, H, 8), mats.bamboo)
      pole.position.set(x, LAGOON_Y + H / 2 - 0.6, z)
      pole.castShadow = true
      scene.add(pole)
      colliders.push({ kind: 'cyl', x, z, r: 0.36, y0: LAGOON_Y - 1, y1: LAGOON_Y + H, bound: 0.36 })
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, g.halfW * 2 + 0.5, 6), mats.bamboo)
    bar.rotation.z = Math.PI / 2
    bar.rotation.y = -g.heading   // local x -> the right-hand vector
    bar.position.set(g.x, LAGOON_Y + g.top, g.z)
    scene.add(bar)
    const lampMat = new THREE.MeshBasicMaterial({ color: LAMP.idle.clone() })
    const lampGeo = new THREE.SphereGeometry(0.32, 8, 6)
    for (let k = 0; k < 9; k++) {
      const f = (k + 0.5) / 9 - 0.5
      const lamp = new THREE.Mesh(lampGeo, lampMat)
      lamp.position.set(
        g.x + rx * f * g.halfW * 2, LAGOON_Y + g.top - 0.7 - Math.abs(f) * 0.9, g.z + rz * f * g.halfW * 2
      )
      scene.add(lamp)
    }
    gateLamps.push(lampMat)
    const num = new THREE.Sprite(new THREE.SpriteMaterial({
      map: numTex(i === 0 ? 'S' : String(i)), transparent: true, depthWrite: false, fog: false,
    }))
    num.scale.set(3.2, 3.2, 1)
    num.position.set(g.x, LAGOON_Y + g.top + 2.6, g.z)
    scene.add(num)
  })

  // -- per-frame ------------------------------------------------------------
  function update(dt, t, race) {
    for (const mv of movers) {
      mv.u = (mv.u + (mv.speed * dt) / courseLen) % 1
      placeMover(mv)
      if (!mv.snake) {
        mv.g.rotation.z = Math.sin(t * 0.7 + mv.sway) * 0.02
        mv.g.position.y = LAGOON_Y - 0.4 + Math.sin(t * 0.9 + mv.sway) * 0.12
      }
    }
    for (const n of nets) {
      n.arm.rotation.x = -0.28 + Math.sin(t * 0.35 + n.phase) * 0.22
    }
    const running = race.state === 'RUNNING'
    gateLamps.forEach((m, i) => {
      let c
      if (running) {
        const done = i !== 0 && i < race.next
        c = i === race.next ? LAMP.next : done ? LAMP.done : LAMP.idle
      } else {
        c = i === 0 ? LAMP.start : LAMP.idle
      }
      m.color.copy(c)
      if ((running && i === race.next) || (!running && i === 0)) {
        m.color.multiplyScalar(0.8 + 0.2 * Math.sin(t * 6))
      }
    })
  }

  return { colliders, treeColliders, footprints, gates, waterSurfaceAt, update }
}
