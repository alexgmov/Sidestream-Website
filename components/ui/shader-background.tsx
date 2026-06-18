"use client"

import { DotOrbit, MeshGradient } from "@paper-design/shaders-react"

export function ShaderBackground() {
  const speed = 1.0

  return (
    <div
      className="pointer-events-none fixed inset-0 z-0 h-screen w-screen overflow-hidden bg-black"
      style={{
        background: "#000000",
        height: "100vh",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        position: "fixed",
        width: "100vw",
        zIndex: 0,
      }}
    >
      <MeshGradient
        className="absolute inset-0 h-full w-full"
        colors={["#000000", "#1a1a1a", "#333333", "#ffffff"]}
        distortion={0.74}
        grainMixer={0}
        grainOverlay={0}
        speed={speed}
        swirl={0.34}
      />

      <div className="absolute inset-0 opacity-60">
        <DotOrbit
          className="h-full w-full"
          colorBack="#000000"
          colors={["#333333", "#1a1a1a", "#ffffff", "#0a0a0a"]}
          scale={0.72}
          size={0.18}
          sizeRange={0.62}
          spreading={0.72}
          stepsPerColor={2}
          speed={speed * 1.5}
        />
      </div>

      <div className="absolute inset-0 bg-black/34" />
      <div className="absolute inset-0 bg-[linear-gradient(135deg,transparent_0%,rgba(255,255,255,0.08)_36%,transparent_52%,rgba(255,255,255,0.04)_72%,transparent_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,rgba(255,255,255,0.10),transparent_38%)]" />
    </div>
  )
}
