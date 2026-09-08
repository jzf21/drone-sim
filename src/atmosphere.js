import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Time of day
// ---------------------------------------------------------------------------
// The whole look of the sim hangs off one number: the hour on a 24h clock.
// Each keyframe below is a complete description of the sky at that hour — sun
// angle, light colour, haze, exposure — and everything between two keyframes is
// interpolated, so scrubbing the clock moves the sun, recolours the light,
// thickens the fog and re-exposes the frame together rather than one at a time.
//
// `azim` is unwrapped rather than kept in 0..360 so it increases monotonically
// across the table; lerping wrapped angles would swing the sun backwards across
// the sky between the last night key and the first dawn one.

// One dial for the whole day: scales every keyframe's fog density. Lower is
// clearer. Below about 0.25 the distant range stops reading as layered at all;
// above about 0.7 the ridges lose their colour and flatten into the horizon.
const HAZE = 0.4

const DEG = Math.PI / 180
const SUN_DIST = 338      // matches the length of the original fixed sun offset

const KEYS = [
  {
    h: 0, name: 'NIGHT',
    elev: 52, azim: -40,                 // after dark the moon stands in for the sun
    light: 0x9fb6de, lightI: 0.35,
    skyC: 0x33486e, groundC: 0x11161d, hemiI: 0.40,
    zenith: 0x04060e, horizon: 0x0f1626, haze: 0x18202f,
    disc: 0xdfeaff, discP: 12000, discI: 1.6, haloI: 0.06,
    warm: 0x24304a, warmI: 0.30, stars: 1.0,
    fog: 0x0f1626, fogD: 0.0019,
    exposure: 1.35, envI: 0.60,
  },
  {
    h: 5.4, name: 'PRE-DAWN',
    elev: 4, azim: 78,
    light: 0x8fa8c8, lightI: 0.45,
    skyC: 0x4a5f84, groundC: 0x1a1f26, hemiI: 0.55,
    zenith: 0x0d1830, horizon: 0x4c4360, haze: 0x6a5a6a,
    disc: 0xffc9a0, discP: 5000, discI: 0.50, haloI: 0.10,
    warm: 0x8a5a72, warmI: 0.70, stars: 0.55,
    fog: 0x4c4360, fogD: 0.0021,
    exposure: 1.25, envI: 0.70,
  },
  {
    h: 6.6, name: 'DAWN',
    elev: 7, azim: 84,
    light: 0xffbf87, lightI: 1.70,
    skyC: 0x9ab4d8, groundC: 0x2e3328, hemiI: 0.70,
    zenith: 0x2b5f9e, horizon: 0xd9a582, haze: 0xe8bd9a,
    disc: 0xfff0d8, discP: 1400, discI: 2.60, haloI: 0.34,
    warm: 0xff9a5c, warmI: 0.95, stars: 0.12,
    fog: 0xd9a582, fogD: 0.0019,
    exposure: 1.05, envI: 0.90,
  },
  {
    h: 9.0, name: 'MORNING',
    elev: 34, azim: 118,
    light: 0xfff0d2, lightI: 2.60,
    skyC: 0xbcd8f2, groundC: 0x3a5230, hemiI: 0.85,
    zenith: 0x2a63ad, horizon: 0xb7d2e6, haze: 0xd2dee4,
    disc: 0xfff6e2, discP: 900, discI: 2.20, haloI: 0.20,
    warm: 0xffd0a0, warmI: 0.35, stars: 0,
    fog: 0xb7d2e6, fogD: 0.0013,
    exposure: 0.95, envI: 1.00,
  },
  {
    h: 12.5, name: 'NOON',
    elev: 62, azim: 175,
    light: 0xfff6e8, lightI: 3.10,
    skyC: 0xcfe8ff, groundC: 0x3a5230, hemiI: 0.95,
    zenith: 0x2458a0, horizon: 0xa9cbe0, haze: 0xcbd8dd,
    disc: 0xfffaf0, discP: 900, discI: 2.00, haloI: 0.16,
    warm: 0xffe0c0, warmI: 0.15, stars: 0,
    fog: 0xa9cbe0, fogD: 0.0012,
    exposure: 0.90, envI: 1.00,
  },
  {
    h: 16.0, name: 'AFTERNOON',
    elev: 33, azim: 232,
    light: 0xffe6bc, lightI: 2.70,
    skyC: 0xc6ddf5, groundC: 0x3f5330, hemiI: 0.85,
    zenith: 0x2a5fa6, horizon: 0xbcd0de, haze: 0xd8dcd8,
    disc: 0xfff4dc, discP: 900, discI: 2.20, haloI: 0.22,
    warm: 0xffc890, warmI: 0.40, stars: 0,
    fog: 0xbcd0de, fogD: 0.0013,
    exposure: 0.93, envI: 1.00,
  },
  {
    h: 17.8, name: 'GOLDEN',
    elev: 11, azim: 252,
    light: 0xffb56b, lightI: 2.90,
    skyC: 0xbcc9e0, groundC: 0x4a4326, hemiI: 0.70,
    zenith: 0x2d5f9a, horizon: 0xf0b878, haze: 0xf6cf9e,
    disc: 0xfff2d0, discP: 1200, discI: 3.20, haloI: 0.42,
    warm: 0xff9440, warmI: 1.00, stars: 0,
    fog: 0xefc191, fogD: 0.0016,
    exposure: 0.98, envI: 0.95,
  },
  {
    h: 19.3, name: 'DUSK',
    elev: 6, azim: 266,
    light: 0xff8a4e, lightI: 1.50,
    skyC: 0x8f93b4, groundC: 0x2f2b24, hemiI: 0.60,
    zenith: 0x1d3f7d, horizon: 0xe0754a, haze: 0xecac7e,
    disc: 0xffd9a8, discP: 2200, discI: 2.40, haloI: 0.50,
    warm: 0xff6a34, warmI: 1.00, stars: 0.05,
    fog: 0xd98a62, fogD: 0.0019,
    exposure: 1.05, envI: 0.85,
  },
  {
    h: 20.4, name: 'TWILIGHT',
    elev: 8, azim: 276,
    light: 0x8f8fc0, lightI: 0.55,
    skyC: 0x5a6690, groundC: 0x1e2028, hemiI: 0.50,
    zenith: 0x0d1c3e, horizon: 0x6b4a68, haze: 0x8a6272,
    disc: 0xffb98a, discP: 6000, discI: 0.60, haloI: 0.22,
    warm: 0xb85a5a, warmI: 0.85, stars: 0.50,
    fog: 0x6b4a68, fogD: 0.0021,
    exposure: 1.20, envI: 0.70,
  },
  {
    h: 21.8, name: 'NIGHT',
    elev: 45, azim: 300,
    light: 0x9fb6de, lightI: 0.35,
    skyC: 0x33486e, groundC: 0x11161d, hemiI: 0.40,
    zenith: 0x04060e, horizon: 0x0f1626, haze: 0x18202f,
    disc: 0xdfeaff, discP: 12000, discI: 1.6, haloI: 0.06,
    warm: 0x24304a, warmI: 0.30, stars: 1.0,
    fog: 0x0f1626, fogD: 0.0019,
    exposure: 1.35, envI: 0.60,
  },
]

