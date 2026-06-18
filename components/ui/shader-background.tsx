"use client"

import { Canvas } from "@react-three/fiber"
import { MeshGradient } from "@paper-design/shaders-react"

import { ShaderPlane } from "@/components/ui/background-paper-shaders"

export function ShaderBackground() {
  return (
    <div className="fixed inset-0 -z-10 h-full w-full overflow-hidden bg-black">
      <MeshGradient
        className="absolute inset-0 h-full w-full opacity-90"
        colors={["#000000", "#1a1a1a", "#333333", "#ffffff"]}
        distortion={0.82}
        grainMixer={0}
        grainOverlay={0}
        speed={0.7}
        swirl={0.42}
      />
      <Canvas
        className="absolute inset-0 h-full w-full opacity-40 mix-blend-screen"
        camera={{ position: [0, 0, 5], fov: 50 }}
      >
        <ShaderPlane position={[-1.85, 1.15, 0]} />
        <ShaderPlane position={[1.9, -1.2, -0.4]} color1="#333333" />
      </Canvas>
      <div className="absolute inset-0 bg-black/42" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,rgba(255,255,255,0.16),transparent_34%)]" />
    </div>
  )
}
