import React, { useEffect, useRef, useState } from 'react'
import { createSim } from './sim.js'

const LINE_LEN = 140 * 6

// How the exposure meter reads, and what to do about it.
const THREAT = {
  HIDDEN: {
    mark: '\u25cb', label: 'UNDETECTED',
    hint: 'Nothing has eyes on you. Stay low and slow — speed and altitude both give you away.',
  },
  SUSPECTED: {
    mark: '\u25d1', label: 'SEARCHING',
    hint: 'They are sweeping your last known position. Relocate before the search widens onto you.',
  },
  TRACKED: {
    mark: '\u25d5', label: 'IN SIGHT',
    hint: 'Break line of sight before the lock completes — put a hangar, a silo or a hillside between you.',
  },
  ENGAGED: {
    mark: '\u25c9', label: 'LOCKED ON',
    hint: 'Weapons free. Get behind hard cover; walls stop their rounds.',
  },
}

function headingLetter(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(deg / 45) % 8]
}

export default function App() {
  const canvasRef = useRef(null)
  const [telem, setTelem] = useState(null)
  const [detected, setDetected] = useState([])
  const [modelInfo, setModelInfo] = useState('')
  const listRef = useRef(null)
  // The waypoint is written straight to the DOM rather than through state: it
  // updates every frame, and re-rendering the whole HUD 60x a second to move
  // one marker would be wasteful.
  const wpRef = useRef(null)
  const wpArrowRef = useRef(null)
  const wpNameRef = useRef(null)
  const wpDistRef = useRef(null)

  useEffect(() => {
    const sim = createSim(canvasRef.current, {
      onTelemetry: setTelem,
      onDetect: (p) => setDetected((prev) => [p, ...prev]),
      onReady: setModelInfo,
      onWaypoint: (w) => {
        const el = wpRef.current
        if (!el) return
        // hide once delivered, and when you are close enough to just look at it
        if (w.done || w.dist < 30) { el.style.display = 'none'; return }
        el.style.display = ''

        let { x, y } = w
        if (w.behind) {
          // behind the camera the projected position is meaningless; only the
          // direction is, so push it well outside the viewport and let the
          // clamp below pin it to the correct edge
          const len = Math.hypot(x, y) || 1
          x = (x / len) * 2
          y = (y / len) * 2
        }
        const off = w.behind || Math.abs(x) > 1 || Math.abs(y) > 1
        if (off) {
          // scale the direction out to whichever screen edge it meets first
          const k = Math.min(1 / Math.max(Math.abs(x), 1e-6), 1 / Math.max(Math.abs(y), 1e-6))
          x *= k
          y *= k
        }
        const M = 7   // percent inset, so the marker never straddles the edge
        el.style.left = `${50 + x * (50 - M)}%`
        el.style.top = `${50 - y * (50 - M)}%`
        el.classList.toggle('offscreen', off)
        el.classList.toggle('active', w.active)
        // the chevron points up by default; screen direction is (x, -y)
        if (wpArrowRef.current) {
          wpArrowRef.current.style.transform =
            `rotate(${(Math.atan2(x, y) * 180) / Math.PI}deg)`
        }
        if (wpNameRef.current) {
          wpNameRef.current.textContent = w.active ? 'DELIVER HERE' : 'SAFEHOUSE'
        }
        if (wpDistRef.current) wpDistRef.current.textContent = `${w.dist.toFixed(0)} m`
      },
    })
    return () => sim.dispose()
  }, [])

  const faults = detected.filter((d) => d.status === 'FAULT')

  return (
    <div className="app">
      <canvas ref={canvasRef} />

      <div className="hud left-stack">
      <div className="panel top-left">
        <h1>⚡ POWERLINE INSPECTION DRONE</h1>
        <div className="controls">
          <span><b>W A S D</b> move</span>
          <span><b>SPACE / SHIFT</b> up / down</span>
          <span><b>Q / E</b> or <b>← →</b> yaw</span>
        </div>
        <div className="hint">
          Fly within the cyan scan ring of line hardware to log it. Red = needs service.
          Buildings, silos and hillsides block rival sightlines and stop their fire — use them.
        </div>
      </div>

      {telem && (
        <div className="panel mission">
          <h2>MISSION · CARGO RECOVERY</h2>
          {telem.mission === 'COMPLETE' ? (
            <div className="mission-line done">✔ Payload delivered — mission complete</div>
          ) : telem.mission === 'CARRYING' || telem.mission === 'DELIVERING' ? (
            <>
              <div className="mission-line hot">◆ PAYLOAD ABOARD — run it to the safehouse</div>
              <div className="telem-row small">
                <span>TO SAFEHOUSE</span><b>{telem.missionDist.toFixed(0)} m</b>
              </div>
              <div className="hint">
                Follow the green light column, west past the mountain. Fly in through
                the hangar mouth — it faces away from you — and hold over the pad.
              </div>
            </>
          ) : telem.mission === 'LOST' ? (
            <div className="mission-line lost">✖ Payload lost — it has reset to the enemy pad</div>
          ) : (
            <>
              <div className="mission-line">◆ Recover the cargo pod from the enemy landing pad</div>
              <div className="telem-row small">
                <span>TO PAD</span><b>{telem.missionDist.toFixed(0)} m</b>
              </div>
              <div className="hint">Follow the cyan light column. Hover low over the pad and hold to winch it aboard.</div>
            </>
          )}
          {telem.mission === 'SECURING' && (
            <>
              <div className="progress">
                <div className="bar securing" style={{ width: `${telem.secure * 100}%` }} />
              </div>
              <div className="telem-row small">
                <span>SECURING</span><b>{Math.round(telem.secure * 100)}%</b>
              </div>
            </>
          )}
          {telem.mission === 'DELIVERING' && (
            <>
              <div className="progress">
                <div className="bar delivering" style={{ width: `${telem.deliver * 100}%` }} />
              </div>
              <div className="telem-row small">
                <span>UNLOADING</span><b>{Math.round(telem.deliver * 100)}%</b>
              </div>
            </>
          )}
        </div>
      )}

      {telem && (
        <div className={`panel exposure ${telem.threat.toLowerCase()}`}>
          <h2>EXPOSURE</h2>
          <div className="threat-state">
            {THREAT[telem.threat].mark} {THREAT[telem.threat].label}
          </div>
          <div className="progress">
            <div className="bar exposure-bar" style={{ width: `${telem.exposure * 100}%` }} />
          </div>
          <div className="telem-row small">
            <span>EYES ON</span><b>{telem.eyesOn}/{telem.hostiles}</b>
          </div>
          {telem.inCover && <div className="cover-tag">\u25a3 IN COVER \u2014 sightlines blocked</div>}
          <div className="hint">{THREAT[telem.threat].hint}</div>
        </div>
      )}
      </div>

      {telem && (
        <div className="hud panel top-right">
          <div className="telem-row"><span>ALT</span><b>{telem.y.toFixed(1)} m</b></div>
          <div className="telem-row"><span>AGL</span><b>{telem.agl.toFixed(1)} m</b></div>
          <div className="telem-row"><span>SPD</span><b>{(telem.speed * 3.6).toFixed(0)} km/h</b></div>
          <div className="telem-row"><span>HDG</span><b>{telem.heading.toFixed(0)}° {headingLetter(telem.heading)}</b></div>
          <div className="telem-row"><span>POS</span><b>{telem.x.toFixed(0)}, {telem.z.toFixed(0)}</b></div>
          <div className="progress">
            <div className="bar" style={{ width: `${(telem.scanned / telem.total) * 100}%` }} />
          </div>
          <div className="telem-row small">
            <span>SCANNED</span><b>{telem.scanned}/{telem.total}</b>
          </div>
          <div className="telem-row small fault-count">
            <span>FAULTS</span><b>{telem.faults}</b>
          </div>
          <div className="telem-row small">
            <span>IMPACTS</span><b>{telem.hits}</b>
          </div>
          <div className="progress">
            <div
              className="bar"
              style={{
                width: `${telem.integrity}%`,
                background: telem.integrity > 50 ? '#21d07a' : telem.integrity > 25 ? '#ffb020' : '#ff5252',
              }}
            />
          </div>
          <div className="telem-row small">
            <span>INTEGRITY</span><b>{telem.integrity}%</b>
          </div>
          {telem.nearest && !telem.nearest.detected && (
            <div className="nearest">nearest target: {telem.nearest.dist.toFixed(0)} m</div>
          )}
        </div>
      )}

      {telem && telem.down && (
        <div className="hud down-overlay">
          <div className="down-title">DRONE DOWN</div>
          <div className="down-sub">
            {telem.mission === 'LOST'
              ? <>airframe destroyed, payload lost — press <b>R</b> to redeploy</>
              : <>airframe destroyed — press <b>R</b> to redeploy</>}
          </div>
        </div>
      )}
      {telem && telem.mission === 'COMPLETE' && (
        <div className="hud complete-overlay">
          <div className="complete-title">MISSION COMPLETE</div>
          <div className="complete-sub">cargo pod delivered to the safehouse</div>
        </div>
      )}
      {telem && telem.threat === 'ENGAGED' && !telem.down && (
        <div className="hud zone-banner">☠ LOCKED ON — RIVAL DRONES ENGAGING</div>
      )}
      {telem && telem.inZone && telem.threat !== 'ENGAGED' && !telem.down && (
        <div className="hud zone-notice">⌖ INSIDE HOSTILE PERIMETER</div>
      )}
      {telem && telem.recentDamage && !telem.down && <div className="hud damage-vignette" />}
      {telem && telem.recentHit && (
        <div className="hud warn-banner hit">✦ COLLISION ✦</div>
      )}
      {telem && !telem.recentHit && telem.obstacle !== null && (
        <div className="hud warn-banner">⚠ OBSTACLE {telem.obstacle.toFixed(1)} m</div>
      )}

      <div className="hud panel right-list">
        <h2>INSPECTION LOG</h2>
        <div className="list" ref={listRef}>
          {detected.length === 0 && <div className="empty">No components scanned yet — approach the line.</div>}
          {detected.map((d) => (
            <div key={d.id} className={`item ${d.status === 'FAULT' ? 'fault' : 'ok'}`}>
              <div className="item-head">
                <span className="badge">{d.status === 'FAULT' ? 'SERVICE' : 'OK'}</span>
                <span className="id">{d.id}</span>
              </div>
              <div className="item-body">
                {d.type} · {d.towerRef}
                {d.status === 'FAULT' && <div className="note">⚠ {d.note}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {telem && (
        <svg className="hud minimap" viewBox="0 0 300 90">
          <rect x="0" y="0" width="300" height="90" rx="6" className="mm-bg" />
          <line x1="20" y1="45" x2="280" y2="45" className="mm-line" />
          {Array.from({ length: 7 }, (_, i) => (
            <rect key={i} x={20 + (i * 260) / 6 - 2} y="41" width="4" height="8" className="mm-tower" />
          ))}
          {faults.map((f) => (
            <circle key={f.id}
              cx={20 + ((f.x + LINE_LEN / 2) / LINE_LEN) * 260}
              cy={45 + (f.z / 60) * 30}
              r="2.5" className="mm-fault" />
          ))}
          <g transform={`translate(${20 + ((telem.x + LINE_LEN / 2) / LINE_LEN) * 260}, ${45 + (telem.z / 60) * 30}) rotate(${-telem.heading + 90})`}>
            <polygon points="6,0 -4,4 -4,-4" className="mm-drone" />
          </g>
        </svg>
      )}

      <div className="hud waypoint" ref={wpRef} style={{ display: 'none' }}>
        <svg className="wp-mark wp-chevron" viewBox="0 0 32 32" ref={wpArrowRef}>
          <polygon points="16,3 26,26 16,20 6,26" />
        </svg>
        <svg className="wp-mark wp-reticle" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r="8.5" />
          <line x1="16" y1="1" x2="16" y2="6" />
          <line x1="16" y1="26" x2="16" y2="31" />
          <line x1="1" y1="16" x2="6" y2="16" />
          <line x1="26" y1="16" x2="31" y2="16" />
        </svg>
        <div className="wp-label">
          <span ref={wpNameRef}>SAFEHOUSE</span>
          <b ref={wpDistRef}>—</b>
        </div>
      </div>

      <div className="hud credit">
        {modelInfo && <>model: {modelInfo} · </>}three.js + react
      </div>
    </div>
  )
}
