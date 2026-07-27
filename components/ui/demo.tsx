"use client"

import { useState } from "react"
import { DotOrbit, MeshGradient } from "@paper-design/shaders-react"

const meshColors = ["#000000", "#151515", "#292929", "#a3a3a3"]

export default function DemoOne() {
  const [intensity] = useState(1.5)
  const [speed] = useState(1.0)
  const [activeEffect] = useState("mesh")

  return (
    <div className="w-full h-full bg-black relative overflow-hidden">
      {activeEffect === "mesh" && (
        <MeshGradient
          className="w-full h-full absolute inset-0"
          colors={meshColors}
          speed={speed}
          backgroundColor="#000000"
        />
      )}

      {activeEffect === "dots" && (
        <div className="w-full h-full absolute inset-0 bg-black">
          <DotOrbit
            className="w-full h-full"
            dotColor="#292929"
            orbitColor="#151515"
            speed={speed}
            intensity={intensity}
          />
        </div>
      )}

      {activeEffect === "combined" && (
        <>
          <MeshGradient
            className="w-full h-full absolute inset-0"
            colors={meshColors}
            speed={speed * 0.5}
            wireframe="true"
            backgroundColor="#000000"
          />
          <div className="w-full h-full absolute inset-0 opacity-60">
            <DotOrbit
              className="w-full h-full"
              dotColor="#292929"
              orbitColor="#151515"
              speed={speed * 1.5}
              intensity={intensity * 0.8}
            />
          </div>
        </>
      )}

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-8 left-8 pointer-events-auto"></div>
        <div className="absolute bottom-8 left-8 pointer-events-auto"></div>
        <div className="absolute bottom-8 right-8 pointer-events-auto space-y-4"></div>
        <div className="absolute top-8 right-8 pointer-events-auto"></div>
      </div>

      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-1/4 left-1/3 w-32 h-32 bg-gray-800/5 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: `${3 / speed}s` }}
        />
        <div
          className="absolute bottom-1/3 right-1/4 w-24 h-24 bg-white/2 rounded-full blur-2xl animate-pulse"
          style={{ animationDuration: `${2 / speed}s`, animationDelay: "1s" }}
        />
        <div
          className="absolute top-1/2 right-1/3 w-20 h-20 bg-gray-900/3 rounded-full blur-xl animate-pulse"
          style={{ animationDuration: `${4 / speed}s`, animationDelay: "0.5s" }}
        />
      </div>
    </div>
  )
}
