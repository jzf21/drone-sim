import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { createAtmosphere } from './atmosphere.js'
import { createPostFX } from './postfx.js'

// ---------------------------------------------------------------------------
// Powerline inspection drone simulation
// ---------------------------------------------------------------------------

const START_HOUR = 17.8   // late afternoon: long shadows, warm key light
const CYCLE_RATE = 0.08   // hours per second when the clock is running (~5 min/day)

// Emissive markers are pushed above 1.0 so filmic tone mapping keeps them
// saturated instead of washing them toward white, and so the bloom pass can
// tell them apart from lit surfaces. Anything the sun lights tops out at 1.0,
// which is exactly the bloom threshold, so only these glow.
function hdr(hex, gain) {
  return new THREE.Color(hex).multiplyScalar(gain)
}

const SPAN = 140          // distance between towers (m)
const TOWERS = 7
const LINE_LEN = SPAN * (TOWERS - 1)
const X0 = -LINE_LEN / 2
const SCAN_RANGE = 18     // detection radius (m)
const FAULT_RATE = 0.22
const POND = { x: 260, z: 230, r: 55 }
const MTN = { x: -140, z: 330, h: 150, sigma: 60 }
const POOL = { x: -140, z: 205, r: 14 }
const ZONE = { x: 520, z: 330, r: 200 }   // hostile airspace
const PICKUP_R = 7        // horizontal hover radius over the pad (m)
const PICKUP_CEIL = 9     // max height above the pad to get a grapple (m)
const SECURE_TIME = 1.6   // hover-and-hold to winch the payload aboard (s)

// -- safehouse: where the recovered pod is delivered -------------------------
// Dug in on the blind side of the mountain — the massif blocks the sightline
// from hostile airspace even from 140 m up.
const SAFEHOUSE = { x: -340, z: 330 }
const DROP_R = 5          // horizontal radius over the safehouse pad (m)
const DROP_CEIL = 7.5     // must be under the hangar roof to unload (m)
const DELIVER_TIME = 1.6  // hover-and-hold to winch the pod down (s)

// -- race arena -------------------------------------------------------------
// A gate circuit in the hills south of the corridor. ENTER teleports you onto
// the start pad (and back out again); the gates themselves are part of the
// world and can be flown any time — the timer only runs inside a race.
const RACE_C = { x: 240, z: -300 }   // arena centre
const VENUE = { x: 348, z: -300, h: 4.2 }   // paddock/start straight, under gate 0
const ARENA_ENTER_R = 150 // you must actually be at the venue to start a race
const RACE_LAPS = 2       // hard limit per race
const GATE_R = 7          // ring radius (m)
const GATE_PASS = 9.5     // pass detection radius around the ring centre (m)
const AI_GATE_PASS = 11   // AI aim for the centre; give them a little slack
const COUNTDOWN = 3       // seconds on the start clock

// -- rival sensor model -----------------------------------------------------
const SENSE_RANGE = 155   // how far their optics reach (m)
const FOV_COS = Math.cos((58 * Math.PI) / 180)   // sensor cone half-angle
const AWARE_HUNT = 0.35   // above this they come looking, but hold fire
const AWARE_FIRE = 1      // full lock: weapons free
const SEARCH_TIME = 14    // seconds spent sweeping a last-known position (s)
const SQUAD_MEMORY = 22   // how long a radioed contact stays actionable (s)
const RADAR_RANGE = 200   // base radar reach; sees through foliage, not walls (m)
const RADAR_SPEED = 0.8   // sweep rate (rad/s)
const RADAR_HALF = (13 * Math.PI) / 180   // sweep beam half-width

// river centerline: plunge pool at the mountain's foot → winds east → pond
const RIVER_SAMPLES = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-140, 0, 205),
  new THREE.Vector3(-60, 0, 185),
  new THREE.Vector3(30, 0, 212),
  new THREE.Vector3(120, 0, 240),
  new THREE.Vector3(200, 0, 228),
  new THREE.Vector3(248, 0, 230),
]).getPoints(80)

function riverNearest(x, z) {
  let d2 = Infinity, idx = 0
  for (let i = 0; i < RIVER_SAMPLES.length; i++) {
    const dx = x - RIVER_SAMPLES[i].x
    const dz = z - RIVER_SAMPLES[i].z
    const q = dx * dx + dz * dz
    if (q < d2) { d2 = q; idx = i }
  }
  return { d: Math.sqrt(d2), i: idx }
}

// deterministic RNG so faults are stable between reloads
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// -- terrain ---------------------------------------------------------------

function fbm(x, z) {
  let h = 0
  h += Math.sin(x * 0.004 + 1.7) * Math.cos(z * 0.005 + 0.3) * 10
  h += Math.sin(x * 0.011 + 4.2) * Math.cos(z * 0.009 + 2.1) * 5
  h += Math.sin(x * 0.027 + 0.9) * Math.cos(z * 0.023 + 5.0) * 2.2
  h += Math.sin(x * 0.061) * Math.cos(z * 0.055 + 1.2) * 0.9
  return h
}

// hills fade to a flat corridor along the powerline (|z| small); pond carved out
export function terrainHeight(x, z) {
  const s = THREE.MathUtils.smoothstep(Math.abs(z), 35, 110)
  let h = fbm(x, z) * s
  // inspection-area mountain
  const mdx = x - MTN.x
  const mdz = z - MTN.z
  h += MTN.h * Math.exp(-(mdx * mdx + mdz * mdz) / (2 * MTN.sigma * MTN.sigma)) * s
  // pond basin
  const dx = x - POND.x
  const dz = z - POND.z
  h -= 14 * Math.exp(-(dx * dx + dz * dz) / (2 * POND.r * POND.r)) * s
  // river channel
  const rn = riverNearest(x, z)
  if (rn.d < 18) h -= 6 * (1 - (rn.d / 18) ** 2) * s
  // waterfall plunge pool
  const pdx = x - POOL.x
  const pdz = z - POOL.z
  h -= 7 * Math.exp(-(pdx * pdx + pdz * pdz) / (2 * 18 * 18)) * s
  // notch carved down the mountain face for the falls
  const fdx = Math.abs(x - MTN.x)
  if (fdx < 12 && z > 195 && z < 262) {
    h -= 7 * (1 - (fdx / 12) ** 2) * THREE.MathUtils.smoothstep(262 - z, 0, 14) * s
  }
  // race venue apron: the start straight and paddock sit on graded level ground
  const vdx = x - VENUE.x
  const vdz = z - VENUE.z
  const vd = Math.sqrt(vdx * vdx + vdz * vdz)
  if (vd < 120) h = THREE.MathUtils.lerp(VENUE.h, h, THREE.MathUtils.smoothstep(vd, 65, 120))
  return h
}

const FAULT_NOTES = {
  insulator: ['Cracked disc', 'Flashover burn marks', 'Contamination buildup', 'Broken shed'],
  damper: ['Loose clamp', 'Missing weight', 'Slipped along conductor'],
  splice: ['Hotspot detected', 'Corrosion at sleeve', 'Bird-caging strands'],
}

