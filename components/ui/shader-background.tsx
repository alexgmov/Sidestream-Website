"use client"

import { MeshGradient } from "@paper-design/shaders-react"

export function ShaderBackground() {
  return (
    <div className="fixed inset-0 -z-10 h-full w-full overflow-hidden bg-black">
      <MeshGradient
        className="absolute inset-0 h-full w-full opacity-82"
        colors={["#000000", "#0d0d0d", "#202020", "#4a4a4a"]}
        distortion={0.58}
        grainMixer={0}
        grainOverlay={0}
        speed={0.55}
        swirl={0.28}
      />
      <div className="absolute inset-0 bg-black/42" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(255,255,255,0.12),transparent_36%)]" />
    </div>
  )
}
