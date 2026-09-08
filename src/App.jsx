import React, { useEffect, useRef, useState } from 'react'
import { createSim } from './sim.js'

const LINE_LEN = 140 * 6

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

  useEffect(() => {
    const sim = createSim(canvasRef.current, {
      onTelemetry: setTelem,
      onDetect: (p) => setDetected((prev) => [p, ...prev]),
      onReady: setModelInfo,
    })
    return () => sim.dispose()
  }, [])

  const faults = detected.filter((d) => d.status === 'FAULT')

  return (
    <div className="app">
      <canvas ref={canvasRef} />

      <div className="hud panel top-left">
        <h1>⚡ POWERLINE INSPECTION DRONE</h1>
        <div className="controls">
          <span><b>W A S D</b> move</span>
          <span><b>SPACE / SHIFT</b> up / down</span>
          <span><b>Q / E</b> or <b>← →</b> yaw</span>
        </div>
        <div className="hint">Fly within the cyan scan ring of line hardware to log it. Red = needs service.</div>
      </div>

      {telem && (
        <div className="hud panel top-right">
          <div className="telem-row"><span>ALT</span><b>{telem.y.toFixed(1)} m</b></div>
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
          {telem.nearest && !telem.nearest.detected && (
            <div className="nearest">nearest target: {telem.nearest.dist.toFixed(0)} m</div>
          )}
        </div>
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

      <div className="hud credit">
        {modelInfo && <>model: {modelInfo} · </>}three.js + react
      </div>
    </div>
  )
}