export function createSim(canvas, { onTelemetry, onDetect, onReady, onWaypoint }) {
  // Two streams, following the same convention as the cloud deck's `crand`:
  // `drand` drives world decoration (mountain ring, structures, vegetation) and
  // `rand` drives inspection content (which parts exist, which are faulted).
  // Keeping them apart means adding or moving scenery can no longer re-roll the
  // fault layout — the rejection loops in scatterVegetation consume a different
  // number of draws whenever an exclusion zone changes, which used to shift
  // everything downstream of them.
  const drand = mulberry32(1337)
  const rand = mulberry32(4242)

  // No `antialias` flag: the scene is rendered through a composer, where the
  // canvas setting has no effect and the geometry pass carries its own MSAA.
  const renderer = new THREE.WebGLRenderer({ canvas })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // Filmic response rather than a hard clip at white. The low sun, the beacons
  // and the sun disc all overshoot 1.0 and need somewhere to roll off to.
  renderer.toneMapping = THREE.ACESFilmicToneMapping

  const scene = new THREE.Scene()

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 3000)
  camera.position.set(X0 - 20, 30, 60)

  const fx = createPostFX(renderer, scene, camera)

  // Sky, sun, moon, hemisphere fill, fog, exposure and the environment map that
  // every metal in the scene reflects all hang off one clock. See atmosphere.js.
  const atmos = createAtmosphere(scene, renderer, { hour: START_HOUR })
  const sun = atmos.sun

  const glowTex = makeGlowTexture()

  // -- drifting clouds ------------------------------------------------------
  const CLOUD_SPREAD = 2400
  const clouds = new THREE.Group()
  {
    const cloudTex = makeCloudTexture()
    const crand = mulberry32(9001)   // separate stream: keeps fault RNG stable
    for (let i = 0; i < 44; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, depthWrite: false, fog: false,
        opacity: 0.6 + crand() * 0.35,
      }))
      // Held rather than baked into the colour: the deck is re-tinted every
      // frame from the sky, and this is each sprite's share of that tint.
      sp.userData.tint = 0.9 + crand() * 0.14
      const w = 240 + crand() * 400
      sp.scale.set(w, w * (0.34 + crand() * 0.16), 1)
      // half the deck sits low enough to enter the chase camera's frame
      sp.position.set(
        (crand() - 0.5) * CLOUD_SPREAD,
        (i % 2 ? 225 : 340) + crand() * 140,
        (crand() - 0.5) * CLOUD_SPREAD
      )
      sp.userData.drift = 1.5 + crand() * 3.5
      clouds.add(sp)
    }
    scene.add(clouds)
  }

  // -- terrain --------------------------------------------------------------
  const groundTex = makeGroundTexture()
  groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping
  groundTex.repeat.set(48, 48)
  const groundGeo = new THREE.PlaneGeometry(4000, 4000, 300, 300)
  groundGeo.rotateX(-Math.PI / 2)
  {
    const pos = groundGeo.attributes.position
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)))
    }
    groundGeo.computeVertexNormals()

    // paint the ground by height, slope and distance to water: grass on the
    // flats, dirt then bare rock as it steepens, snow on the summit and sand
    // along the pond / river banks. The map is neutral grey so hue comes from
    // these vertex colours.
    const nrm = groundGeo.attributes.normal
    const col = new Float32Array(pos.count * 3)
    const c = new THREE.Color()
    const GRASS = new THREE.Color(0x74994f)
    const DRY = new THREE.Color(0x9aa45e)
    const DIRT = new THREE.Color(0x907a5a)
    const ROCK = new THREE.Color(0x918c84)
    const SNOW = new THREE.Color(0xf4f8fa)
    const SAND = new THREE.Color(0xc9b98d)
    const sstep = THREE.MathUtils.smoothstep
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const slope = 1 - nrm.getY(i)          // 0 = flat, 1 = vertical
      c.copy(GRASS).lerp(DRY, sstep(y, 10, 50))
      c.lerp(DIRT, sstep(slope, 0.12, 0.45))
      c.lerp(ROCK, sstep(slope, 0.42, 0.85))
      c.lerp(ROCK, sstep(y, 72, 108))
      c.lerp(SNOW, sstep(y, 112, 140))
      const pd = Math.hypot(x - POND.x, z - POND.z)
      const qd = Math.hypot(x - POOL.x, z - POOL.z)
      const rd = riverNearest(x, z).d
      const wet = Math.max(
        1 - sstep(pd, POND.r * 0.55, POND.r + 12),
        1 - sstep(qd, 12, 26),
        1 - sstep(rd, 7, 16)
      )
      c.lerp(SAND, wet * 0.9)
      const n = 0.92 + 0.16 * (Math.sin(x * 0.13) * Math.cos(z * 0.11) * 0.5 + 0.5)
      col[i * 3] = c.r * n
      col[i * 3 + 1] = c.g * n
      col[i * 3 + 2] = c.b * n
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  }
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, vertexColors: true })
  )
  ground.receiveShadow = true
  scene.add(ground)

  // -- waterway: pond, river, plunge pool, waterfall ------------------------
  // Water is now mostly reflection rather than colour: the environment map
  // carries the sky, the normal map ripples it, and the base colour only shows
  // where the surface faces away from anything bright.
  const pondNormals = makeWaterNormalTexture()
  pondNormals.repeat.set(6, 6)
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x14313f, roughness: 0.06, metalness: 0.25,
    normalMap: pondNormals, normalScale: new THREE.Vector2(0.6, 0.6),
    transparent: true, opacity: 0.92,
  })

  const water = new THREE.Mesh(new THREE.CircleGeometry(POND.r * 0.92, 40), waterMat)
  water.rotation.x = -Math.PI / 2
  water.position.set(POND.x, terrainHeight(POND.x, POND.z) + 5.5, POND.z)
  scene.add(water)
  const pondWaterY = water.position.y

  const POOL_Y = terrainHeight(POOL.x, POOL.z) + 1.2
  const pool = new THREE.Mesh(new THREE.CircleGeometry(17, 24), waterMat)
  pool.rotation.x = -Math.PI / 2
  pool.position.set(POOL.x, POOL_Y, POOL.z)
  scene.add(pool)

  // river surface: ribbon over the carved channel, smoothed so it reads as flow
  const riverY = RIVER_SAMPLES.map((s) => terrainHeight(s.x, s.z) + 1.5)
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < riverY.length - 1; i++) {
      riverY[i] = (riverY[i - 1] + riverY[i] + riverY[i + 1]) / 3
    }
  }
  riverY[0] = POOL_Y - 0.1
  riverY[riverY.length - 1] = pondWaterY

  const riverTex = makeWaterTexture()
  riverTex.wrapS = riverTex.wrapT = THREE.RepeatWrapping
  const riverNormals = makeWaterNormalTexture()
  riverNormals.repeat.set(2, 3)
  const riverMat = new THREE.MeshStandardMaterial({
    color: 0x1d4d63, map: riverTex, roughness: 0.09, metalness: 0.2,
    normalMap: riverNormals, normalScale: new THREE.Vector2(0.8, 0.8),
    transparent: true, opacity: 0.9,
  })
  {
    const N = RIVER_SAMPLES.length
    const pos = new Float32Array(N * 2 * 3)
    const uv = new Float32Array(N * 2 * 2)
    const idx = []
    for (let i = 0; i < N; i++) {
      const c = RIVER_SAMPLES[i]
      const a = RIVER_SAMPLES[Math.max(i - 1, 0)]
      const b = RIVER_SAMPLES[Math.min(i + 1, N - 1)]
      let tx = b.x - a.x, tz = b.z - a.z
      const tl = Math.hypot(tx, tz) || 1
      tx /= tl; tz /= tl
      const w = 8
      pos.set([c.x - tz * w, riverY[i], c.z + tx * w], i * 6)
      pos.set([c.x + tz * w, riverY[i], c.z - tx * w], i * 6 + 3)
      uv.set([0, i * 0.18], i * 4)
      uv.set([1, i * 0.18], i * 4 + 2)
      if (i < N - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    scene.add(new THREE.Mesh(g, riverMat))
  }

  // waterfall down the mountain face into the pool
  const fallTex = makeWaterfallTexture()
  fallTex.wrapS = fallTex.wrapT = THREE.RepeatWrapping
  const fallMat = new THREE.MeshBasicMaterial({
    map: fallTex, transparent: true, opacity: 0.85,
    depthWrite: false, side: THREE.DoubleSide,
  })
  {
    // cascade hugging the carved notch, from high on the face down into the pool
    const N = 22
    const zTop = 254
    const zBot = 210
    const pos = new Float32Array(N * 2 * 3)
    const uv = new Float32Array(N * 2 * 2)
    const idx = []
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1)
      const z = zTop + (zBot - zTop) * f
      const y = Math.max(terrainHeight(MTN.x, z) + 1.0, POOL_Y + 0.2)
      const w = 4.5
      pos.set([MTN.x - w, y, z], i * 6)
      pos.set([MTN.x + w, y, z], i * 6 + 3)
      uv.set([0, f * 3], i * 4)
      uv.set([1, f * 3], i * 4 + 2)
      if (i < N - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    scene.add(new THREE.Mesh(g, fallMat))
  }

  // cliff rocks framing the fall + snow cap on the peak
  {
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x77726c, roughness: 1, flatShading: true })
    const cliffRocks = [
      [MTN.x - 15, 232, 9],
      [MTN.x + 15, 236, 8],
      [MTN.x - 14, 248, 10],
      [MTN.x + 14, 250, 9],
    ]
    for (const [x, z, s] of cliffRocks) {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), rockMat)
      r.scale.set(s, s * 0.8, s * 0.65)
      r.rotation.set(0.4, x * 0.1, 0.2)
      r.position.set(x, terrainHeight(x, z) + s * 0.2, z)
      scene.add(r)
    }
    const peakY = terrainHeight(MTN.x, MTN.z)
    const snow = new THREE.Mesh(
      new THREE.ConeGeometry(32, 26, 8),
      new THREE.MeshStandardMaterial({ color: 0xe8eef2, roughness: 0.9, flatShading: true })
    )
    snow.position.set(MTN.x, peakY + 6, MTN.z)
    scene.add(snow)
  }

  // mist sprites at the plunge pool
  const mists = []
  {
    const mistTex = makeMistTexture()
    for (let k = 0; k < 3; k++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: mistTex, transparent: true, opacity: 0.35, depthWrite: false,
      }))
      sp.position.set(MTN.x - 8 + k * 8, POOL_Y + 3, 214 + (k % 2) * 5)
      sp.userData.base = 11 + k * 3
      scene.add(sp)
      mists.push(sp)
    }
  }

  function updateWater(dt, t) {
    fallTex.offset.y += 1.4 * dt
    riverTex.offset.y -= 0.15 * dt
    for (let k = 0; k < mists.length; k++) {
      const sp = mists[k]
      const f = 1 + 0.15 * Math.sin(t * 2 + k * 2.1)
      sp.scale.set(sp.userData.base * f, sp.userData.base * 0.6 * f, 1)
      sp.material.opacity = 0.28 + 0.14 * Math.sin(t * 1.7 + k)
    }
  }

  // highest water surface under (x, z), or -Infinity if over dry land
  function waterSurfaceAt(x, z) {
    let y = -Infinity
    const pdx = x - POND.x, pdz = z - POND.z
    if (pdx * pdx + pdz * pdz < (POND.r * 0.92) ** 2) y = Math.max(y, pondWaterY)
    const qdx = x - POOL.x, qdz = z - POOL.z
    if (qdx * qdx + qdz * qdz < 17 * 17) y = Math.max(y, POOL_Y)
    const rn = riverNearest(x, z)
    if (rn.d < 9) y = Math.max(y, riverY[rn.i])
    return y
  }

  // dirt access track under the line (corridor is flat)
  const track = new THREE.Mesh(
    new THREE.PlaneGeometry(LINE_LEN + 220, 9),
    new THREE.MeshStandardMaterial({ color: 0x9d8a63, roughness: 1 })
  )
  track.rotation.x = -Math.PI / 2
  track.position.y = 0.05
  scene.add(track)

  // distant mountain ring
  {
    const mat = new THREE.MeshStandardMaterial({ color: 0x62798b, roughness: 1, flatShading: true })
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + drand() * 0.2
      const dist = 1000 + drand() * 500
      const h = 110 + drand() * 150
      const r = 130 + drand() * 150
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5 + Math.floor(drand() * 3)), mat)
      m.position.set(Math.cos(a) * dist, h / 2 - 25, Math.sin(a) * dist)
      m.rotation.y = drand() * Math.PI
      scene.add(m)
    }
  }

  // Structures go down before vegetation so trees never sprout inside a hangar.
  // This shifts the RNG sequence, so the tree layout differs from before — still
  // fully deterministic, just a different (and now building-aware) scatter.
  const { colliders: structures, footprints: structureFootprints, safehouse } =
    buildStructures(scene, drand, ZONE)
  // the race arena claims its plot too — no forest growing through the circuit
  structureFootprints.push({ x: RACE_C.x, z: RACE_C.z, r: 165 })
  const treeColliders = scatterVegetation(scene, drand, structureFootprints)

  // -- sightlines ------------------------------------------------------------
  // Foliage occludes optics but not radar, so trees are kept as a separate set:
  // that is what makes the compound's buildings matter more than the treeline.
  const treeShapes = treeColliders.map((tc) => ({
    kind: 'cyl', x: tc.x, z: tc.z, r: tc.r, bound: tc.r,
    y0: terrainHeight(tc.x, tc.z), y1: tc.top,
  }))

  // Broad-phase on a 2D bbox plus a height reject — most shapes are below a
  // segment between two airborne drones and fall out on the first comparison.
  function occludedBy(shapes, ax, ay, az, bx, by, bz) {
    const minY = Math.min(ay, by)
    const loX = Math.min(ax, bx)
    const hiX = Math.max(ax, bx)
    const loZ = Math.min(az, bz)
    const hiZ = Math.max(az, bz)
    for (const sh of shapes) {
      if (minY > sh.y1) continue
      const b = sh.bound
      if (sh.x + b < loX || sh.x - b > hiX || sh.z + b < loZ || sh.z - b > hiZ) continue
      if (segmentHitsShape(ax, ay, az, bx, by, bz, sh)) return true
    }
    return false
  }

  // Hills and the mountain break tracking exactly like a wall does.
  function terrainBlocks(ax, ay, az, bx, by, bz) {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const steps = Math.min(40, Math.max(2, Math.ceil(Math.hypot(dx, dz) / 5)))
    for (let i = 1; i < steps; i++) {
      const f = i / steps
      if (ay + dy * f < terrainHeight(ax + dx * f, az + dz * f)) return true
    }
    return false
  }

  function hasLineOfSight(from, to, throughFoliage = false) {
    if (occludedBy(structures, from.x, from.y, from.z, to.x, to.y, to.z)) return false
    if (!throughFoliage &&
        occludedBy(treeShapes, from.x, from.y, from.z, to.x, to.y, to.z)) return false
    return !terrainBlocks(from.x, from.y, from.z, to.x, to.y, to.z)
  }


  // -- inspectable parts registry ------------------------------------------
  const parts = []

  function registerPart(group, { id, type, label, towerRef }) {
    const fault = rand() < FAULT_RATE
    const notes = FAULT_NOTES[type]
    const mats = []
    group.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone()
        mats.push(o.material)
      }
    })
    const pos = new THREE.Vector3()
    group.updateWorldMatrix(true, false)
    new THREE.Box3().setFromObject(group).getCenter(pos)
    parts.push({
      id, type, label, towerRef,
      status: fault ? 'FAULT' : 'OK',
      note: fault ? notes[Math.floor(rand() * notes.length)] : 'Nominal',
      pos, mats, detected: false,
    })
  }

  // -- towers + wires -------------------------------------------------------
  const steel = new THREE.MeshStandardMaterial({ color: 0x7f8a94, metalness: 0.8, roughness: 0.45 })
  const insulatorMat = new THREE.MeshStandardMaterial({ color: 0x3f5d3a, roughness: 0.6 })
  const wireMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, metalness: 0.7, roughness: 0.5 })
  const damperMat = new THREE.MeshStandardMaterial({ color: 0x22262a, metalness: 0.6, roughness: 0.5 })
  const spliceMat = new THREE.MeshStandardMaterial({ color: 0x8f9aa5, metalness: 0.9, roughness: 0.3 })

  const ARMS = [[28, 7.5], [34, 6.5], [40, 5.5]]
  const attach = []
  const towerXs = []

  for (let t = 0; t < TOWERS; t++) {
    const x = X0 + t * SPAN
    towerXs.push(x)
    const tower = buildTower(steel)
    tower.position.set(x, 0, 0)
    scene.add(tower)

    const pts = []
    ARMS.forEach(([h, hw], lvl) => {
      for (const side of [-1, 1]) {
        const ins = buildInsulator(insulatorMat)
        ins.position.set(x, h - 0.4, side * hw)
        scene.add(ins)
        registerPart(ins, {
          id: `INS-T${t + 1}-L${lvl + 1}${side < 0 ? 'A' : 'B'}`,
          type: 'insulator',
          label: 'Suspension insulator',
          towerRef: `Tower ${t + 1}`,
        })
        pts.push(new THREE.Vector3(x, h - 3.2, side * hw))
      }
    })
    pts.push(new THREE.Vector3(x, 45.6, -1.4))
    pts.push(new THREE.Vector3(x, 45.6, 1.4))
    attach.push(pts)
  }

  // conductors between towers; sample points collected for collision checks
  const wireSamples = []
  for (let s = 0; s < TOWERS - 1; s++) {
    for (let w = 0; w < attach[s].length; w++) {
      const a = attach[s][w]
      const b = attach[s + 1][w]
      const shield = w >= 6
      const sag = shield ? 4 : 7.5
      const mid = a.clone().add(b).multiplyScalar(0.5)
      mid.y -= sag
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b)
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 40, shield ? 0.05 : 0.09, 6),
        wireMat
      )
      scene.add(tube)
      for (let i = 0; i <= 48; i++) wireSamples.push(curve.getPoint(i / 48))

      if (!shield) {
        for (const tt of [0.05, 0.95]) {
          const d = buildDamper(damperMat)
          d.position.copy(curve.getPoint(tt))
          d.lookAt(curve.getPoint(tt + 0.01))
          scene.add(d)
          registerPart(d, {
            id: `DMP-S${s + 1}-W${w + 1}${tt < 0.5 ? 'A' : 'B'}`,
            type: 'damper',
            label: 'Vibration damper',
            towerRef: `Span ${s + 1}–${s + 2}`,
          })
        }
        if (rand() < 0.4) {
          const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 2.2, 10), spliceMat)
          sp.position.copy(curve.getPoint(0.5))
          sp.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            curve.getTangent(0.5).normalize()
          )
          scene.add(sp)
          registerPart(sp, {
            id: `SPL-S${s + 1}-W${w + 1}`,
            type: 'splice',
            label: 'Splice sleeve',
            towerRef: `Span ${s + 1}–${s + 2}`,
          })
        }
      }
    }
  }

  // -- drone ----------------------------------------------------------------
  const drone = new THREE.Group()
  const droneTilt = new THREE.Group()
  drone.add(droneTilt)
  drone.position.set(X0 - 25, 26, 22)
  scene.add(drone)

  let rotors = []
  new GLTFLoader().load(
    '/models/drone.glb',
    (gltf) => {
      const m = gltf.scene
      const box = new THREE.Box3().setFromObject(m)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const s = 2.6 / Math.max(size.x, size.z, 0.001)
      m.scale.setScalar(s)
      m.position.sub(center.multiplyScalar(s))
      m.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true
          if (/prop|rotor|blade|fan/i.test(o.name)) rotors.push(o)
        }
      })
      droneTilt.add(m)
      onReady?.('Drone — NateGazzard (poly.pizza, CC-BY)')
    },
    undefined,
    () => {
      const { group, props } = buildFallbackDrone()
      rotors = props
      droneTilt.add(group)
      onReady?.('procedural drone (model download unavailable)')
    }
  )

  // nav lights: steady red (port) / green (starboard) + white strobe
  const navLights = []
  {
    const mk = (hex, x, z, r) => {
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(r, 8, 6),
        new THREE.MeshBasicMaterial({ color: hdr(hex, 3.2) })
      )
      bulb.position.set(x, -0.15, z)
      droneTilt.add(bulb)
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: hdr(hex, 2.2), transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }))
      halo.scale.setScalar(r * 5)
      bulb.add(halo)
      navLights.push({ bulb, halo })
      return { bulb, halo }
    }
    mk(0xff2a2a, 1.25, 0.5, 0.11)    // port  (local +x is the aircraft's left)
    mk(0x22ee55, -1.25, 0.5, 0.11)   // starboard
    mk(0xffffff, 0, -1.25, 0.13)     // tail strobe
  }
  const strobeBulb = navLights[2].bulb
  const strobeHalo = navLights[2].halo

  // -- particle pools: sparks, smoke ----------------------------------------
  function makePool(n, texture, blending, useFog, gain = 1) {
    const items = []
    for (let i = 0; i < n; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture, transparent: true, depthWrite: false,
        blending, fog: useFog, opacity: 0,
      }))
      sp.visible = false
      scene.add(sp)
      items.push({ sp, life: 0, max: 1, vel: new THREE.Vector3(), s0: 1, s1: 1, o0: 1, grav: 0 })
    }
    let cur = 0
    return {
      spawn(pos, vel, o) {
        const it = items[cur]
        cur = (cur + 1) % n
        it.sp.visible = true
        it.sp.position.copy(pos)
        it.vel.copy(vel)
        it.life = it.max = o.life
        it.s0 = o.s0; it.s1 = o.s1; it.o0 = o.o0; it.grav = o.grav || 0
        it.sp.material.color.setHex(o.color).multiplyScalar(gain)
        it.sp.material.opacity = o.o0
        it.sp.scale.set(o.s0, o.s0, 1)
      },
      update(dt) {
        for (const it of items) {
          if (it.life <= 0) continue
          it.life -= dt
          if (it.life <= 0) { it.sp.visible = false; continue }
          it.vel.y -= it.grav * dt
          it.sp.position.addScaledVector(it.vel, dt)
          const f = 1 - it.life / it.max
          const sz = THREE.MathUtils.lerp(it.s0, it.s1, f)
          it.sp.scale.set(sz, sz, 1)
          it.sp.material.opacity = it.o0 * (1 - f)
        }
      },
    }
  }

  const sparks = makePool(140, glowTex, THREE.AdditiveBlending, false, 3.0)
  const smoke = makePool(80, makeMistTexture(), THREE.NormalBlending, true)
  const sparkVel = new THREE.Vector3()

  function sparkBurst(pos, count, color, speed) {
    for (let i = 0; i < count; i++) {
      sparkVel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize().multiplyScalar(speed * (0.4 + Math.random()))
      sparks.spawn(pos, sparkVel, {
        life: 0.3 + Math.random() * 0.45, s0: 1.5, s1: 0.15,
        o0: 1, color, grav: 14,
      })
    }
  }

  const ZERO = new THREE.Vector3()
  let smokeAcc = 0

  // -- hostile territory ----------------------------------------------------
  const BEACON_GAIN = 3.0   // lit; the dark half of the blink drops back under 1
  const beaconMats = []
  {
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(ZONE.r, ZONE.r, 130, 64, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff2a2a, transparent: true, opacity: 0.07,
        side: THREE.DoubleSide, depthWrite: false,
      })
    )
    wall.position.set(ZONE.x, 55, ZONE.z)
    scene.add(wall)

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(ZONE.r, 0.9, 6, 96),
      new THREE.MeshBasicMaterial({ color: hdr(0xff2a2a, 1.8), transparent: true, opacity: 0.5 })
    )
    rim.rotation.x = Math.PI / 2
    rim.position.set(ZONE.x, 118, ZONE.z)
    scene.add(rim)

    // perimeter warning pylons with blinking beacons
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.8 })
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      const px = ZONE.x + Math.cos(a) * ZONE.r
      const pz = ZONE.z + Math.sin(a) * ZONE.r
      const py = terrainHeight(px, pz)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 14, 6), poleMat)
      pole.position.set(px, py + 7, pz)
      scene.add(pole)
      const lampMat = new THREE.MeshBasicMaterial({ color: hdr(0xff2a2a, BEACON_GAIN) })
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8), lampMat)
      lamp.position.set(px, py + 14.6, pz)
      scene.add(lamp)
      beaconMats.push(lampMat)
    }

    // enemy base at the zone centre
    const padY = terrainHeight(ZONE.x, ZONE.z)
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(20, 22, 1, 24),
      new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.9 })
    )
    pad.position.set(ZONE.x, padY + 0.5, ZONE.z)
    scene.add(pad)
    const shedMat = new THREE.MeshStandardMaterial({ color: 0x54282c, roughness: 0.8 })
    for (const [ox, oz, ry] of [[-30, 8, 0.4], [-26, -18, -0.2]]) {
      const shed = new THREE.Mesh(new THREE.BoxGeometry(12, 5, 6), shedMat)
      shed.position.set(ZONE.x + ox, terrainHeight(ZONE.x + ox, ZONE.z + oz) + 2.5, ZONE.z + oz)
      shed.rotation.y = ry
      scene.add(shed)
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 26, 6), poleMat)
    mast.position.set(ZONE.x + 24, padY + 13, ZONE.z - 6)
    scene.add(mast)
    const mastLampMat = new THREE.MeshBasicMaterial({ color: hdr(0xff2a2a, BEACON_GAIN) })
    const mastLamp = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), mastLampMat)
    mastLamp.position.set(ZONE.x + 24, padY + 26.5, ZONE.z - 6)
    scene.add(mastLamp)
    beaconMats.push(mastLampMat)
  }

  // -- mission payload: recover the cargo pod from the enemy pad -------------
  const PAD_Y = terrainHeight(ZONE.x, ZONE.z)
  const CRATE_HOME = new THREE.Vector3(ZONE.x, PAD_Y + 2.4, ZONE.z)

  const crate = new THREE.Group()
  {
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.8, 2.4),
      new THREE.MeshStandardMaterial({ color: 0xb8912f, roughness: 0.55, metalness: 0.35 })
    )
    shell.castShadow = true
    crate.add(shell)
    const trimMat = new THREE.MeshBasicMaterial({ color: hdr(0x35e0ff, 3.5) })
    for (const [w, d] of [[2.5, 0.22], [0.22, 2.5]]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), trimMat)
      crate.add(band)
    }
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.22, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.7 })
    )
    lid.position.y = 0.95
    crate.add(lid)
  }
  crate.position.copy(CRATE_HOME)
  scene.add(crate)

  const crateGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: hdr(0x35e0ff, 2.6), transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }))
  crateGlow.scale.setScalar(7)
  crateGlow.position.copy(CRATE_HOME)
  scene.add(crateGlow)

  // light column so the pod is findable from outside the zone
  const crateColumn = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 1.6, 150, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: hdr(0x35e0ff, 3.0), transparent: true, opacity: 0.12, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  )
  crateColumn.position.set(ZONE.x, PAD_Y + 75, ZONE.z)
  scene.add(crateColumn)

  // -- safehouse beacon ------------------------------------------------------
  // Stays dark until the pod is aboard: a hidden base that only signals when
  // you need it, rather than a marker on the skyline the whole game.
  const HOME_Y = safehouse.y
  const homeColumn = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 1.6, 150, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: hdr(0x21d07a, 3.0), transparent: true, opacity: 0.12, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  )
  homeColumn.position.set(SAFEHOUSE.x, HOME_Y + 75, SAFEHOUSE.z)
  homeColumn.visible = false
  scene.add(homeColumn)

  const homeGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: hdr(0x21d07a, 2.6), transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }))
  homeGlow.scale.setScalar(9)
  homeGlow.position.set(SAFEHOUSE.x, HOME_Y + 4, SAFEHOUSE.z)
  homeGlow.visible = false
  scene.add(homeGlow)

  // INBOUND -> SECURING -> CARRYING -> DELIVERING -> COMPLETE,
  // or LOST if shot down laden
  let mission = 'INBOUND'
  let secure = 0
  let deliver = 0

  function stowCrate() {
    crate.scale.setScalar(0.55)
    crate.position.set(0, -1.15, 0)
    crate.rotation.set(0, 0, 0)
    droneTilt.add(crate)
    crateGlow.visible = false
    crateColumn.visible = false
  }

  // pod winched down onto the safehouse pad
  function dropCrate() {
    droneTilt.remove(crate)
    scene.add(crate)
    crate.scale.setScalar(1)
    crate.rotation.set(0, 0, 0)
    crate.position.set(SAFEHOUSE.x, HOME_Y + 1.3, SAFEHOUSE.z)
    crateGlow.visible = false
    crateColumn.visible = false
  }

  function returnCrate() {
    droneTilt.remove(crate)
    scene.add(crate)
    crate.scale.setScalar(1)
    crate.position.copy(CRATE_HOME)
    crateGlow.position.copy(CRATE_HOME)
    crateGlow.visible = true
    crateColumn.visible = true
    secure = 0
    deliver = 0
  }

  // -- rival drones ---------------------------------------------------------
  // Each one runs PATROL -> INVESTIGATE -> SEARCH -> PURSUE off its own
  // awareness meter. Nothing here reads the player's position directly except
  // through `senseUpdate`, so cover genuinely blinds them.
  const enemies = []
  for (let i = 0; i < 3; i++) {
    const { group, props } = buildFallbackDrone(0x33161a, 0xd92626)
    group.scale.setScalar(1.15)
    const obj = new THREE.Group()
    obj.add(group)
    // overlapping circuits at different radii and altitudes, so the compound is
    // covered from several angles and the gaps move
    const route = []
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + i * 1.3
      const rr = 52 + i * 34
      const rx = ZONE.x + Math.cos(a) * rr
      const rz = ZONE.z + Math.sin(a) * rr
      route.push(new THREE.Vector3(
        rx, terrainHeight(rx, rz) + 20 + i * 7 + Math.sin(a * 2) * 6, rz
      ))
    }
    const home = route[0].clone()
    obj.position.copy(home)
    scene.add(obj)
    enemies.push({
      obj, props, home, route, leg: 0,
      vel: new THREE.Vector3(),
      cooldown: 1 + i * 0.5,
      phase: i * 2.1,       // desynchronises their search orbits
      state: 'PATROL',
      aware: 0,               // 0 oblivious -> 1 weapons-free lock
      facing: 0,              // sensor boresight, decoupled from velocity in PURSUE
      lastKnown: new THREE.Vector3(),
      hasContact: false,
      searchT: 0,
      losT: i * 0.04,         // staggered so the three LOS checks land on
      los: false,             // different frames
      visible: false,
      inRange: false,
    })
  }

  // Shared contact report. One spotter vectors the others in — hiding from the
  // drone that saw you is not the same as hiding from the squad.
  const squad = { pos: new THREE.Vector3(), has: false, at: -99, level: 0 }
  function squadReport(pos, t, level) {
    squad.pos.copy(pos)
    squad.has = true
    squad.at = t
    squad.level = Math.max(squad.level, level)
  }

  // Base radar: slow 360 sweep, long reach, sees through trees but not walls.
  const radar = { angle: 0, mast: new THREE.Vector3(ZONE.x + 24, PAD_Y + 24, ZONE.z - 6) }
  {
    // Everything hangs off one pivot whose local +x is the beam axis, so
    // pointing the sweep is a single yaw and the bearing maths stays honest.
    const pivot = new THREE.Group()
    pivot.position.copy(radar.mast)
    scene.add(pivot)
    const dish = new THREE.Mesh(
      new THREE.BoxGeometry(7, 2.6, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.4 })
    )
    dish.rotation.y = Math.PI / 2
    dish.castShadow = true
    pivot.add(dish)
    const sweep = new THREE.Mesh(
      new THREE.CircleGeometry(RADAR_RANGE, 10, -RADAR_HALF, RADAR_HALF * 2),
      new THREE.MeshBasicMaterial({
        color: 0xff5a3c, transparent: true, opacity: 0.06, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      })
    )
    sweep.rotation.x = -Math.PI / 2   // lie flat; the wedge still straddles +x
    pivot.add(sweep)
    radar.pivot = pivot
  }

  const projectiles = []
  const projGeom = new THREE.CylinderGeometry(0.11, 0.11, 3.2, 6)
  projGeom.rotateX(Math.PI / 2)   // long axis along +Z so lookAt() aims it
  const projMat = new THREE.MeshBasicMaterial({ color: hdr(0xffb060, 4.0) })
  const projHaloMat = new THREE.SpriteMaterial({
    map: glowTex, color: hdr(0xff5a28, 3.0), transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  })
  // Threat picture, recomputed each frame and read by the HUD and the debug hooks.
  let alertLevel = 0   // 0 oblivious -> 1 someone has a firing lock on you
  let eyesOn = 0       // hostiles with an unobstructed view of you right now
  let engaged = false  // at least one has a lock and is shooting
  let inCover = false  // a hostile is in range but every line to you is blocked
  let threat = 'HIDDEN'
  let integrity = 100
  let playerDown = false
  let lastDamage = -10

  function damagePlayer(amount, t) {
    if (playerDown) return
    integrity = Math.max(0, integrity - amount)
    lastDamage = t
    shake = Math.min(shake + 0.5, 1.2)
    sparkBurst(drone.position, 12, 0xffb060, 9)
    if (integrity <= 0) {
      playerDown = true
      if (mission === 'CARRYING' || mission === 'DELIVERING') {
        mission = 'LOST'
        returnCrate()
      }
    }
  }

  // scan range ring + beam
  const ringMat = new THREE.LineBasicMaterial({ color: hdr(0x35e0ff, 2.5), transparent: true, opacity: 0.35 })
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 64 }, (_, i) => {
        const a = (i / 64) * Math.PI * 2
        return new THREE.Vector3(Math.cos(a) * SCAN_RANGE, 0, Math.sin(a) * SCAN_RANGE)
      })
    ),
    ringMat
  )
  drone.add(ring)

  const beamGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])
  const beam = new THREE.Line(beamGeom, new THREE.LineBasicMaterial({ color: hdr(0x35e0ff, 2.5), transparent: true, opacity: 0.8 }))
  beam.visible = false
  scene.add(beam)

  // -- race arena ------------------------------------------------------------
  // Deliberately RNG-free: gate positions come from closed-form curves, so the
  // arena can never shift the fault or scenery layouts.
  const gates = []
  {
    const N = 9
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2
      const gx = RACE_C.x + Math.cos(a) * (108 + Math.sin(a * 2) * 16)
      const gz = RACE_C.z + Math.sin(a) * (70 + Math.cos(a * 3) * 10)
      const gy = terrainHeight(gx, gz) + 11 + Math.sin(a * 2.3) * 4
      gates.push({ x: gx, y: gy, z: gz })
    }
    // orient each ring across the local direction of travel
    for (let i = 0; i < N; i++) {
      const prev = gates[(i + N - 1) % N]
      const next = gates[(i + 1) % N]
      gates[i].heading = Math.atan2(next.x - prev.x, next.z - prev.z)
    }

    const pylonMat = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.8 })
    const ringGeo = new THREE.TorusGeometry(GATE_R, 0.45, 10, 40)
    for (let i = 0; i < N; i++) {
      const g = gates[i]
      // per-gate material so the "next gate" highlight can tint just one ring
      g.mat = new THREE.MeshBasicMaterial({ color: hdr(0xff8c2a, 1.2) })
      const ring = new THREE.Mesh(ringGeo, g.mat)
      ring.position.set(g.x, g.y, g.z)
      ring.rotation.y = g.heading
      scene.add(ring)
      const groundY = terrainHeight(g.x, g.z)
      const pylon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.5, g.y - GATE_R - groundY, 6), pylonMat
      )
      pylon.position.set(g.x, (groundY + g.y - GATE_R) / 2, g.z)
      scene.add(pylon)
    }

  }

  // the paddock, pits and grandstands — real racetrack furniture, loaded from
  // the Kenney Racing Kit (CC0)
  buildRaceVenue(scene, structures)

  // beacon column marking the player's next gate while racing
  const gateColumn = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 90, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: hdr(0x35e0ff, 3.0), transparent: true, opacity: 0.14, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  )
  gateColumn.visible = false
  scene.add(gateColumn)

  const RACER_DEFS = [
    { name: 'VIPER', color: 0xff3b30, speed: 19.8 },
    { name: 'ONYX', color: 0x9b59ff, speed: 18.8 },
    { name: 'FALCON', color: 0xffd23c, speed: 17.8 },
  ]
  const racers = RACER_DEFS.map((d, i) => {
    const { group, props } = buildFallbackDrone(0x22262c, d.color)
    group.scale.setScalar(1.1)
    const obj = new THREE.Group()
    obj.add(group)
    // parked on the paddock apron beside the pits between races
    obj.position.set(
      VENUE.x - 10,
      terrainHeight(VENUE.x - 10, VENUE.z + 26 + i * 7) + 1.2,
      VENUE.z + 26 + i * 7
    )
    scene.add(obj)
    return {
      ...d, obj, props,
      vel: new THREE.Vector3(),
      nextGate: 1, lap: 0, gatesPassed: 0,
      finished: false, finishT: 0, prog: 0,
      phase: i * 2.3,
    }
  })

  // IDLE -> COUNTDOWN -> RACING -> DONE (player crossed the finish)
  const race = {
    state: 'IDLE',
    countEnd: 0, t0: 0, lapStart: 0,
    lap: 0, laps: [], best: null, total: null,
    nextGate: 1, gatesPassed: 0, nextDist: 0,
    pos: 1, standings: [],
    prevPos: new THREE.Vector3(), prevYaw: 0,
    startPos: new THREE.Vector3(),
  }

  function enterRace() {
    race.prevPos.copy(drone.position)
    race.prevYaw = yaw
    const g = gates[0]
    const fx0 = Math.sin(g.heading), fz0 = Math.cos(g.heading)   // travel dir
    const px0 = Math.cos(g.heading), pz0 = -Math.sin(g.heading)  // across it
    race.startPos.set(g.x - fx0 * 12, g.y, g.z - fz0 * 12)
    drone.position.copy(race.startPos)
    vel.set(0, 0, 0)
    yaw = g.heading
    race.state = 'COUNTDOWN'
    race.countEnd = clock.elapsedTime + COUNTDOWN
    race.lap = 0
    race.laps = []
    race.best = null
    race.total = null
    race.nextGate = 1
    race.gatesPassed = 0
    racers.forEach((r, i) => {
      const off = (i % 2 ? -1 : 1) * (4.5 + Math.floor(i / 2) * 4.5)
      r.obj.position.set(
        race.startPos.x + px0 * off,
        race.startPos.y,
        race.startPos.z + pz0 * off
      )
      r.obj.rotation.y = g.heading
      r.vel.set(0, 0, 0)
      r.nextGate = 1
      r.lap = 0
      r.gatesPassed = 0
      r.finished = false
      r.finishT = 0
      r.prog = 0
    })
  }

  function exitRace() {
    race.state = 'IDLE'
    gateColumn.visible = false
    drone.position.copy(race.prevPos)
    vel.set(0, 0, 0)
    yaw = race.prevYaw
    racers.forEach((r, i) => {
      r.obj.position.set(
        VENUE.x - 10,
        terrainHeight(VENUE.x - 10, VENUE.z + 26 + i * 7) + 1.2,
        VENUE.z + 26 + i * 7
      )
      r.vel.set(0, 0, 0)
    })
  }

  function updateRace(dt, t) {
    const p2 = drone.position

    if (race.state === 'COUNTDOWN') {
      vel.set(0, 0, 0)
      drone.position.copy(race.startPos)
      if (t >= race.countEnd) {
        race.state = 'RACING'
        race.t0 = t
        race.lapStart = t
      }
    }

    const running = race.state === 'RACING' || race.state === 'DONE'

    // player checkpoints
    if (race.state === 'RACING' && !playerDown) {
      const g = gates[race.nextGate]
      const d = Math.hypot(p2.x - g.x, p2.y - g.y, p2.z - g.z)
      race.nextDist = d
      if (d < GATE_PASS) {
        if (race.nextGate === 0) {
          const lapT = t - race.lapStart
          race.laps.push(lapT)
          race.best = race.best === null ? lapT : Math.min(race.best, lapT)
          race.lapStart = t
          race.lap++
          if (race.lap >= RACE_LAPS) {
            race.state = 'DONE'
            race.total = t - race.t0
          }
        }
        race.gatesPassed++
        race.nextGate = (race.nextGate + 1) % gates.length
      }
    }

    // AI racers
    for (const r of racers) {
      if (!running) { continue }
      const target = TMP_TGT
      let maxV
      if (r.finished) {
        // victory-lap orbit above the arena, out of the racing line
        const a = t * 0.4 + r.phase
        target.set(
          RACE_C.x + Math.cos(a) * 45,
          terrainHeight(RACE_C.x, RACE_C.z) + 34,
          RACE_C.z + Math.sin(a) * 45
        )
        maxV = 9
      } else {
        const g = gates[r.nextGate]
        // a little wander so each racer flies its own line through the ring
        target.set(
          g.x + Math.sin(t * 0.7 + r.phase) * 2.5,
          g.y + Math.cos(t * 0.9 + r.phase) * 1.5,
          g.z + Math.cos(t * 0.7 + r.phase) * 2.5
        )
        // pace breathes a few percent so the field trades places
        maxV = r.speed * (0.95 + 0.07 * Math.sin(t * 0.31 + r.phase))
      }
      TMP_DIR.subVectors(target, r.obj.position)
      if (TMP_DIR.lengthSq() > 0.01) TMP_DIR.normalize()
      r.vel.addScaledVector(TMP_DIR, 36 * dt)
      r.vel.multiplyScalar(Math.exp(-2 * dt))
      if (r.vel.length() > maxV) r.vel.setLength(maxV)
      r.obj.position.addScaledVector(r.vel, dt)
      const floor = terrainHeight(r.obj.position.x, r.obj.position.z) + 2
      if (r.obj.position.y < floor) {
        r.obj.position.y = floor
        if (r.vel.y < 0) r.vel.y = 0
      }
      if (r.vel.lengthSq() > 1) r.obj.rotation.y = Math.atan2(r.vel.x, r.vel.z)
      for (const pr of r.props) pr.rotation.y += 50 * dt

      if (!r.finished) {
        const g = gates[r.nextGate]
        const d = r.obj.position.distanceTo(target.set(g.x, g.y, g.z))
        r.prog = r.gatesPassed * 1e4 - d
        if (d < AI_GATE_PASS) {
          if (r.nextGate === 0) {
            r.lap++
            if (r.lap >= RACE_LAPS) {
              r.finished = true
              r.finishT = t - race.t0
            }
          }
          r.gatesPassed++
          r.nextGate = (r.nextGate + 1) % gates.length
        }
      }
    }

    // standings: finished racers rank by time, the rest by course progress
    if (running) {
      const myProg = race.gatesPassed * 1e4 - race.nextDist
      race.standings = [
        { name: 'YOU', prog: myProg, done: race.state === 'DONE', time: race.total },
        ...racers.map((r) => ({ name: r.name, prog: r.prog, done: r.finished, time: r.finishT })),
      ].sort((a, b) => (b.done - a.done) || (a.done ? a.time - b.time : b.prog - a.prog))
      race.pos = race.standings.findIndex((s) => s.name === 'YOU') + 1
    }

    // gate dressing: the player's next ring burns cyan, the finish line green
    const racing = race.state === 'RACING'
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i]
      if (racing && i === race.nextGate) {
        g.mat.color.setHex(0x35e0ff).multiplyScalar(2.4 + Math.sin(t * 6) * 0.8)
      } else if (i === 0) {
        g.mat.color.setHex(0x21d07a).multiplyScalar(1.6)
      } else {
        g.mat.color.setHex(0xff8c2a).multiplyScalar(racing ? 0.55 : 1.2)
      }
    }
    gateColumn.visible = racing
    if (racing) {
      const g = gates[race.nextGate]
      gateColumn.position.set(g.x, terrainHeight(g.x, g.z) + 45, g.z)
    }
  }

  // -- input ----------------------------------------------------------------
  const keys = {}
  const onKey = (e) => {
    if (e.repeat) return
    keys[e.code] = e.type === 'keydown'
    if (e.type !== 'keydown') return
    // Time of day is edge-triggered rather than polled in the frame loop: each
    // press is one step, so holding the key does not run the clock away.
    if (e.code === 'Enter') {
      if (race.state !== 'IDLE') exitRace()
      else if (Math.hypot(drone.position.x - RACE_C.x, drone.position.z - RACE_C.z) < ARENA_ENTER_R) {
        // you have to show up to race — no starting from the far side of the map
        enterRace()
      }
    }
    else if (e.code === 'BracketLeft') atmos.setHour(atmos.hour - 0.5)
    else if (e.code === 'BracketRight') atmos.setHour(atmos.hour + 0.5)
    else if (e.code === 'Backslash') atmos.setCycle(atmos.cycling ? 0 : CYCLE_RATE)
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    fx.setSize(window.innerWidth, window.innerHeight)
  }
  window.addEventListener('resize', onResize)

  // -- collision state -------------------------------------------------------
  const vel = new THREE.Vector3()
  let yaw = Math.PI / 2
  let shake = 0
  let hits = 0
  let lastHit = -10

  // n = collision normal pointing away from obstacle, push = penetration depth
  function bounce(n, push, t) {
    drone.position.addScaledVector(n, push)
    const vn = vel.dot(n)
    if (vn < 0) {
      vel.addScaledVector(n, -vn * 1.35)
      if (vn < -1.5 && t - lastHit > 0.6) {
        hits++
        lastHit = t
        shake = Math.min(shake + 0.7, 1.2)
        sparkBurst(drone.position, 10, 0xffd890, 7)
        damagePlayer(4, t)
      } else {
        shake = Math.min(shake + 0.2, 1.2)
      }
    }
  }

  if (typeof window !== 'undefined' && location.hostname === 'localhost') {
    window.__droneDebug = {
      setPos: (x, y, z) => drone.position.set(x, y, z),
      setYaw: (v) => { yaw = v },
      getPos: () => drone.position.toArray(),
      getHits: () => hits,
      getMission: () => ({
        mission, secure, deliver, integrity: Math.round(integrity), down: playerDown,
      }),
      safehouse: () => ({ x: SAFEHOUSE.x, y: HOME_Y, z: SAFEHOUSE.z }),
      getExposure: () => ({ threat, exposure: alertLevel, eyesOn, inCover, squad: squad.has }),
      getEnemyStates: () => enemies.map((e) => ({
        state: e.state, aware: +e.aware.toFixed(2), visible: e.visible,
        pos: e.obj.position.toArray().map((v) => +v.toFixed(1)),
      })),
      losTo: (x, y, z) => hasLineOfSight(drone.position, new THREE.Vector3(x, y, z)),
      structures: () => structures.length,
      getStructures: () => structures.map((sh) => ({ ...sh })),
      getClock: () => ({ t: clock.elapsedTime, frames, radar: radar.angle }),
      // per-rival ground truth: distance, whether the sightline is actually
      // clear, and what the AI currently believes it can see
      enemyLos: () => enemies.map((e) => ({
        state: e.state,
        dist: +e.obj.position.distanceTo(drone.position).toFixed(1),
        los: hasLineOfSight(e.obj.position, drone.position),   // fresh, right now
        losCached: e.los,   // what the throttled sensor last sampled (<=120ms old)
        visible: e.visible,
        aware: +e.aware.toFixed(2),
      })),
      setKey: (code, v) => { keys[code] = v },
      getRace: () => ({
        state: race.state, lap: race.lap, laps: race.laps.slice(),
        nextGate: race.nextGate, gatesPassed: race.gatesPassed,
        pos: race.pos, total: race.total,
        standings: race.standings.map((s) => ({ ...s })),
        racers: racers.map((r) => ({
          name: r.name, lap: r.lap, nextGate: r.nextGate, finished: r.finished,
          pos: r.obj.position.toArray().map((v) => +v.toFixed(1)),
        })),
      }),
      toggleRace: () => { race.state === 'IDLE' ? enterRace() : exitRace() },
      getGates: () => gates.map((g) => ({
        x: +g.x.toFixed(1), y: +g.y.toFixed(1), z: +g.z.toFixed(1),
      })),
    }
  }

  // -- loop -----------------------------------------------------------------
  const up = new THREE.Vector3(0, 1, 0)
  const TMP_EYE = new THREE.Vector3()
  const TMP_TGT = new THREE.Vector3()
  const TMP_DIR = new THREE.Vector3()
  const TMP_PREV = new THREE.Vector3()
  const TMP_SEP = new THREE.Vector3()
  const TMP_N = new THREE.Vector3()
  const TMP_MARK = new THREE.Vector3()
  const clock = new THREE.Clock()
  let telemAcc = 0
  let frames = 0
  let raf = 0
  let disposed = false

  function animate() {
    if (disposed) return
    raf = requestAnimationFrame(animate)
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime
    frames++

    // movement -------------------------------------------------------------
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    const right = new THREE.Vector3().crossVectors(forward, up)
    const acc = new THREE.Vector3()
    if (!playerDown && race.state !== 'COUNTDOWN') {
      if (keys.KeyW) acc.add(forward)
      if (keys.KeyS) acc.sub(forward)
      if (keys.KeyD) acc.add(right)
      if (keys.KeyA) acc.sub(right)
      if (keys.Space) acc.y += 1
      if (keys.ShiftLeft || keys.ShiftRight) acc.y -= 1
      if (acc.lengthSq() > 0) acc.normalize().multiplyScalar(45.6)
      if (keys.KeyQ || keys.ArrowLeft) yaw += 1.6 * dt
      if (keys.KeyE || keys.ArrowRight) yaw -= 1.6 * dt
    } else {
      acc.y -= 30 // shot down: gravity takes over
      yaw += 2.5 * dt
      if (keys.KeyR) {
        // a crash ends the race; redeploy is back at the powerline spawn
        if (race.state !== 'IDLE') exitRace()
        drone.position.set(X0 - 25, 26, 22)
        vel.set(0, 0, 0)
        integrity = 100
        playerDown = false
        shake = 0
        // wipe the threat picture too, or you redeploy into a squad that is
        // still hunting the wreck of your last airframe
        alertLevel = 0
        squad.has = false
        squad.level = 0
        squad.at = -99
        for (const e of enemies) {
          e.state = 'PATROL'
          e.aware = 0
          e.hasContact = false
          e.searchT = 0
          e.los = false
          e.visible = false
          e.inRange = false
        }
        if (mission !== 'COMPLETE') { mission = 'INBOUND'; secure = 0; deliver = 0 }
      }
    }

    vel.addScaledVector(acc, dt)
    vel.multiplyScalar(Math.exp(-2.2 * dt))
    if (vel.length() > 20.84) vel.setLength(20.84) // 75 km/h
    drone.position.addScaledVector(vel, dt)
    drone.position.y = Math.min(drone.position.y, 140)
    drone.rotation.y = yaw

    // collisions -----------------------------------------------------------
    let obstacle = Infinity
    const p = drone.position

    // terrain / water surface
    const groundY = Math.max(terrainHeight(p.x, p.z), waterSurfaceAt(p.x, p.z)) + 1.1
    if (p.y < groundY) {
      p.y = groundY
      if (vel.y < 0) {
        if (vel.y < -3 && t - lastHit > 0.6) { hits++; lastHit = t; shake = Math.min(shake + 0.6, 1.2) }
        vel.y = -vel.y * 0.3
      }
    }
    // towers (tapered square body approximated as tapered cylinder)
    for (const tx of towerXs) {
      const dx = p.x - tx
      const dz = p.z
      const dHoriz = Math.sqrt(dx * dx + dz * dz)
      if (dHoriz > 30 || p.y > 48) continue
      const bodyR = THREE.MathUtils.lerp(5.9, 1.6, THREE.MathUtils.clamp(p.y / 45, 0, 1)) + 1.2
      obstacle = Math.min(obstacle, dHoriz - bodyR)
      if (dHoriz < bodyR) {
        const inv = 1 / Math.max(dHoriz, 0.001)
        bounce(new THREE.Vector3(dx * inv, 0, dz * inv), bodyR - dHoriz, t)
      }
    }

    // wires (only bother near the corridor at conductor heights)
    if (Math.abs(p.z) < 24 && p.y > 14 && Math.abs(p.x) < LINE_LEN / 2 + 40) {
      const hitR = 1.0
      for (const wp of wireSamples) {
        const dx = p.x - wp.x
        if (dx > 8 || dx < -8) continue
        const dy = p.y - wp.y
        const dz = p.z - wp.z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        obstacle = Math.min(obstacle, d - 0.1)
        if (d < hitR) {
          const inv = 1 / Math.max(d, 0.001)
          bounce(new THREE.Vector3(dx * inv, dy * inv, dz * inv), hitR - d, t)
        }
      }
    }

    // trees
    for (const tc of treeColliders) {
      const dx = p.x - tc.x
      const dz = p.z - tc.z
      if (dx > 12 || dx < -12 || dz > 12 || dz < -12 || p.y > tc.top) continue
      const dHoriz = Math.sqrt(dx * dx + dz * dz)
      obstacle = Math.min(obstacle, dHoriz - tc.r)
      if (dHoriz < tc.r) {
        const inv = 1 / Math.max(dHoriz, 0.001)
        bounce(new THREE.Vector3(dx * inv, 0, dz * inv), tc.r - dHoriz, t)
      }
    }

    // structures: the hard cover. Resolved on the shallowest axis including Y,
    // so a roof catches you instead of shoving you off sideways.
    for (const sh of structures) {
      if (p.y > sh.y1 + 8) continue
      const b = sh.bound + 8
      if (Math.abs(p.x - sh.x) > b || Math.abs(p.z - sh.z) > b) continue
      const out = pushOutOfShape(p.x, p.y, p.z, sh, 1.4)
      if (!out) {
        obstacle = Math.min(obstacle, distanceToShape(p.x, p.y, p.z, sh))
      } else if (out.y === 1) {
        // touching down on a roof: settle, don't ricochet
        p.y += out.depth
        if (vel.y < 0) {
          if (vel.y < -3 && t - lastHit > 0.6) {
            hits++
            lastHit = t
            shake = Math.min(shake + 0.6, 1.2)
            damagePlayer(3, t)
          }
          vel.y = -vel.y * 0.25
        }
      } else {
        bounce(TMP_N.set(out.x, out.y, out.z), out.depth, t)
      }
    }

    updateWater(dt, t)

    // hostile territory ----------------------------------------------------
    const zdx = p.x - ZONE.x
    const zdz = p.z - ZONE.z
    const zoneDist = Math.sqrt(zdx * zdx + zdz * zdz)
    // Crossing the perimeter no longer makes them omniscient — it only puts you
    // inside their patrol envelope. Being seen is what starts a fight.
    const inZone = zoneDist < ZONE.r

    const blink = alertLevel > 0.5 ? 10 : alertLevel > 0.05 ? 6 : 3
    for (const lamp of beaconMats) {
      const lit = Math.sin(t * blink) > 0
      lamp.color.setHex(lit ? 0xff2a2a : 0x551111).multiplyScalar(lit ? BEACON_GAIN : 1)
    }

    // mission ---------------------------------------------------------------
    const padDist = Math.hypot(p.x - ZONE.x, p.z - ZONE.z)
    const homeDist = Math.hypot(p.x - SAFEHOUSE.x, p.z - SAFEHOUSE.z)
    const laden = mission === 'CARRYING' || mission === 'DELIVERING'

    // the safehouse lights its beacon only while you are actually hauling
    homeColumn.visible = laden
    homeGlow.visible = laden
    if (laden) {
      const hp = 0.5 + 0.5 * Math.sin(t * 3)
      homeColumn.material.opacity = 0.09 + 0.07 * hp
      homeGlow.material.opacity = 0.35 + 0.3 * hp
      homeGlow.scale.setScalar(8 + 2.5 * hp)
    }

    if (mission === 'INBOUND' || mission === 'SECURING') {
      crate.rotation.y += 0.5 * dt
      crate.position.y = CRATE_HOME.y + Math.sin(t * 1.6) * 0.35
      crateGlow.position.copy(crate.position)
      const pulse = 0.5 + 0.5 * Math.sin(t * 3)
      crateGlow.material.opacity = 0.4 + 0.3 * pulse
      crateGlow.scale.setScalar(6 + 2 * pulse)
      crateColumn.material.opacity = 0.09 + 0.07 * pulse

      const overPad = !playerDown && padDist < PICKUP_R &&
        p.y > PAD_Y && p.y - PAD_Y < PICKUP_CEIL
      if (overPad) {
        mission = 'SECURING'
        secure = Math.min(1, secure + dt / SECURE_TIME)
        // winch sparks while the grapple hauls the pod up
        if (Math.random() < dt * 14) {
          sparks.spawn(crate.position, new THREE.Vector3(
            (Math.random() - 0.5) * 3, 4 + Math.random() * 3, (Math.random() - 0.5) * 3
          ), { life: 0.4, s0: 1.2, s1: 0.1, o0: 0.9, color: 0x8fefff, grav: 2 })
        }
        if (secure >= 1) { mission = 'CARRYING'; stowCrate() }
      } else if (secure > 0) {
        secure = Math.max(0, secure - dt * 0.7)
        if (secure === 0) mission = 'INBOUND'
      }
    } else if (laden) {
      // Hold over the safehouse pad, under its roof, to winch the pod down.
      // Deliberately ungated on pursuit: breaking contact is now a survival
      // problem, not a win condition — you can deliver hot if you can live
      // through the trip.
      const overPad = !playerDown && homeDist < DROP_R &&
        p.y > HOME_Y && p.y - HOME_Y < DROP_CEIL
      if (overPad) {
        mission = 'DELIVERING'
        deliver = Math.min(1, deliver + dt / DELIVER_TIME)
        if (Math.random() < dt * 14) {
          sparks.spawn(drone.position, new THREE.Vector3(
            (Math.random() - 0.5) * 3, -1 - Math.random() * 2, (Math.random() - 0.5) * 3
          ), { life: 0.4, s0: 1.2, s1: 0.1, o0: 0.9, color: 0x8fffc4, grav: 4 })
        }
        if (deliver >= 1) {
          mission = 'COMPLETE'
          dropCrate()
        }
      } else if (deliver > 0) {
        deliver = Math.max(0, deliver - dt * 0.7)
        if (deliver === 0) mission = 'CARRYING'
      }
    }

    // -- rival sensors and AI ----------------------------------------------
    const playerEye = TMP_EYE.copy(drone.position)
    const playerAgl = p.y - terrainHeight(p.x, p.z)
    const playerSpd = vel.length()
    // the pod is loud: the winch, then the beacon you are hauling around
    const noise = mission === 'SECURING' ? 2 : mission === 'CARRYING' ? 2.6 : 1

    // base radar: slow sweep, long reach, blind to walls but not to trees
    radar.angle = (radar.angle + RADAR_SPEED * dt) % (Math.PI * 2)
    radar.pivot.rotation.y = radar.angle - Math.PI / 2
    if (!playerDown) {
      const rdx = p.x - radar.mast.x
      const rdz = p.z - radar.mast.z
      if (Math.hypot(rdx, rdz) < RADAR_RANGE) {
        const da = Math.atan2(rdx, rdz) - radar.angle
        if (Math.abs(Math.atan2(Math.sin(da), Math.cos(da))) < RADAR_HALF &&
            hasLineOfSight(radar.mast, playerEye, true)) {
          squadReport(playerEye, t, 0.55)
        }
      }
    }

    for (const e of enemies) {
      // --- sense -----------------------------------------------------------
      TMP_DIR.subVectors(playerEye, e.obj.position)
      const dist = TMP_DIR.length()
      let visible = false
      let boresight = 0
      const inRange = !playerDown && dist > 0.01 && dist < SENSE_RANGE
      if (inRange) {
        // The sightline is tracked whenever you are in range, independent of
        // where this drone happens to be looking. Seeing you needs both, but
        // the HUD's IN COVER tag has to distinguish "a wall is hiding me" from
        // "it just happens to be facing the other way".
        e.losT -= dt
        if (e.losT <= 0) {
          e.losT = 0.12                   // ~8 Hz, staggered across the squad
          e.los = hasLineOfSight(e.obj.position, playerEye)
        }
        TMP_DIR.divideScalar(dist)
        // The cone constrains bearing only — their sensors gimbal in pitch, so
        // climbing directly overhead is not a way to disappear. Altitude still
        // costs you below, through the detection-rate modifier.
        const hlen = Math.hypot(TMP_DIR.x, TMP_DIR.z)
        const cosA = hlen > 1e-3
          ? (TMP_DIR.x * Math.sin(e.facing) + TMP_DIR.z * Math.cos(e.facing)) / hlen
          : 1
        if (cosA > FOV_COS) {
          boresight = (cosA - FOV_COS) / (1 - FOV_COS)
          visible = e.los
        }
      } else {
        e.los = false
        e.losT = 0
      }
      e.inRange = inRange
      e.visible = visible

      if (visible) {
        const prox = 1 - dist / SENSE_RANGE
        let rate = 0.3 + 1.6 * prox * prox + 0.45 * boresight
        rate *= 1 + Math.min(playerSpd / 20.84, 1) * 0.9              // motion betrays you
        rate *= 1 + THREE.MathUtils.clamp(playerAgl / 60, 0, 1) * 0.7 // so does altitude
        e.aware = Math.min(1, e.aware + rate * noise * dt)
        if (e.aware > AWARE_HUNT) {
          e.lastKnown.copy(playerEye)
          e.hasContact = true
          if (e.aware > 0.6) squadReport(playerEye, t, 0.6)
        }
      } else {
        const decay = e.state === 'PURSUE' ? 0.24 : e.state === 'SEARCH' ? 0.14 : 0.32
        e.aware = Math.max(0, e.aware - decay * dt)
      }

      // A radioed contact sends wingmates to look, but never past "go and
      // look" — only a drone's own eyes unlock its weapons.
      if (squad.has && t - squad.at < SQUAD_MEMORY && !visible &&
          e.state === 'PATROL' && e.aware < AWARE_HUNT) {
        e.aware = AWARE_HUNT + 0.02
        e.lastKnown.copy(squad.pos)
        e.hasContact = true
      }

      // --- state -----------------------------------------------------------
      // Note the ordering: losing the lock drops to INVESTIGATE, whose target is
      // the last known position, NOT the player. That is what makes cover work —
      // they commit to where you were and you have to relocate.
      if (visible && e.aware >= AWARE_FIRE) {
        e.state = 'PURSUE'
        e.searchT = 0
      } else if (e.state === 'PURSUE') {
        e.state = 'INVESTIGATE'
        e.searchT = 0
      } else if (e.state === 'INVESTIGATE') {
        if (e.obj.position.distanceTo(e.lastKnown) < 14) { e.state = 'SEARCH'; e.searchT = 0 }
      } else if (e.state === 'SEARCH') {
        e.searchT += dt
        if (e.searchT > SEARCH_TIME) {
          e.state = 'PATROL'
          e.hasContact = false
          e.aware = 0
        }
      } else if (e.aware >= AWARE_HUNT && e.hasContact) {
        e.state = 'INVESTIGATE'
      }

      // --- move --------------------------------------------------------------
      const pursuing = e.state === 'PURSUE'
      const target = TMP_TGT
      if (pursuing) {
        target.copy(playerEye)
        target.y += 2
      } else if (e.state === 'SEARCH') {
        // Orbit of the last contact, widening as the sweep drags on. This is
        // what eventually walks them around the hangar you ducked behind — so
        // breaking line of sight buys time, not permanent safety.
        const a = t * 1.1 + e.phase
        const rr = 12 + e.searchT * 3.2
        target.set(e.lastKnown.x + Math.cos(a) * rr, 0, e.lastKnown.z + Math.sin(a) * rr)
        target.y = Math.max(e.lastKnown.y, terrainHeight(target.x, target.z) + 14)
      } else if (e.state === 'INVESTIGATE') {
        target.copy(e.lastKnown)
        target.y = Math.max(target.y, terrainHeight(target.x, target.z) + 12)
      } else {
        target.copy(e.route[e.leg])
        if (e.obj.position.distanceTo(target) < 12) e.leg = (e.leg + 1) % e.route.length
      }

      TMP_DIR.subVectors(target, e.obj.position)
      const tdist = TMP_DIR.length()
      // keep a firing standoff instead of ramming
      if (pursuing && tdist < 18) TMP_DIR.multiplyScalar(-0.4)
      if (TMP_DIR.lengthSq() > 0.01) TMP_DIR.normalize()
      e.vel.addScaledVector(TMP_DIR, 30 * dt)
      // separation from wingmates
      for (const o of enemies) {
        if (o === e) continue
        TMP_SEP.subVectors(e.obj.position, o.obj.position)
        const sd = TMP_SEP.length()
        if (sd < 8 && sd > 0.01) e.vel.addScaledVector(TMP_SEP.normalize(), (8 - sd) * 2 * dt)
      }
      e.vel.multiplyScalar(Math.exp(-2 * dt))
      // stays outrunnable at the player's 75 km/h top speed
      const maxV = pursuing ? 19.5 : e.state === 'PATROL' ? 10 : 15
      if (e.vel.length() > maxV) e.vel.setLength(maxV)
      e.obj.position.addScaledVector(e.vel, dt)

      const floor = terrainHeight(e.obj.position.x, e.obj.position.z) + 6
      if (e.obj.position.y < floor) {
        e.obj.position.y = floor
        if (e.vel.y < 0) e.vel.y = 0
      }
      // cover stops them too — no clipping through a hangar wall to reach you
      const ep = e.obj.position
      for (const sh of structures) {
        if (ep.y > sh.y1 + 4) continue
        const b = sh.bound + 4
        if (Math.abs(ep.x - sh.x) > b || Math.abs(ep.z - sh.z) > b) continue
        const out = pushOutOfShape(ep.x, ep.y, ep.z, sh, 3.5)
        if (!out) continue
        ep.x += out.x * out.depth
        ep.y += out.y * out.depth
        ep.z += out.z * out.depth
        const vn = e.vel.x * out.x + e.vel.y * out.y + e.vel.z * out.z
        if (vn < 0) {
          e.vel.x -= vn * out.x
          e.vel.y -= vn * out.y
          e.vel.z -= vn * out.z
        }
      }

      // Facing drives the sensor cone, so while pursuing they face the target
      // explicitly: the standoff manoeuvre above points velocity away from you
      // and a velocity-derived heading would shake the lock loose mid-fight.
      // The turn rate is capped, so flanking a drone really does buy you a beat.
      const wantFacing = pursuing
        ? Math.atan2(playerEye.x - ep.x, playerEye.z - ep.z)
        : e.vel.lengthSq() > 1 ? Math.atan2(e.vel.x, e.vel.z) : e.facing
      const dA = Math.atan2(Math.sin(wantFacing - e.facing), Math.cos(wantFacing - e.facing))
      e.facing += THREE.MathUtils.clamp(dA, -2.6 * dt, 2.6 * dt)
      e.obj.rotation.y = e.facing
      for (const r of e.props) r.rotation.y += 50 * dt

      // fire only on a held lock, which needs current line of sight
      e.cooldown -= dt
      if (pursuing && dist < 90 && e.cooldown <= 0) {
        e.cooldown = 1.2 + Math.random() * 0.8
        const lead = drone.position.clone().addScaledVector(vel, dist / 70)
        lead.x += (Math.random() - 0.5) * 5
        lead.y += (Math.random() - 0.5) * 5
        lead.z += (Math.random() - 0.5) * 5
        const dir = lead.sub(e.obj.position).normalize()
        const m = new THREE.Mesh(projGeom, projMat)
        m.position.copy(e.obj.position)
        m.lookAt(m.position.clone().add(dir))
        const halo = new THREE.Sprite(projHaloMat)
        halo.scale.setScalar(2.4)
        m.add(halo)
        scene.add(m)
        projectiles.push({ mesh: m, vel: dir.multiplyScalar(70), life: 2.5 })
        sparks.spawn(e.obj.position, ZERO, {
          life: 0.1, s0: 3.4, s1: 0.6, o0: 1, color: 0xffd8a0,
        })
      }
    }

    // --- squad picture -------------------------------------------------------
    if (squad.has) {
      squad.level = Math.max(0, squad.level - 0.1 * dt)
      if (t - squad.at > SQUAD_MEMORY) { squad.has = false; squad.level = 0 }
    }
    alertLevel = squad.has ? squad.level : 0
    eyesOn = 0
    engaged = false
    let inRangeCount = 0
    let blockedCount = 0
    for (const e of enemies) {
      if (e.aware > alertLevel) alertLevel = e.aware
      if (e.visible) eyesOn++
      if (e.state === 'PURSUE') engaged = true
      if (e.inRange) {
        inRangeCount++
        if (!e.los) blockedCount++
      }
    }
    threat = engaged ? 'ENGAGED'
      : eyesOn > 0 ? 'TRACKED'
      : alertLevel > 0.05 || squad.has ? 'SUSPECTED'
      : 'HIDDEN'
    // "In cover" means something specific: a hostile is close enough to see you
    // and every line to it is physically blocked. Being far away is not cover,
    // and neither is a drone that simply happens to be looking elsewhere.
    inCover = inRangeCount > 0 && blockedCount === inRangeCount

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i]
      const q = pr.mesh.position
      TMP_PREV.copy(q)
      q.addScaledVector(pr.vel, dt)
      pr.life -= dt
      // Swept, not point, tests: at 70 m/s a round covers over a metre per
      // frame and would tunnel clean through a 1.2 m blast wall.
      const hitPlayer = !playerDown && segPointDistance(
        TMP_PREV.x, TMP_PREV.y, TMP_PREV.z, q.x, q.y, q.z,
        drone.position.x, drone.position.y, drone.position.z
      ) < 2
      if (hitPlayer) damagePlayer(8, t)
      const hitCover = !hitPlayer &&
        occludedBy(structures, TMP_PREV.x, TMP_PREV.y, TMP_PREV.z, q.x, q.y, q.z)
      const hitGround = q.y < terrainHeight(q.x, q.z)
      if (hitCover || hitGround) sparkBurst(q, 8, 0xffc070, 6)
      if (hitPlayer || hitCover || hitGround || pr.life <= 0) {
        pr.mesh.clear()
        scene.remove(pr.mesh)
        projectiles.splice(i, 1)
      }
    }

    // damage smoke: wisps below half integrity, a black plume once down
    if (playerDown || integrity < 55) {
      smokeAcc += dt * (playerDown ? 26 : (55 - integrity) * 0.28)
      while (smokeAcc >= 1) {
        smokeAcc -= 1
        smoke.spawn(
          drone.position,
          new THREE.Vector3((Math.random() - 0.5) * 2, 1.6 + Math.random(), (Math.random() - 0.5) * 2),
          {
            life: 1.5 + Math.random(), s0: 1.4, s1: 7,
            o0: playerDown ? 0.55 : 0.35,
            color: playerDown ? 0x1e1e1e : 0x5a5a5a,
          }
        )
      }
    }
    sparks.update(dt)
    smoke.update(dt)

    // slow field repair once clear of hostile airspace
    if (alertLevel < 0.05 && !playerDown && integrity < 100) {
      integrity = Math.min(100, integrity + 2 * dt)
    }

    updateRace(dt, t)

    // tilt with acceleration
    const fSpd = vel.dot(forward)
    const sSpd = vel.dot(right)
    droneTilt.rotation.x = THREE.MathUtils.damp(droneTilt.rotation.x, THREE.MathUtils.clamp(fSpd * 0.022, -0.4, 0.4), 6, dt)
    droneTilt.rotation.z = THREE.MathUtils.damp(droneTilt.rotation.z, THREE.MathUtils.clamp(-sSpd * 0.022, -0.4, 0.4), 6, dt)
    droneTilt.position.y = Math.sin(t * 2.1) * 0.06
    for (const r of rotors) r.rotation.y += 45 * dt

    // nav lights: steady sidelights, double-pulse white tail strobe
    const ph = t % 1.7
    const strobeOn = ph < 0.06 || (ph > 0.17 && ph < 0.23)
    strobeBulb.visible = strobeOn
    strobeHalo.material.opacity = strobeOn ? 1 : 0

    atmos.update(dt, p, terrainHeight(p.x, p.z), camera.position)

    // Ripples: the pond drifts in two directions at once so it never reads as
    // a sliding texture; the river scrolls along its own flow axis.
    pondNormals.offset.set(t * 0.010, t * 0.014)
    riverNormals.offset.y = -t * 0.10

    for (const c of clouds.children) {
      c.position.x += c.userData.drift * dt
      if (c.position.x > CLOUD_SPREAD / 2) c.position.x -= CLOUD_SPREAD
      c.material.color.copy(atmos.cloudColor).multiplyScalar(c.userData.tint)
    }

    // camera chase + impact shake ------------------------------------------
    const camTarget = drone.position.clone().addScaledVector(forward, -13).add(new THREE.Vector3(0, 5.5, 0))
    camera.position.lerp(camTarget, 1 - Math.exp(-4 * dt))
    camera.lookAt(drone.position.clone().addScaledVector(forward, 6))
    if (shake > 0.005) {
      camera.position.x += (Math.random() - 0.5) * shake
      camera.position.y += (Math.random() - 0.5) * shake
      camera.position.z += (Math.random() - 0.5) * shake
      shake *= Math.exp(-3.5 * dt)
    }

    // scanning -------------------------------------------------------------
    ringMat.opacity = 0.2 + 0.15 * Math.sin(t * 3)
    let nearest = null
    let nearestD = Infinity
    for (const part of parts) {
      const d = part.pos.distanceTo(drone.position)
      if (d < nearestD) { nearestD = d; nearest = part }
      if (!part.detected && d < SCAN_RANGE) {
        part.detected = true
        const c = part.status === 'FAULT' ? 0xff3b30 : 0x21d07a
        for (const m of part.mats) {
          m.emissive.setHex(c)
          // Above 1 so scanned hardware still reads as marked after dark, and
          // so the bloom pass haloes it the way the other beacons are haloed.
          m.emissiveIntensity = 2.2
        }
        onDetect?.({
          id: part.id, type: part.label, status: part.status, note: part.note,
          towerRef: part.towerRef, x: part.pos.x, z: part.pos.z,
        })
        if (part.status === 'FAULT') {
          // corona glow marks the fault from well outside scan range
          part.glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: glowTex, color: hdr(0xff4a24, 2.5), transparent: true, opacity: 0.6,
            blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
          }))
          part.glow.position.copy(part.pos)
          scene.add(part.glow)
        }
      }
      if (part.detected && part.status === 'FAULT') {
        for (const m of part.mats) m.emissiveIntensity = 1.7 + 1.2 * Math.sin(t * 6)
        const pulse = 0.5 + 0.5 * Math.sin(t * 6)
        part.glow.scale.setScalar(2.4 + 1.4 * pulse)
        part.glow.material.opacity = 0.35 + 0.35 * pulse
        // arcing: the odd spark drops off nearby faulted hardware
        if (d < 140 && Math.random() < dt * 2.5) {
          sparks.spawn(part.pos, new THREE.Vector3(
            (Math.random() - 0.5) * 2, -1 - Math.random() * 2, (Math.random() - 0.5) * 2
          ), { life: 0.55, s0: 1.1, s1: 0.1, o0: 0.95, color: 0xfff0b8, grav: 7 })
        }
      }
    }
    if (nearest && nearestD < SCAN_RANGE * 1.6) {
      beam.visible = true
      beamGeom.setFromPoints([drone.position, nearest.pos])
    } else {
      beam.visible = false
    }

    // telemetry ------------------------------------------------------------
    telemAcc += dt
    if (telemAcc > 0.12) {
      telemAcc = 0
      const scanned = parts.filter((x) => x.detected)
      onTelemetry?.({
        x: p.x, y: p.y, z: p.z,
        agl: p.y - Math.max(terrainHeight(p.x, p.z), waterSurfaceAt(p.x, p.z)),
        speed: vel.length(),
        heading: ((((-yaw * 180) / Math.PI + 90) % 360) + 360) % 360,
        scanned: scanned.length,
        total: parts.length,
        faults: scanned.filter((x) => x.status === 'FAULT').length,
        nearest: nearest ? { id: nearest.id, dist: nearestD, detected: nearest.detected } : null,
        obstacle: obstacle < 10 ? obstacle : null,
        hits,
        recentHit: t - lastHit < 1,
        integrity: Math.round(integrity),
        hostile: engaged,
        inZone,
        threat,            // HIDDEN | SUSPECTED | TRACKED | ENGAGED
        exposure: alertLevel,
        eyesOn,
        hostiles: enemies.length,
        inCover,
        mission,
        secure,
        deliver,
        // inbound: how far to the pod. laden: how far home to the safehouse.
        missionDist: laden ? homeDist : padDist,
        down: playerDown,
        recentDamage: t - lastDamage < 0.5,
        tod: atmos.label,
        arenaDist: Math.hypot(p.x - RACE_C.x, p.z - RACE_C.z),
        nearArena: Math.hypot(p.x - RACE_C.x, p.z - RACE_C.z) < ARENA_ENTER_R,
        race: race.state === 'IDLE' ? null : {
          state: race.state,
          count: race.state === 'COUNTDOWN' ? Math.max(1, Math.ceil(race.countEnd - t)) : 0,
          go: race.state === 'RACING' && t - race.t0 < 1.2,
          lap: Math.min(race.lap + 1, RACE_LAPS),
          lapsMax: RACE_LAPS,
          cur: race.state === 'RACING' ? t - race.lapStart : 0,
          last: race.laps.length ? race.laps[race.laps.length - 1] : null,
          best: race.best,
          total: race.total,
          laps: race.laps,
          pos: race.pos,
          n: racers.length + 1,
          nextDist: race.state === 'RACING' ? race.nextDist : null,
          standings: race.standings,
        },
      })
    }

    fx.render()

    // Safehouse waypoint. Projected after the render, so the camera matrices
    // are already current for this frame, and reported every frame rather than
    // on the 8 Hz telemetry tick — a screen-space marker moves ~18% of the
    // viewport per tick at full yaw rate, which reads as a stutter.
    if (onWaypoint) {
      TMP_MARK.set(SAFEHOUSE.x, HOME_Y + 14, SAFEHOUSE.z)
      TMP_MARK.applyMatrix4(camera.matrixWorldInverse)
      const behind = TMP_MARK.z > 0
      TMP_MARK.applyMatrix4(camera.projectionMatrix)
      onWaypoint({
        // normalised device coords; behind the camera the projection flips, so
        // the sign is corrected and the caller treats it as direction only
        x: behind ? -TMP_MARK.x : TMP_MARK.x,
        y: behind ? -TMP_MARK.y : TMP_MARK.y,
        behind,
        dist: Math.hypot(p.x - SAFEHOUSE.x, p.z - SAFEHOUSE.z),
        active: laden,
        // the safehouse marker has no business on screen inside the arena
        done: mission === 'COMPLETE' || race.state !== 'IDLE',
      })
    }
  }
  animate()

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('resize', onResize)
      atmos.dispose()
      fx.dispose()
      renderer.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

