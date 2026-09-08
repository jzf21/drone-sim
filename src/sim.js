import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// ---------------------------------------------------------------------------
// Powerline inspection drone simulation
// ---------------------------------------------------------------------------

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
  return h
}

const FAULT_NOTES = {
  insulator: ['Cracked disc', 'Flashover burn marks', 'Contamination buildup', 'Broken shed'],
  damper: ['Loose clamp', 'Missing weight', 'Slipped along conductor'],
  splice: ['Hotspot detected', 'Corrosion at sleeve', 'Bird-caging strands'],
}

export function createSim(canvas, { onTelemetry, onDetect, onReady }) {
  const rand = mulberry32(1337)

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x8fc1e3)
  scene.fog = new THREE.Fog(0x8fc1e3, 250, 1400)

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 3000)
  camera.position.set(X0 - 20, 30, 60)

  // -- lights ---------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x3a5230, 0.9))
  const sun = new THREE.DirectionalLight(0xfff2d9, 1.6)
  sun.position.set(180, 260, 120)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  const sc = sun.shadow.camera
  sc.left = -500; sc.right = 500; sc.top = 120; sc.bottom = -120
  sc.near = 50; sc.far = 700
  scene.add(sun)

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
  }
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 })
  )
  ground.receiveShadow = true
  scene.add(ground)

  // -- waterway: pond, river, plunge pool, waterfall ------------------------
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2e6d8a, roughness: 0.15, metalness: 0.1,
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
  const riverMat = new THREE.MeshStandardMaterial({
    color: 0x3f7f9e, map: riverTex, roughness: 0.2, metalness: 0.05,
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
      const a = (i / 26) * Math.PI * 2 + rand() * 0.2
      const dist = 1000 + rand() * 500
      const h = 110 + rand() * 150
      const r = 130 + rand() * 150
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5 + Math.floor(rand() * 3)), mat)
      m.position.set(Math.cos(a) * dist, h / 2 - 25, Math.sin(a) * dist)
      m.rotation.y = rand() * Math.PI
      scene.add(m)
    }
  }

  const treeColliders = scatterVegetation(scene, rand)

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

  // -- hostile territory ----------------------------------------------------
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
      new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.5 })
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
      const lampMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a })
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
    const mastLampMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a })
    const mastLamp = new THREE.Mesh(new THREE.SphereGeometry(1.1, 10, 8), mastLampMat)
    mastLamp.position.set(ZONE.x + 24, padY + 26.5, ZONE.z - 6)
    scene.add(mastLamp)
    beaconMats.push(mastLampMat)
  }

  // rival drones
  const enemies = []
  for (let i = 0; i < 3; i++) {
    const { group, props } = buildFallbackDrone(0x33161a, 0xd92626)
    group.scale.setScalar(1.15)
    const obj = new THREE.Group()
    obj.add(group)
    const home = new THREE.Vector3(
      ZONE.x + [-25, 5, 25][i],
      terrainHeight(ZONE.x, ZONE.z) + 12 + i * 4,
      ZONE.z + [-12, 22, -22][i]
    )
    obj.position.copy(home)
    scene.add(obj)
    enemies.push({ obj, props, home, vel: new THREE.Vector3(), cooldown: 1 + i * 0.5 })
  }

  const projectiles = []
  const projGeom = new THREE.SphereGeometry(0.35, 8, 6)
  const projMat = new THREE.MeshBasicMaterial({ color: 0xff5040 })
  let alerted = false
  let integrity = 100
  let playerDown = false
  let lastDamage = -10

  function damagePlayer(amount, t) {
    if (playerDown) return
    integrity = Math.max(0, integrity - amount)
    lastDamage = t
    shake = Math.min(shake + 0.5, 1.2)
    if (integrity <= 0) playerDown = true
  }

  // scan range ring + beam
  const ringMat = new THREE.LineBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.35 })
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
  const beam = new THREE.Line(beamGeom, new THREE.LineBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.8 }))
  beam.visible = false
  scene.add(beam)

  // -- input ----------------------------------------------------------------
  const keys = {}
  const onKey = (e) => {
    if (e.repeat) return
    keys[e.code] = e.type === 'keydown'
  }
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
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
    }
  }

  // -- loop -----------------------------------------------------------------
  const up = new THREE.Vector3(0, 1, 0)
  const clock = new THREE.Clock()
  let telemAcc = 0
  let raf = 0
  let disposed = false

  function animate() {
    if (disposed) return
    raf = requestAnimationFrame(animate)
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime

    // movement -------------------------------------------------------------
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    const right = new THREE.Vector3().crossVectors(forward, up)
    const acc = new THREE.Vector3()
    if (!playerDown) {
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
        drone.position.set(X0 - 25, 26, 22)
        vel.set(0, 0, 0)
        integrity = 100
        playerDown = false
        alerted = false
        shake = 0
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

    updateWater(dt, t)

    // hostile territory ----------------------------------------------------
    const zdx = p.x - ZONE.x
    const zdz = p.z - ZONE.z
    const zoneDist = Math.sqrt(zdx * zdx + zdz * zdz)
    if (zoneDist < ZONE.r) alerted = true
    else if (zoneDist > ZONE.r + 120) alerted = false

    for (const lamp of beaconMats) {
      lamp.color.setHex(Math.sin(t * (alerted ? 10 : 3)) > 0 ? 0xff2a2a : 0x551111)
    }

    const sep = new THREE.Vector3()
    for (const e of enemies) {
      const pursuing = alerted && !playerDown
      const target = pursuing
        ? drone.position.clone().add(new THREE.Vector3(0, 2, 0))
        : e.home
      const toTarget = target.clone().sub(e.obj.position)
      const dist = toTarget.length()
      // keep a firing standoff instead of ramming
      if (pursuing && dist < 18) toTarget.multiplyScalar(-0.4)
      if (toTarget.lengthSq() > 0.01) toTarget.normalize()
      e.vel.addScaledVector(toTarget, 30 * dt)
      // separation from wingmates
      for (const o of enemies) {
        if (o === e) continue
        sep.subVectors(e.obj.position, o.obj.position)
        const sd = sep.length()
        if (sd < 8 && sd > 0.01) e.vel.addScaledVector(sep.normalize(), (8 - sd) * 2 * dt)
      }
      e.vel.multiplyScalar(Math.exp(-2 * dt))
      const maxV = pursuing ? 19.5 : 12 // stays outrunnable at the new 75 km/h top speed
      if (e.vel.length() > maxV) e.vel.setLength(maxV)
      e.obj.position.addScaledVector(e.vel, dt)
      const floor = terrainHeight(e.obj.position.x, e.obj.position.z) + 6
      if (e.obj.position.y < floor) {
        e.obj.position.y = floor
        if (e.vel.y < 0) e.vel.y = 0
      }
      if (e.vel.lengthSq() > 1) e.obj.rotation.y = Math.atan2(e.vel.x, e.vel.z)
      for (const r of e.props) r.rotation.y += 50 * dt

      // fire at the intruder
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
        scene.add(m)
        projectiles.push({ mesh: m, vel: dir.multiplyScalar(70), life: 2.5 })
      }
    }

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i]
      pr.mesh.position.addScaledVector(pr.vel, dt)
      pr.life -= dt
      const hitPlayer = pr.mesh.position.distanceTo(drone.position) < 2
      if (hitPlayer) damagePlayer(8, t)
      if (hitPlayer || pr.life <= 0 ||
          pr.mesh.position.y < terrainHeight(pr.mesh.position.x, pr.mesh.position.z)) {
        scene.remove(pr.mesh)
        projectiles.splice(i, 1)
      }
    }

    // slow field repair once clear of hostile airspace
    if (!alerted && !playerDown && integrity < 100) {
      integrity = Math.min(100, integrity + 2 * dt)
    }

    // tilt with acceleration
    const fSpd = vel.dot(forward)
    const sSpd = vel.dot(right)
    droneTilt.rotation.x = THREE.MathUtils.damp(droneTilt.rotation.x, THREE.MathUtils.clamp(fSpd * 0.022, -0.4, 0.4), 6, dt)
    droneTilt.rotation.z = THREE.MathUtils.damp(droneTilt.rotation.z, THREE.MathUtils.clamp(-sSpd * 0.022, -0.4, 0.4), 6, dt)
    droneTilt.position.y = Math.sin(t * 2.1) * 0.06
    for (const r of rotors) r.rotation.y += 45 * dt

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
          m.emissiveIntensity = 0.9
        }
        onDetect?.({
          id: part.id, type: part.label, status: part.status, note: part.note,
          towerRef: part.towerRef, x: part.pos.x, z: part.pos.z,
        })
      }
      if (part.detected && part.status === 'FAULT') {
        for (const m of part.mats) m.emissiveIntensity = 0.6 + 0.5 * Math.sin(t * 6)
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
        hostile: alerted,
        down: playerDown,
        recentDamage: t - lastDamage < 0.5,
      })
    }

    renderer.render(scene, camera)
  }
  animate()

  return {
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('resize', onResize)
      renderer.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

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
  ctx.fillStyle = '#5a7a44'
  ctx.fillRect(0, 0, 256, 256)
  const rnd = mulberry32(42)
  for (let i = 0; i < 900; i++) {
    const g = 90 + rnd() * 60
    ctx.fillStyle = `rgba(${g * 0.7}, ${g}, ${g * 0.5}, 0.35)`
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

function scatterVegetation(scene, rand) {
  const colliders = []
  const m = new THREE.Matrix4()

  const nearWater = (x, z) => {
    const dx = x - POND.x, dz = z - POND.z
    if (dx * dx + dz * dz < (POND.r + 25) * (POND.r + 25)) return true
    if (riverNearest(x, z).d < 24) return true
    const mdx = x - MTN.x, mdz = z - MTN.z
    return mdx * mdx + mdz * mdz < 50 * 50 // rocky summit stays bare
  }

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
      } while (Math.abs(z) < 30 || nearWater(x, z))
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
      } while (nearWater(x, z))
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
      } while (nearWater(x, z))
      const s = 0.5 + rand() * 2.6
      m.makeRotationY(rand() * Math.PI).scale(new THREE.Vector3(s, s * 0.7, s))
        .setPosition(x, terrainHeight(x, z) + 0.3 * s, z)
      rocks.setMatrixAt(i, m)
    }
    scene.add(rocks)
  }

  return colliders
}