// The table wraps: midnight is both ends of it. Rather than special-case the
// seam in the lookup, append a copy of the first key at h = 24.
// Its azimuth is the first key's plus a full turn, so the sun sweeps exactly
// 360 degrees over the day and does not jump across the seam.
KEYS.push({ ...KEYS[0], h: 24, azim: KEYS[0].azim + 360 })

const COLOR_FIELDS = ['light', 'skyC', 'groundC', 'zenith', 'horizon', 'haze', 'disc', 'warm', 'fog']
const NUM_FIELDS = ['elev', 'azim', 'lightI', 'hemiI', 'discP', 'discI', 'haloI', 'warmI', 'stars', 'fogD', 'exposure', 'envI']

// Pre-resolve the hex literals so sampling never allocates a Color.
const TABLE = KEYS.map((k) => {
  const out = { h: k.h, name: k.name }
  for (const f of NUM_FIELDS) out[f] = k[f]
  for (const f of COLOR_FIELDS) out[f] = new THREE.Color(k[f])
  return out
})

// Scratch state that `sample` writes into, so the per-frame path is allocation free.
const S = { name: '' }
for (const f of NUM_FIELDS) S[f] = 0
for (const f of COLOR_FIELDS) S[f] = new THREE.Color()

function sample(hour) {
  const h = ((hour % 24) + 24) % 24
  let i = 0
  while (i < TABLE.length - 2 && TABLE[i + 1].h <= h) i++
  const a = TABLE[i]
  const b = TABLE[i + 1]
  const t = (h - a.h) / (b.h - a.h)
  for (const f of NUM_FIELDS) S[f] = a[f] + (b[f] - a[f]) * t
  for (const f of COLOR_FIELDS) S[f].lerpColors(a[f], b[f], t)
  // The phase name is whichever keyframe we are closer to, so the HUD reads
  // GOLDEN across the whole golden stretch rather than only at 17:48.
  S.name = t < 0.5 ? a.name : b.name
  return S
}

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------