// Race venue at the foot of the start/finish gate: a start straight with grid
// slots, an overhead gantry on the finish line, grandstands, pits, paddock
// tents, flags and barriers. All meshes come from the Kenney Racing Kit (CC0,
// kenney.nl) in /public/models/race — nothing here is hand-modelled.
function buildRaceVenue(scene, structures) {
  const loader = new GLTFLoader()
  const cache = new Map()
  const load = (file) => {
    if (!cache.has(file)) {
      cache.set(file, new Promise((resolve) => {
        loader.load(`/models/race/${file}.glb`, (g) => resolve(g.scene),
          undefined, () => resolve(null))   // venue is decoration; missing model = skip
      }))
    }
    return cache.get(file)
  }

  // size scales the largest horizontal dimension; height scales bbox height
  // instead (for tall thin things like light posts). alongZ auto-rotates the
  // model's long axis onto the given world axis, so the exact authoring axis
  // of each kit piece doesn't need to be known.
  function place(file, { x, z, rot = 0, size, height, alongZ, lift = 0, collide }) {
    load(file).then((proto) => {
      if (!proto) return
      const m = proto.clone(true)
      const box = new THREE.Box3().setFromObject(m)
      const dim = box.getSize(new THREE.Vector3())
      const s = height
        ? height / Math.max(dim.y, 0.001)
        : size / Math.max(dim.x, dim.z, 0.001)
      m.scale.setScalar(s)
      if (alongZ !== undefined) {
        const longX = dim.x > dim.z
        if ((alongZ && longX) || (!alongZ && !longX)) rot += Math.PI / 2
      }
      m.rotation.y = rot
      const groundY = terrainHeight(x, z)
      m.position.set(x, groundY - box.min.y * s + lift, z)
      m.traverse((o) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true }
      })
      scene.add(m)
      if (collide) {
        structures.push({
          kind: 'box', x, z, hw: collide.w / 2, hd: collide.d / 2,
          y0: groundY, y1: groundY + collide.h, rot,
          bound: Math.hypot(collide.w / 2, collide.d / 2),
        })
      }
    })
  }

  const V = VENUE
  // start straight along +z (the direction of travel through gate 0),
  // finish line under the gantry at the gate itself
  place('roadStraightLong', { x: V.x, z: V.z - 42, alongZ: true, size: 30, lift: 0.1 })
  place('roadStartPositions', { x: V.x, z: V.z - 12, alongZ: true, size: 30, lift: 0.1 })
  place('roadStraightLong', { x: V.x, z: V.z + 18, alongZ: true, size: 30, lift: 0.1 })
  place('roadStraightLong', { x: V.x, z: V.z + 48, alongZ: true, size: 30, lift: 0.1 })
  place('overheadLights', { x: V.x, z: V.z, alongZ: false, size: 26 })

  // grandstands face the straight from the east
  for (const dz of [-16, 0, 16]) {
    place('grandStandCovered', {
      x: V.x + 14, z: V.z + dz, rot: -Math.PI / 2, size: 11,
      collide: { w: 9, d: 11, h: 11 },
    })
  }
  place('billboard', { x: V.x + 26, z: V.z, rot: -Math.PI / 2, size: 10 })

  // pit row and paddock on the west side
  place('pitsGarage', {
    x: V.x - 17, z: V.z - 16, rot: Math.PI / 2, size: 16,
    collide: { w: 10, d: 16, h: 6 },
  })
  place('pitsGarageClosed', {
    x: V.x - 17, z: V.z + 2, rot: Math.PI / 2, size: 16,
    collide: { w: 10, d: 16, h: 6 },
  })
  place('pitsOffice', {
    x: V.x - 17, z: V.z + 19, rot: Math.PI / 2, size: 13,
    collide: { w: 9, d: 13, h: 6 },
  })
  place('tentLong', {
    x: V.x - 28, z: V.z - 34, size: 13, collide: { w: 13, d: 9, h: 5 },
  })
  place('tent', {
    x: V.x - 26, z: V.z + 34, size: 9, collide: { w: 9, d: 9, h: 5 },
  })
  place('raceCarRed', { x: V.x - 10, z: V.z - 26, alongZ: true, size: 5 })
  place('raceCarGreen', { x: V.x - 10, z: V.z - 33, alongZ: true, size: 5 })

  // flags, lights and dressing
  place('flagCheckers', { x: V.x - 9, z: V.z - 2, height: 8 })
  place('flagCheckers', { x: V.x + 9, z: V.z + 2, height: 8 })
  place('flagGreen', { x: V.x - 9, z: V.z + 40, height: 7 })
  place('flagRed', { x: V.x + 9, z: V.z - 40, height: 7 })
  for (const [dx, dz] of [[-11, -52], [11, -52], [-11, 52], [11, 52]]) {
    place('lightPostLarge', { x: V.x + dx, z: V.z + dz, height: 13 })
  }
  place('bannerTowerGreen', { x: V.x - 12, z: V.z - 60, height: 10 })
  place('bannerTowerRed', { x: V.x + 12, z: V.z - 60, height: 10 })

  // barriers lining both edges of the straight
  for (let i = 0; i < 12; i++) {
    const bz = V.z - 55 + i * 10
    const file = i % 2 ? 'barrierRed' : 'barrierWhite'
    place(file, { x: V.x - 8.5, z: bz, alongZ: true, size: 9 })
    place(file, { x: V.x + 8.5, z: bz, alongZ: true, size: 9 })
  }
  for (const [dx, dz] of [[-6, -64], [6, -64], [-6, 64], [6, 64]]) {
    place('pylon', { x: V.x + dx, z: V.z + dz, height: 1.6 })
  }
}

