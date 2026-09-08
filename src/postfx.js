import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

// Only emitters brighter than this bloom. Every lit surface tops out at 1.0, so
// keeping the threshold there means the glow is reserved for things that are
// actually meant to be light sources — nav lights, beacons, the scan ring, the
// sun disc — and hazy terrain never smears.
const BLOOM_THRESHOLD = 1.0
const BLOOM_STRENGTH = 0.6
const BLOOM_RADIUS = 0.5

/**
 * Renders the scene through a linear HDR buffer so values above 1.0 survive to
 * be bloomed, then tone maps once at the end. Replaces `renderer.render`.
 */
export function createPostFX(renderer, scene, camera) {
  const w = window.innerWidth
  const h = window.innerHeight

  // The canvas `antialias` flag does nothing once we render through a composer,
  // so the geometry pass gets MSAA of its own instead.
  const target = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    samples: 4,
  })

  const composer = new EffectComposer(renderer, target)
  composer.addPass(new RenderPass(scene, camera))

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w, h), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD
  )
  composer.addPass(bloom)

  // Applies the renderer's tone mapping and output colour space, which the
  // intermediate passes deliberately skipped.
  composer.addPass(new OutputPass())

  // The composer scales whatever it is given by the renderer's pixel ratio, so
  // pass CSS pixels here exactly as we do to `renderer.setSize`.
  composer.setSize(w, h)

  return {
    bloom,
    render() { composer.render() },
    setSize(width, height) { composer.setSize(width, height) },
    dispose() {
      composer.dispose()
      target.dispose()
    },
  }
}