const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`

const SKY_FRAG = `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 haze;
  uniform vec3 warm;
  uniform vec3 disc;
  uniform vec3 sunDir;
  uniform float discPower;
  uniform float discInt;
  uniform float haloInt;
  uniform float warmInt;
  uniform float starInt;
  uniform float uTime;
  varying vec3 vDir;

  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  // Sparse points on a 3D lattice sampled along the view ray. Cheaper than a
  // star texture and it never shows a seam at the poles.
  float stars(vec3 d) {
    vec3 p = d * 240.0;
    vec3 c = floor(p);
    float h = hash31(c);
    if (h < 0.9955) return 0.0;
    vec3 o = fract(p) - 0.5;
    float mag = 0.35 + 0.65 * hash31(c + 7.0);
    float twinkle = 0.75 + 0.25 * sin(uTime * 2.2 + h * 400.0);
    return smoothstep(0.32, 0.02, length(o)) * mag * twinkle;
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 c = mix(horizon, zenith, smoothstep(0.0, 0.55, d.y));
    c = mix(haze, c, smoothstep(-0.18, 0.04, d.y));

    // Stars sit behind the gradient, so haze and moonglow wash them out on
    // their own as the sky brightens.
    c += vec3(0.9, 0.94, 1.0) * stars(d) * starInt;

    // Sunset reddening: a warm band that only shows low down and only on the
    // sun's side of the sky, which is what sells a low sun more than the sun
    // disc itself does.
    float side = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0);
    float low = smoothstep(0.34, -0.06, d.y);
    c = mix(c, warm, pow(side, 3.0) * low * warmInt);

    float s = max(dot(d, sunDir), 0.0);
    c += disc * pow(s, discPower) * discInt;
    c += disc * pow(s, 14.0) * haloInt;

    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

// ---------------------------------------------------------------------------

/**
 * Owns everything the sun touches: the sky dome, both lights, the fog, the fog, the
 * environment map the metals reflect, and the tone-mapping exposure. Driving
 * `setHour` is the only way any of those should be changed.
 */