function beam(a, b, r, mat) {
  const len = a.distanceTo(b)
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 5), mat)
  m.position.copy(a).add(b).multiplyScalar(0.5)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  m.castShadow = true
  return m
}

function buildTower(mat) {
  const g = new THREE.Group()
  const H = 45
  const baseHW = 4.2
  const topHW = 1.1
  const hw = (y) => THREE.MathUtils.lerp(baseHW, topHW, y / H)

  const corners = (y) => {
    const w = hw(y)
    return [
      new THREE.Vector3(-w, y, -w), new THREE.Vector3(w, y, -w),
      new THREE.Vector3(w, y, w), new THREE.Vector3(-w, y, w),
    ]
  }

  const bot = corners(0), top = corners(H)
  for (let i = 0; i < 4; i++) g.add(beam(bot[i], top[i], 0.22, mat))

  for (let y = 0; y < H; y += 7.5) {
    const c1 = corners(y), c2 = corners(Math.min(y + 7.5, H))
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      g.add(beam(c1[i], c1[j], 0.09, mat))
      g.add(beam(c1[i], c2[j], 0.07, mat))
      g.add(beam(c1[j], c2[i], 0.07, mat))
    }
  }

  for (const [h, hwArm] of [[28, 7.5], [34, 6.5], [40, 5.5]]) {
    const w = hw(h)
    for (const side of [-1, 1]) {
      const tip = new THREE.Vector3(0, h, side * hwArm)
      g.add(beam(new THREE.Vector3(0, h, side * w), tip, 0.14, mat))
      g.add(beam(new THREE.Vector3(0, h + 2.6, side * w * 0.9), tip, 0.1, mat))
      g.add(beam(new THREE.Vector3(0, h - 2.2, side * w * 0.95), tip, 0.1, mat))
    }
  }

  const apex = new THREE.Vector3(0, 46, 0)
  const tc = corners(H)
  for (const c of tc) g.add(beam(c, apex, 0.1, mat))
  g.add(beam(new THREE.Vector3(0, 45.6, -1.4), new THREE.Vector3(0, 45.6, 1.4), 0.09, mat))

  return g
}

function buildInsulator(mat) {
  const g = new THREE.Group()
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.8, 6), mat)
  rod.position.y = -1.4
  g.add(rod)
  for (let i = 0; i < 8; i++) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.28, 0.12, 12), mat)
    disc.position.y = -0.35 - i * 0.32
    disc.castShadow = true
    g.add(disc)
  }
  return g
}

function buildDamper(mat) {
  const g = new THREE.Group()
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.0, 6), mat)
  bar.rotation.z = Math.PI / 2
  bar.position.y = -0.35
  g.add(bar)
  for (const s of [-0.5, 0.5]) {
    const wgt = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.3, 8), mat)
    wgt.rotation.z = Math.PI / 2
    wgt.position.set(s, -0.35, 0)
    g.add(wgt)
  }
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.18), mat)
  clamp.position.y = -0.15
  g.add(clamp)
  return g
}

function buildFallbackDrone(bodyColor = 0x2e3338, accentColor = 0xff7a1a) {
  const body = new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.4, roughness: 0.5 })
  const accent = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.5 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.7 })
  const group = new THREE.Group()
  const props = []

  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.35, 1.4), body)
  hull.castShadow = true
  group.add(hull)
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), dark)
  cam.position.set(0, -0.25, 0.55)
  group.add(cam)

  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 1.0), accent)
    arm.position.set(sx * 0.65, 0.05, sz * 0.65)
    arm.rotation.y = Math.atan2(sx, sz)
    group.add(arm)
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.16, 10), dark)
    motor.position.set(sx * 1.0, 0.12, sz * 1.0)
    group.add(motor)
    const prop = new THREE.Group()
    for (const r of [0, Math.PI / 2]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.02, 0.09), dark)
      blade.rotation.y = r
      prop.add(blade)
    }
    prop.position.set(sx * 1.0, 0.22, sz * 1.0)
    group.add(prop)
    props.push(prop)
  }
  for (const s of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.3), body)
    skid.position.set(s * 0.45, -0.35, 0)
    group.add(skid)
  }
  return { group, props }
}

function makeGroundTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 256
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#ebebeb'
  ctx.fillRect(0, 0, 256, 256)
  const rnd = mulberry32(42)
  for (let i = 0; i < 900; i++) {
    const g = Math.round(180 + rnd() * 70)
    ctx.fillStyle = `rgba(${g}, ${g}, ${g}, 0.5)`
    ctx.beginPath()
    ctx.arc(rnd() * 256, rnd() * 256, 1 + rnd() * 5, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeWaterTexture() {
  const c = document.createElement('canvas')
  c.width = 128; c.height = 128
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'rgba(255,255,255,0)'
  ctx.fillRect(0, 0, 128, 128)
  const rnd = mulberry32(7)
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = `rgba(255,255,255,${0.08 + rnd() * 0.15})`
    ctx.lineWidth = 1 + rnd() * 2
    const x = rnd() * 128
    const y = rnd() * 128
    ctx.beginPath()
    ctx.moveTo(x - 3, y)
    ctx.quadraticCurveTo(x + 6, y + 10 + rnd() * 12, x - 2, y + 24 + rnd() * 14)
    ctx.stroke()
  }
  return new THREE.CanvasTexture(c)
}

// A tileable tangent-space normal map built from a few summed sine waves.
// Integer wave frequencies are what keep it seamless when the texture repeats.
function makeWaterNormalTexture(size = 256, waves = 5) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(size, size)

  const W = []
  for (let i = 0; i < waves; i++) {
    const a = (i / waves) * Math.PI * 2 + 0.7
    W.push({
      fx: Math.round(Math.cos(a) * (1 + i)),
      fz: Math.round(Math.sin(a) * (1 + i)),
      amp: 1 / (1 + i),
      ph: i * 1.7,
    })
  }
  const height = (u, v) => {
    let h = 0
    for (const w of W) h += w.amp * Math.sin((u * w.fx + v * w.fz) * Math.PI * 2 + w.ph)
    return h
  }

  const e = 1 / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const du = (height(u + e, v) - height(u - e, v)) / (2 * e)
      const dv = (height(u, v + e) - height(u, v - e)) / (2 * e)
      const nx = -du * 0.012
      const ny = -dv * 0.012
      const len = Math.hypot(nx, ny, 1)
      const i = (y * size + x) * 4
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
      img.data[i + 2] = (1 / len) * 255
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(c)
  // Deliberately left in the default (non-sRGB) colour space: these bytes are
  // vector components, not colour.
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

function makeWaterfallTexture() {
  const c = document.createElement('canvas')
  c.width = 64; c.height = 256
  const ctx = c.getContext('2d')
  ctx.fillStyle = 'rgba(190,225,245,0.45)'
  ctx.fillRect(0, 0, 64, 256)
  const rnd = mulberry32(11)
  for (let i = 0; i < 46; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + rnd() * 0.55})`
    const x = rnd() * 64
    ctx.fillRect(x, 0, 1 + rnd() * 3.5, 256)
  }
  return new THREE.CanvasTexture(c)
}

function makeMistTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62)
  g.addColorStop(0, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.6, 'rgba(255,255,255,0.3)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(c)
}

function makeGlowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function makeCloudTexture() {
  const c = document.createElement('canvas')
  c.width = 256; c.height = 128
  const ctx = c.getContext('2d')
  const rnd = mulberry32(23)
  for (let i = 0; i < 26; i++) {
    const x = 32 + rnd() * 192
    const y = 74 - Math.abs(x - 128) * 0.12 - rnd() * 34
    const r = 16 + rnd() * 32
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, 'rgba(255,255,255,0.9)')
    g.addColorStop(0.5, 'rgba(255,255,255,0.4)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function scatterVegetation(scene, rand, footprints = []) {
  const colliders = []
  const m = new THREE.Matrix4()

  const nearWater = (x, z) => {
    const dx = x - POND.x, dz = z - POND.z
    if (dx * dx + dz * dz < (POND.r + 25) * (POND.r + 25)) return true
    if (riverNearest(x, z).d < 24) return true
    const mdx = x - MTN.x, mdz = z - MTN.z
    return mdx * mdx + mdz * mdz < 50 * 50 // rocky summit stays bare
  }

  // buildings claim their plot; nothing grows through a roof
  const onPlot = (x, z) =>
    footprints.some((f) => (x - f.x) ** 2 + (z - f.z) ** 2 < f.r * f.r)

  const blocked = (x, z) => nearWater(x, z) || onPlot(x, z)

  // trees (collidable)
  {
    const N = 160
    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.35, 0.5, 4, 6),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 }), N)
    const fols = new THREE.InstancedMesh(
      new THREE.ConeGeometry(3, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x35602f, roughness: 1 }), N)
    for (let i = 0; i < N; i++) {
      let x, z
      do {
        x = (rand() - 0.5) * (LINE_LEN + 500)
        z = (rand() - 0.5) * 700
      } while (Math.abs(z) < 30 || blocked(x, z))
      const s = 0.7 + rand() * 1.2
      const y = terrainHeight(x, z)
      m.makeScale(s, s, s).setPosition(x, y + 2 * s, z)
      trunks.setMatrixAt(i, m)
      m.makeScale(s, s, s).setPosition(x, y + 7.5 * s, z)
      fols.setMatrixAt(i, m)
      colliders.push({ x, z, r: 2.6 * s, top: y + 11.5 * s })
    }
    fols.castShadow = true
    scene.add(trunks, fols)
  }

  // bushes
  {
    const N = 180
    const bushes = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1.4, 0),
      new THREE.MeshStandardMaterial({ color: 0x476b33, roughness: 1, flatShading: true }), N)
    for (let i = 0; i < N; i++) {
      let x, z
      do {
        x = (rand() - 0.5) * (LINE_LEN + 500)
        z = (rand() - 0.5) * 700
      } while (blocked(x, z))
      const s = 0.6 + rand() * 1.3
      m.makeScale(s * 1.4, s * 0.8, s * 1.4).setPosition(x, terrainHeight(x, z) + 0.5 * s, z)
      bushes.setMatrixAt(i, m)
    }
    scene.add(bushes)
  }

  // rocks
  {
    const N = 90
    const rocks = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ color: 0x8a8d8f, roughness: 1, flatShading: true }), N)
    for (let i = 0; i < N; i++) {
      let x, z
      do {
        x = (rand() - 0.5) * (LINE_LEN + 600)
        z = (rand() - 0.5) * 800
      } while (blocked(x, z))
      const s = 0.5 + rand() * 2.6
      m.makeRotationY(rand() * Math.PI).scale(new THREE.Vector3(s, s * 0.7, s))
        .setPosition(x, terrainHeight(x, z) + 0.3 * s, z)
      rocks.setMatrixAt(i, m)
    }
    scene.add(rocks)
  }

  return colliders
}

// ---------------------------------------------------------------------------
// collision / occlusion primitives
//
// Structures are stored as one of two analytic shapes, both cheap to test for
// containment and for segment intersection (needed by sightlines and tracers):
//   { kind: 'box', x, z, hw, hd, y0, y1, rot }   yaw-rotated box
//   { kind: 'cyl', x, z, r, y0, y1 }             vertical cylinder
// `pad` inflates the shape, so one shape serves both a 0-radius sightline and
// a fat-radius drone hull.
// ---------------------------------------------------------------------------

// world (x, z) -> box-local, undoing the box's yaw
function boxLocal(px, pz, box) {
  const c = Math.cos(box.rot)
  const s = Math.sin(box.rot)
  const dx = px - box.x
  const dz = pz - box.z
  return [c * dx - s * dz, s * dx + c * dz]
}

// slab clip of segment a->b against the box
export function segmentHitsBox(ax, ay, az, bx, by, bz, box, pad = 0) {
  const [lax, laz] = boxLocal(ax, az, box)
  const [lbx, lbz] = boxLocal(bx, bz, box)
  const hw = box.hw + pad
  const hd = box.hd + pad
  let t0 = 0
  let t1 = 1
  const slabs = [
    [lax, lbx - lax, -hw, hw],
    [ay, by - ay, box.y0 - pad, box.y1 + pad],
    [laz, lbz - laz, -hd, hd],
  ]
  for (const [p, d, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (p < lo || p > hi) return false
      continue
    }
    let ta = (lo - p) / d
    let tb = (hi - p) / d
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return false
  }
  return true
}

// quadratic clip in xz, then a linear clip against the cylinder's height band
export function segmentHitsCylinder(ax, ay, az, bx, by, bz, cyl, pad = 0) {
  const r = cyl.r + pad
  const dx = bx - ax
  const dz = bz - az
  const ex = ax - cyl.x
  const ez = az - cyl.z
  const A = dx * dx + dz * dz
  const B = 2 * (ex * dx + ez * dz)
  const C = ex * ex + ez * ez - r * r
  let t0 = 0
  let t1 = 1
  if (A < 1e-9) {
    if (C > 0) return false   // purely vertical segment, outside the radius
  } else {
    const disc = B * B - 4 * A * C
    if (disc < 0) return false
    const sq = Math.sqrt(disc)
    const ta = (-B - sq) / (2 * A)
    const tb = (-B + sq) / (2 * A)
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return false
  }
  const dy = by - ay
  const y0 = cyl.y0 - pad
  const y1 = cyl.y1 + pad
  if (Math.abs(dy) < 1e-9) return ay >= y0 && ay <= y1
  let ya = (y0 - ay) / dy
  let yb = (y1 - ay) / dy
  if (ya > yb) { const s = ya; ya = yb; yb = s }
  if (ya > t0) t0 = ya
  if (yb < t1) t1 = yb
  return t0 <= t1
}

// nearest-face escape from inside a shape: unit normal + penetration depth,
// or null when the point is already outside. Y is a candidate axis too, so
// roofs are landable rather than sucking you out sideways.
export function pushOutOfBox(px, py, pz, box, pad = 0) {
  const [lx, lz] = boxLocal(px, pz, box)
  const hw = box.hw + pad
  const hd = box.hd + pad
  const penX = hw - Math.abs(lx)
  const penZ = hd - Math.abs(lz)
  const penUp = box.y1 + pad - py
  const penDown = py - (box.y0 - pad)
  if (penX <= 0 || penZ <= 0 || penUp <= 0 || penDown <= 0) return null
  const penY = Math.min(penUp, penDown)
  if (penY <= penX && penY <= penZ) {
    return { x: 0, y: penUp < penDown ? 1 : -1, z: 0, depth: penY }
  }
  const c = Math.cos(box.rot)
  const s = Math.sin(box.rot)
  if (penX <= penZ) {
    const sx = lx >= 0 ? 1 : -1
    return { x: c * sx, y: 0, z: -s * sx, depth: penX }   // box-local +x in world
  }
  const sz = lz >= 0 ? 1 : -1
  return { x: s * sz, y: 0, z: c * sz, depth: penZ }      // box-local +z in world
}

export function pushOutOfCylinder(px, py, pz, cyl, pad = 0) {
  const r = cyl.r + pad
  const dx = px - cyl.x
  const dz = pz - cyl.z
  const d = Math.sqrt(dx * dx + dz * dz)
  const penR = r - d
  const penUp = cyl.y1 + pad - py
  const penDown = py - (cyl.y0 - pad)
  if (penR <= 0 || penUp <= 0 || penDown <= 0) return null
  const penY = Math.min(penUp, penDown)
  if (penY <= penR) {
    return { x: 0, y: penUp < penDown ? 1 : -1, z: 0, depth: penY }
  }
  if (d < 1e-6) return { x: 1, y: 0, z: 0, depth: penR }
  return { x: dx / d, y: 0, z: dz / d, depth: penR }
}

export function segmentHitsShape(ax, ay, az, bx, by, bz, s, pad = 0) {
  return s.kind === 'box'
    ? segmentHitsBox(ax, ay, az, bx, by, bz, s, pad)
    : segmentHitsCylinder(ax, ay, az, bx, by, bz, s, pad)
}

export function pushOutOfShape(px, py, pz, s, pad = 0) {
  return s.kind === 'box'
    ? pushOutOfBox(px, py, pz, s, pad)
    : pushOutOfCylinder(px, py, pz, s, pad)
}

// ---------------------------------------------------------------------------
// structures: hard cover that stops bullets, bodies and sightlines
// ---------------------------------------------------------------------------

// Shared materials so ~60 buildings cost a handful of draw-call state changes.
function structureMats() {
  return {
    hull: new THREE.MeshStandardMaterial({ color: 0x7b7f83, roughness: 0.85, metalness: 0.15 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.9 }),
    rust: new THREE.MeshStandardMaterial({ color: 0x8a5236, roughness: 0.95 }),
    tank: new THREE.MeshStandardMaterial({ color: 0xa8ab9e, roughness: 0.6, metalness: 0.35 }),
    conc: new THREE.MeshStandardMaterial({ color: 0x9a978e, roughness: 1 }),
    barn: new THREE.MeshStandardMaterial({ color: 0x6e3b30, roughness: 0.95 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.8, metalness: 0.2 }),
  }
}

// Every helper below appends its collider(s) to `out` and its meshes to `scene`,
// so the visual and the collision shape can never drift apart.
function addBox(scene, out, mat, { x, z, w, d, h, base, rot = 0, solid = true }) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
  m.position.set(x, base + h / 2, z)
  m.rotation.y = rot
  m.castShadow = true
  m.receiveShadow = true
  scene.add(m)
  const box = {
    kind: 'box', x, z, hw: w / 2, hd: d / 2, y0: base, y1: base + h, rot,
    bound: Math.hypot(w / 2, d / 2),   // broad-phase radius
  }
  if (solid) out.push(box)
  return box
}

function addCyl(scene, out, mat, { x, z, r, h, base, rt = r, solid = true }) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, r, h, 12), mat)
  m.position.set(x, base + h / 2, z)
  m.castShadow = true
  m.receiveShadow = true
  scene.add(m)
  const cyl = {
    kind: 'cyl', x, z, r: Math.max(r, rt), y0: base, y1: base + h,
    bound: Math.max(r, rt),
  }
  if (solid) out.push(cyl)
  return cyl
}

// Pitched gable roof: two slabs leaning against a ridge. Purely decorative —
// the box underneath is the collider, so the silhouette can be as fussy as it
// likes without complicating collision or sightlines.
function addRoof(scene, mat, { x, z, w, d, h, base, rot = 0 }) {
  const g = new THREE.Group()
  g.position.set(x, base, z)
  g.rotation.y = rot
  const dd = d * 1.08          // slight eave overhang
  const slope = Math.atan2(h, dd / 2)
  const len = Math.hypot(h, dd / 2)
  for (const side of [-1, 1]) {
    // ridge ends up at (0, h, 0), eaves at (0, 0, ±dd/2)
    const m = new THREE.Mesh(new THREE.BoxGeometry(w * 1.04, 0.35, len), mat)
    m.rotation.x = side * slope
    m.position.set(0, h / 2, (side * dd) / 4)
    m.castShadow = true
    g.add(m)
  }
  scene.add(g)
}

// A hangar: long shed, pitched roof, roller door. The workhorse of the compound.
function addHangar(scene, out, mats, { x, z, w, d, h, base, rot }) {
  addBox(scene, out, mats.hull, { x, z, w, d, h, base, rot })
  addRoof(scene, mats.roof, { x, z, w, d, h: 3.4, base: base + h, rot })
  // door panel on the +local-z face, purely visual
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const door = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, h * 0.7, 0.3), mats.dark)
  door.position.set(x + s * (d / 2 + 0.2), base + h * 0.35, z + c * (d / 2 + 0.2))
  door.rotation.y = rot
  scene.add(door)
}

// Stack of shipping containers — irregular cover you can weave through.
function addContainers(scene, out, mats, rand, { x, z, rot, n }) {
  const palette = [0xb2603a, 0x3f6f7e, 0x8a8f52, 0x77414a]
  for (let i = 0; i < n; i++) {
    const tier = i < n - 1 ? 0 : 1
    const ox = (i % 3) * 6.6 - 6.6
    const oz = Math.floor(i / 3) * 3 - 1.5
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    const mat = new THREE.MeshStandardMaterial({
      color: palette[Math.floor(rand() * palette.length)], roughness: 0.9,
    })
    addBox(scene, out, mat, {
      x: x + c * ox + s * oz, z: z - s * ox + c * oz,
      w: 6.2, d: 2.6, h: 2.7, base: tier * 2.75, rot,
    })
  }
}

// Blast walls ringing the pad, with deliberate gaps so the pad stays enterable
// from cover rather than sealed off.
function addBlastRing(scene, out, mats, { x, z, r, terrainHeight }) {
  const SEG = 14
  for (let i = 0; i < SEG; i++) {
    if (i % 4 === 1) continue   // the gaps: four approach lanes
    const a = (i / SEG) * Math.PI * 2
    const wx = x + Math.cos(a) * r
    const wz = z + Math.sin(a) * r
    addBox(scene, out, mats.conc, {
      x: wx, z: wz, w: (2 * Math.PI * r) / SEG - 1.5, d: 1.2, h: 5.5,
      base: terrainHeight(wx, wz), rot: -a + Math.PI / 2,
    })
  }
}

// A dug-in hangar: three walls, a roof, and a mouth facing west, away from the
// threat axis — so anything chasing you in from hostile airspace is looking at
// a solid back wall, and once you are inside every sightline but the mouth is
// blocked. It draws no randomness at all, and world decoration now runs on its
// own RNG stream, so neither this building nor any future scenery can re-roll
// which line hardware is faulted.
function buildSafehouse(scene, out, footprints, mats, SH) {
  const y = terrainHeight(SH.x, SH.z)
  const H = 9      // interior height
  const HX = 12    // half span along x; the mouth is the -x face
  const HZ = 9     // half span along z

  const apron = new THREE.Mesh(
    new THREE.BoxGeometry(HX * 2 + 18, 0.3, HZ * 2),
    new THREE.MeshStandardMaterial({ color: 0x4a4d4f, roughness: 1 })
  )
  apron.position.set(SH.x - 9, y + 0.15, SH.z)
  apron.receiveShadow = true
  scene.add(apron)

  // The collider set that makes the bay blind: back wall, two flanks, a roof.
  // The walls are sunk SINK metres below the pad. The ground under this
  // footprint varies by ~0.9 m, so basing them on the centre height alone left
  // an 11 cm gap at the low corner — and a sightline is a zero-radius ray, so
  // it goes straight through one. Sinking them makes that impossible whatever
  // the terrain does.
  const SINK = 3
  addBox(scene, out, mats.conc, {
    x: SH.x + HX - 0.5, z: SH.z, w: 1, d: HZ * 2, h: H + SINK, base: y - SINK,
  })
  for (const side of [-1, 1]) {
    addBox(scene, out, mats.conc, {
      x: SH.x, z: SH.z + side * (HZ - 0.5), w: HX * 2, d: 1, h: H + SINK, base: y - SINK,
    })
  }
  addBox(scene, out, mats.roof, { x: SH.x, z: SH.z, w: HX * 2, d: HZ * 2, h: 0.8, base: y + H })

  // landing pad and guide ring
  const pad = new THREE.Mesh(
    new THREE.CylinderGeometry(5.5, 5.5, 0.35, 24),
    new THREE.MeshStandardMaterial({ color: 0x23282c, roughness: 0.9 })
  )
  pad.position.set(SH.x, y + 0.4, SH.z)
  pad.receiveShadow = true
  scene.add(pad)
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(5.2, 0.16, 6, 40),
    new THREE.MeshBasicMaterial({ color: hdr(0x21d07a, 3.0) })
  )
  ring.rotation.x = Math.PI / 2
  ring.position.set(SH.x, y + 0.62, SH.z)
  scene.add(ring)

  // approach lights leading west out of the mouth, each on a short post
  const lampMat = new THREE.MeshBasicMaterial({ color: hdr(0x21d07a, 3.0) })
  for (let i = 1; i <= 5; i++) {
    for (const side of [-1, 1]) {
      const lx = SH.x - HX - i * 7
      const lz = SH.z + side * (HZ - 1.5)
      const ly = terrainHeight(lx, lz)
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 1.4, 5), mats.dark)
      post.position.set(lx, ly + 0.7, lz)
      scene.add(post)
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), lampMat)
      l.position.set(lx, ly + 1.55, lz)
      scene.add(l)
    }
  }

  // roof antenna
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 12, 6), mats.dark)
  mast.position.set(SH.x + HX - 3, y + H + 6.8, SH.z - HZ + 3)
  mast.castShadow = true
  scene.add(mast)

  // fuel drums stacked outside, clear of the bay
  for (const [dx, dz] of [[HX + 3.5, -HZ + 2], [HX + 3.5, -HZ + 4.6], [HX + 6, -HZ + 3.3]]) {
    addCyl(scene, out, mats.rust, {
      x: SH.x + dx, z: SH.z + dz, r: 1.1, h: 2.4,
      base: terrainHeight(SH.x + dx, SH.z + dz),
    })
  }

  // windsock by the approach
  const px = SH.x - HX - 5
  const pz = SH.z + HZ + 3
  const py = terrainHeight(px, pz)
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 9, 6), mats.dark)
  pole.position.set(px, py + 4.5, pz)
  pole.castShadow = true
  scene.add(pole)
  const sock = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, 3.2, 8, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.9, side: THREE.DoubleSide })
  )
  sock.position.set(px + 1.7, py + 8.7, pz)
  sock.rotation.z = -Math.PI / 2
  scene.add(sock)

  footprints.push({ x: SH.x, z: SH.z, r: 36 })
  return { x: SH.x, z: SH.z, y }
}

function buildStructures(scene, rand, ZONE_ARG) {
  const out = []
  const footprints = []   // plots that vegetation must keep out of
  const mats = structureMats()
  const gh = terrainHeight

  // -- enemy compound, inside the hostile zone ------------------------------
  const { x: zx, z: zz } = ZONE_ARG
  const padY = gh(zx, zz)

  addBlastRing(scene, out, mats, { x: zx, z: zz, r: 34, terrainHeight: gh })

  // two hangars flanking the pad — the primary hard cover over the objective
  addHangar(scene, out, mats, {
    x: zx - 52, z: zz + 16, w: 30, d: 14, h: 11, base: gh(zx - 52, zz + 16), rot: 0.35,
  })
  addHangar(scene, out, mats, {
    x: zx + 44, z: zz + 40, w: 26, d: 13, h: 10, base: gh(zx + 44, zz + 40), rot: -1.15,
  })

  // fuel farm: four tanks, tall enough to hide a hovering drone behind
  for (const [ox, oz, r, h] of [[-18, -52, 6, 15], [-4, -56, 6, 15], [10, -50, 5, 12], [23, -58, 5, 12]]) {
    const sx = zx + ox
    const sz = zz + oz
    addCyl(scene, out, mats.tank, { x: sx, z: sz, r, h, base: gh(sx, sz) })
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), mats.tank)
    cap.position.set(sx, gh(sx, sz) + h, sz)
    cap.castShadow = true
    scene.add(cap)
  }

  // container yard on the approach side
  addContainers(scene, out, mats, rand, { x: zx + 62, z: zz - 26, rot: 0.5, n: 7 })
  addContainers(scene, out, mats, rand, { x: zx - 34, z: zz - 40, rot: -0.8, n: 5 })

  // control block beside the pad
  addBox(scene, out, mats.dark, {
    x: zx + 22, z: zz + 8, w: 12, d: 10, h: 8, base: gh(zx + 22, zz + 8), rot: 0.2,
  })

  // Everything placed so far is compound; claim all of it plus the pad itself,
  // so the enemy base does not end up with a forest growing through its apron.
  for (const sh of out) footprints.push({ x: sh.x, z: sh.z, r: sh.bound + 4 })
  footprints.push({ x: zx, z: zz, r: 26 })

  // -- map-wide structures --------------------------------------------------
  // Substation next to the corridor: transformer blocks + a control hut. Kept
  // off the wires so it reads as cover from the line without fouling the scan run.
  for (const side of [-1, 1]) {
    const sx = X0 + SPAN * (side < 0 ? 2 : 4)
    const sz = side * 58
    addBox(scene, out, mats.conc, { x: sx - 9, z: sz, w: 7, d: 7, h: 6, base: gh(sx - 9, sz), rot: 0 })
    addBox(scene, out, mats.conc, { x: sx + 1, z: sz + 2, w: 7, d: 7, h: 6, base: gh(sx + 1, sz + 2), rot: 0 })
    addBox(scene, out, mats.hull, { x: sx + 13, z: sz - 4, w: 10, d: 8, h: 5, base: gh(sx + 13, sz - 4), rot: 0.3 })
    addCyl(scene, out, mats.tank, { x: sx + 24, z: sz + 6, r: 3.4, h: 18, base: gh(sx + 24, sz + 6) })
  }

  // Scattered farmsteads, warehouses, silos and water towers across the map.
  // Rejection-sampled away from the wires, the pond, the river and the compound.
  const KINDS = ['barn', 'warehouse', 'silo', 'tower', 'shed']
  let placed = 0
  let guard = 0
  while (placed < 26 && guard++ < 4000) {
    const x = (rand() - 0.5) * (LINE_LEN + 620)
    const z = (rand() - 0.5) * 780
    const az = Math.abs(z)
    if (az < 34 || az > 340) continue                       // clear of the wires
    const pdx = x - POND.x, pdz = z - POND.z
    if (pdx * pdx + pdz * pdz < (POND.r + 30) * (POND.r + 30)) continue
    if (riverNearest(x, z).d < 30) continue
    const mdx = x - MTN.x, mdz = z - MTN.z
    if (mdx * mdx + mdz * mdz < 110 * 110) continue         // off the mountain
    const cdx = x - zx, cdz = z - zz
    if (cdx * cdx + cdz * cdz < 120 * 120) continue         // compound owns its ground
    if (footprints.some((f) => (f.x - x) ** 2 + (f.z - z) ** 2 < 52 * 52)) continue
    // steep ground reads as a building sunk into a hillside — skip it
    const y = gh(x, z)
    if (Math.abs(gh(x + 6, z) - y) > 3 || Math.abs(gh(x, z + 6) - y) > 3) continue

    const rot = rand() * Math.PI * 2
    const kind = KINDS[Math.floor(rand() * KINDS.length)]
    if (kind === 'barn') {
      const w = 16 + rand() * 8
      addBox(scene, out, mats.barn, { x, z, w, d: 10, h: 7, base: y, rot })
      addRoof(scene, mats.rust, { x, z, w, d: 10, h: 3.6, base: y + 7, rot })
    } else if (kind === 'warehouse') {
      const w = 22 + rand() * 12
      addBox(scene, out, mats.hull, { x, z, w, d: 13, h: 9, base: y, rot })
      addRoof(scene, mats.roof, { x, z, w, d: 13, h: 2.8, base: y + 9, rot })
    } else if (kind === 'silo') {
      const n = 2 + Math.floor(rand() * 2)
      for (let i = 0; i < n; i++) {
        const ox = Math.cos(rot) * i * 9
        const oz = -Math.sin(rot) * i * 9
        addCyl(scene, out, mats.conc, {
          x: x + ox, z: z + oz, r: 3.8, h: 16 + rand() * 8, base: gh(x + ox, z + oz),
        })
      }
    } else if (kind === 'tower') {
      // water tower: legs are decorative, the tank up top is the real occluder
      const h = 16 + rand() * 6
      for (const [lx, lz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, h, 5), mats.dark)
        m.position.set(x + lx, y + h / 2, z + lz)
        m.castShadow = true
        scene.add(m)
      }
      addCyl(scene, out, mats.tank, { x, z, r: 6, h: 8, base: y + h })
    } else {
      addBox(scene, out, mats.rust, { x, z, w: 9 + rand() * 5, d: 8, h: 5, base: y, rot })
    }
    footprints.push({ x, z, r: 26 })
    placed++
  }

  const safehouse = buildSafehouse(scene, out, footprints, mats, SAFEHOUSE)

  return { colliders: out, footprints, padY, safehouse }
}

// shortest distance from a point to the shape's surface (0 when inside)
export function distanceToShape(px, py, pz, s) {
  let dx = 0
  let dz = 0
  if (s.kind === 'box') {
    const [lx, lz] = boxLocal(px, pz, s)
    dx = Math.max(Math.abs(lx) - s.hw, 0)
    dz = Math.max(Math.abs(lz) - s.hd, 0)
  } else {
    dx = Math.max(Math.hypot(px - s.x, pz - s.z) - s.r, 0)
  }
  const dy = Math.max(s.y0 - py, py - s.y1, 0)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// closest approach of a point to a segment — the swept test for fast tracers
export function segPointDistance(ax, ay, az, bx, by, bz, px, py, pz) {
  const dx = bx - ax
  const dy = by - ay
  const dz = bz - az
  const l2 = dx * dx + dy * dy + dz * dz
  let f = 0
  if (l2 > 1e-12) {
    f = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2
    f = f < 0 ? 0 : f > 1 ? 1 : f
  }
  const qx = ax + dx * f - px
  const qy = ay + dy * f - py
  const qz = az + dz * f - pz
  return Math.sqrt(qx * qx + qy * qy + qz * qz)
}