export function createAtmosphere(scene, renderer, { hour = 17.8 } = {}) {
  let h = hour
  let cycleRate = 0        // hours per second when the clock is running
  let time = 0

  const uniforms = {
    zenith: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    haze: { value: new THREE.Color() },
    warm: { value: new THREE.Color() },
    disc: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3() },
    discPower: { value: 900 },
    discInt: { value: 2 },
    haloInt: { value: 0.2 },
    warmInt: { value: 0 },
    starInt: { value: 0 },
    uTime: { value: 0 },
  }

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
  })

  const sky = new THREE.Mesh(new THREE.SphereGeometry(2500, 32, 16), skyMat)
  sky.renderOrder = -1
  sky.frustumCulled = false
  scene.add(sky)

  // A second dome on the same material, kept in its own scene purely so the
  // PMREM pass has something small to render. Sharing the material means it
  // always matches the sky you can actually see.
  const envScene = new THREE.Scene()
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMat))
  const pmrem = new THREE.PMREMGenerator(renderer)
  let envRT = null
  let envHour = null

  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3a5230, 0.9)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xfff2d9, 1.6)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  const sc = sun.shadow.camera
  // Tight frustum that rides with the drone, so everything near it casts
  // shadows. 4096 over 460 m is ~0.11 m/texel, which is what keeps the long
  // raked shadows of a low sun from turning into stair steps.
  sc.left = -230; sc.right = 230; sc.top = 230; sc.bottom = -230
  // A low sun sits only ~35 m above the terrain, so the old near plane of 40
  // would have clipped the whole scene out of the shadow map at dawn and dusk.
  sc.near = 1; sc.far = 900
  sun.shadow.bias = -0.0005
  sun.shadow.normalBias = 0.5
  scene.add(sun)
  scene.add(sun.target)

  scene.fog = new THREE.FogExp2(0xa9cbe0, 0.0012 * HAZE)

  const sunDir = new THREE.Vector3()
  const sunOffset = new THREE.Vector3()
  // Cloud sprites are unlit, so they have to be tinted by hand or they stay
  // noon-white against a midnight sky. Haze gives them the ambient they sit in,
  // the key light gives them the colour of whatever is lighting them.
  const cloudColor = new THREE.Color()

  function apply() {
    const s = sample(h)

    const el = s.elev * DEG
    const az = s.azim * DEG
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize()
    sunOffset.copy(sunDir).multiplyScalar(SUN_DIST)

    sun.color.copy(s.light)
    sun.intensity = s.lightI
    hemi.color.copy(s.skyC)
    hemi.groundColor.copy(s.groundC)
    hemi.intensity = s.hemiI

    uniforms.zenith.value.copy(s.zenith)
    uniforms.horizon.value.copy(s.horizon)
    uniforms.haze.value.copy(s.haze)
    uniforms.warm.value.copy(s.warm)
    uniforms.disc.value.copy(s.disc)
    uniforms.sunDir.value.copy(sunDir)
    uniforms.discPower.value = s.discP
    uniforms.discInt.value = s.discI
    uniforms.haloInt.value = s.haloI
    uniforms.warmInt.value = s.warmI
    uniforms.starInt.value = s.stars

    cloudColor.copy(s.haze).lerp(s.light, 0.55)

    scene.fog.color.copy(s.fog)
    scene.fog.density = s.fogD * HAZE

    renderer.toneMappingExposure = s.exposure
    scene.environmentIntensity = s.envI

    return s
  }

  // Re-baking the environment every frame during a cycle would be wasteful and
  // the reflections do not change fast enough to notice, so only rebuild it
  // once the clock has moved far enough to matter.
  function refreshEnv(force = false) {
    if (!force && envHour !== null && Math.abs(h - envHour) < 0.15) return
    const next = pmrem.fromScene(envScene, 0, 1, 100)
    if (envRT) envRT.dispose()
    envRT = next
    envHour = h
    scene.environment = envRT.texture
  }

  apply()
  refreshEnv(true)

  let label = ''
  function setLabel(s) {
    const hh = ((h % 24) + 24) % 24
    const m = Math.floor((hh % 1) * 60)
    label = `${String(Math.floor(hh)).padStart(2, '0')}:${String(m).padStart(2, '0')} ${s.name}`
  }
  setLabel(sample(h))

  return {
    sun,
    sky,
    cloudColor,
    get hour() { return ((h % 24) + 24) % 24 },
    get label() { return label },
    get cycling() { return cycleRate !== 0 },

    setHour(v) {
      h = ((v % 24) + 24) % 24
      setLabel(apply())
      refreshEnv()
    },

    /** Hours per second; 0 stops the clock. */
    setCycle(rate) { cycleRate = rate },

    /**
     * @param dt      frame time
     * @param focus   where the shadow frustum should be centred (the drone)
     * @param groundY terrain height under `focus`
     * @param camPos  camera position, so the dome stays centred on the eye
     */
    update(dt, focus, groundY, camPos) {
      time += dt
      uniforms.uTime.value = time
      if (cycleRate !== 0) {
        h = ((h + cycleRate * dt) % 24 + 24) % 24
        setLabel(apply())
        refreshEnv()
      }
      // Sun rides with the drone so the shadow frustum covers wherever we fly.
      sun.position.copy(focus).add(sunOffset)
      sun.target.position.set(focus.x, groundY, focus.z)
      sky.position.copy(camPos)
    },

    dispose() {
      envRT?.dispose()
      pmrem.dispose()
      skyMat.dispose()
      sky.geometry.dispose()
    },
  }
}
