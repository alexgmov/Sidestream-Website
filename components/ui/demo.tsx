"use client"

import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { DotOrbit, MeshGradient, ShaderMount } from "@paper-design/shaders-react"
import type { PaperShaderElement } from "@paper-design/shaders-react"

const meshColors = ["#000000", "#151515", "#292929", "#a3a3a3"]
const meshGradientBaseUniforms = {
  u_distortion: 0.8,
  u_swirl: 0.1,
  u_grainMixer: 0,
  u_grainOverlay: 0,
  u_fit: 1,
  u_scale: 1,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
}

const interactiveMeshGradientFragmentShader = `#version 300 es
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;

uniform vec4 u_colors[10];
uniform float u_colorsCount;

uniform float u_distortion;
uniform float u_swirl;
uniform float u_grainMixer;
uniform float u_grainOverlay;

uniform vec2 u_pointer;
uniform vec2 u_velocity;
uniform float u_wake;
uniform float u_wakeDirection;
uniform float u_interactionEnabled;

in vec2 v_objectUV;
out vec4 fragColor;

#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846

vec2 rotate(vec2 uv, float th) {
  return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}

float hash21(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794)) + 0.1;
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float valueNoise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x1 = mix(a, b, u.x);
  float x2 = mix(c, d, u.x);
  return mix(x1, x2, u.y);
}

float noise(vec2 n, vec2 seedOffset) {
  return valueNoise(n + seedOffset);
}

vec2 getPosition(int i, float t) {
  float a = float(i) * .37;
  float b = .6 + fract(float(i) / 3.) * .9;
  float c = .8 + fract(float(i + 1) / 4.);

  float x = sin(t * b + a);
  float y = cos(t * c + a * 1.5);

  return .5 + .5 * vec2(x, y);
}

void main() {
  vec2 uv = v_objectUV;
  uv += .5;

  vec2 pointer = clamp(u_pointer, vec2(0.), vec2(1.));
  float aspect = max(u_resolution.x / max(u_resolution.y, 1.), .001);
  vec2 delta = uv - pointer;
  vec2 metricDelta = vec2(delta.x * aspect, delta.y);
  float pointerDistance = length(metricDelta);
  float wake = clamp(u_wake, 0., 1.) * u_interactionEnabled;
  float pressure = exp(-pointerDistance * pointerDistance / .022) * wake;
  float softRing = exp(-pow(pointerDistance - .2, 2.) / .005) * wake;
  vec2 tangent = vec2(-delta.y, delta.x);
  tangent /= max(length(tangent), 1e-4);
  uv += (-u_velocity * .86 + tangent * u_wakeDirection * .016) * pressure;
  uv -= delta * softRing * .032;

  vec2 grainUV = uv * 1000.;

  float grain = noise(grainUV, vec2(0.));
  float mixerGrain = .4 * u_grainMixer * (grain - .5);

  const float firstFrameOffset = 41.5;
  float t = .5 * (u_time + firstFrameOffset);

  float radius = smoothstep(0., 1., length(uv - .5));
  float center = 1. - radius;
  for (float i = 1.; i <= 2.; i++) {
    uv.x += u_distortion * center / i * sin(t + i * .4 * smoothstep(.0, 1., uv.y)) * cos(.2 * t + i * 2.4 * smoothstep(.0, 1., uv.y));
    uv.y += u_distortion * center / i * cos(t + i * 2. * smoothstep(.0, 1., uv.x));
  }

  vec2 uvRotated = uv;
  uvRotated -= vec2(.5);
  float angle = 3. * u_swirl * radius;
  uvRotated = rotate(uvRotated, -angle);
  uvRotated += vec2(.5);

  vec3 color = vec3(0.);
  float opacity = 0.;
  float totalWeight = 0.;

  for (int i = 0; i < 10; i++) {
    if (i >= int(u_colorsCount)) break;

    vec2 pos = getPosition(i, t) + mixerGrain;
    vec3 colorFraction = u_colors[i].rgb * u_colors[i].a;
    float opacityFraction = u_colors[i].a;

    float dist = length(uvRotated - pos);

    dist = pow(dist, 3.5);
    float weight = 1. / (dist + 1e-3);
    color += colorFraction * weight;
    opacity += opacityFraction * weight;
    totalWeight += weight;
  }

  color /= max(1e-4, totalWeight);
  opacity /= max(1e-4, totalWeight);

  float grainOverlay = valueNoise(rotate(grainUV, 1.) + vec2(3.));
  grainOverlay = mix(grainOverlay, valueNoise(rotate(grainUV, 2.) + vec2(-1.)), .5);
  grainOverlay = pow(grainOverlay, 1.3);

  float grainOverlayV = grainOverlay * 2. - 1.;
  vec3 grainOverlayColor = vec3(step(0., grainOverlayV));
  float grainOverlayStrength = u_grainOverlay * abs(grainOverlayV);
  grainOverlayStrength = pow(grainOverlayStrength, .8);
  color = mix(color, grainOverlayColor, .35 * grainOverlayStrength);

  opacity += .5 * grainOverlayStrength;
  opacity = clamp(opacity, 0., 1.);

  fragColor = vec4(color, opacity);
}
`

function hexToRgba(hex: string): [number, number, number, number] {
  const value = hex.replace(/^#/, "")
  const normalized = value.length === 3
    ? value.split("").map((character) => character + character).join("")
    : value
  const withAlpha = normalized.length === 6 ? `${normalized}ff` : normalized

  return [
    parseInt(withAlpha.slice(0, 2), 16) / 255,
    parseInt(withAlpha.slice(2, 4), 16) / 255,
    parseInt(withAlpha.slice(4, 6), 16) / 255,
    parseInt(withAlpha.slice(6, 8), 16) / 255,
  ]
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function usePointerWake(shaderRef: RefObject<PaperShaderElement | null>) {
  useEffect(() => {
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)")
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let isEnabled = finePointer.matches && !reducedMotion.matches
    let frame = 0

    const wake = {
      active: false,
      currentX: 0.5,
      currentY: 0.5,
      targetX: 0.5,
      targetY: 0.5,
      velocityX: 0,
      velocityY: 0,
      targetVelocityX: 0,
      targetVelocityY: 0,
      amount: 0,
      targetAmount: 0,
      direction: 1,
      lastEventTime: performance.now(),
    }

    const setInteractionEnabled = () => {
      shaderRef.current?.paperShaderMount?.setUniforms({
        u_interactionEnabled: isEnabled ? 1 : 0,
      })
    }

    const handleMediaChange = () => {
      isEnabled = finePointer.matches && !reducedMotion.matches
      if (!isEnabled) {
        wake.active = false
        wake.targetAmount = 0
        wake.targetVelocityX = 0
        wake.targetVelocityY = 0
      }
      setInteractionEnabled()
    }

    const settleWake = () => {
      wake.active = false
      wake.targetAmount = 0
      wake.targetVelocityX = 0
      wake.targetVelocityY = 0
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!isEnabled || (event.pointerType !== "mouse" && event.pointerType !== "pen")) {
        return
      }

      const width = Math.max(window.innerWidth, 1)
      const height = Math.max(window.innerHeight, 1)
      const nextX = clamp(event.clientX / width, 0, 1)
      const nextY = clamp(1 - event.clientY / height, 0, 1)
      const now = performance.now()
      const frameScale = 16.67 / Math.max(now - wake.lastEventTime, 16.67)
      const deltaX = nextX - wake.targetX
      const deltaY = nextY - wake.targetY
      const nextVelocityX = clamp(deltaX * frameScale, -0.06, 0.06)
      const nextVelocityY = clamp(deltaY * frameScale, -0.06, 0.06)
      const impulse = clamp(Math.hypot(deltaX, deltaY) * 58, 0, 1)

      wake.active = true
      wake.targetX = nextX
      wake.targetY = nextY
      wake.targetVelocityX = wake.targetVelocityX * 0.35 + nextVelocityX * 0.65
      wake.targetVelocityY = wake.targetVelocityY * 0.35 + nextVelocityY * 0.65
      wake.targetAmount = Math.max(wake.targetAmount, impulse)
      wake.direction = wake.targetVelocityX + wake.targetVelocityY * 0.55 >= 0 ? 1 : -1
      wake.lastEventTime = now
    }

    const tick = () => {
      wake.currentX += (wake.targetX - wake.currentX) * 0.18
      wake.currentY += (wake.targetY - wake.currentY) * 0.18
      wake.velocityX += (wake.targetVelocityX - wake.velocityX) * 0.16
      wake.velocityY += (wake.targetVelocityY - wake.velocityY) * 0.16
      wake.amount += (wake.targetAmount - wake.amount) * 0.12

      wake.targetAmount *= wake.active ? 0.91 : 0.84
      wake.targetVelocityX *= 0.9
      wake.targetVelocityY *= 0.9

      shaderRef.current?.paperShaderMount?.setUniforms({
        u_pointer: [wake.currentX, wake.currentY],
        u_velocity: [wake.velocityX, wake.velocityY],
        u_wake: isEnabled ? wake.amount : 0,
        u_wakeDirection: wake.direction,
        u_interactionEnabled: isEnabled ? 1 : 0,
      })

      frame = window.requestAnimationFrame(tick)
    }

    finePointer.addEventListener("change", handleMediaChange)
    reducedMotion.addEventListener("change", handleMediaChange)
    window.addEventListener("pointermove", handlePointerMove, { passive: true })
    window.addEventListener("pointerleave", settleWake)
    window.addEventListener("blur", settleWake)
    document.addEventListener("visibilitychange", settleWake)
    setInteractionEnabled()
    frame = window.requestAnimationFrame(tick)

    return () => {
      window.cancelAnimationFrame(frame)
      finePointer.removeEventListener("change", handleMediaChange)
      reducedMotion.removeEventListener("change", handleMediaChange)
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerleave", settleWake)
      window.removeEventListener("blur", settleWake)
      document.removeEventListener("visibilitychange", settleWake)
    }
  }, [shaderRef])
}

function InteractiveMeshGradient({ speed }: { speed: number }) {
  const shaderRef = useRef<PaperShaderElement | null>(null)
  usePointerWake(shaderRef)

  const uniforms = useMemo(() => ({
    ...meshGradientBaseUniforms,
    u_colors: meshColors.map(hexToRgba),
    u_colorsCount: meshColors.length,
    u_pointer: [0.5, 0.5],
    u_velocity: [0, 0],
    u_wake: 0,
    u_wakeDirection: 1,
    u_interactionEnabled: 1,
  }), [])

  return (
    <ShaderMount
      ref={shaderRef}
      className="w-full h-full absolute inset-0"
      data-pointer-wake="true"
      fragmentShader={interactiveMeshGradientFragmentShader}
      speed={speed}
      uniforms={uniforms}
    />
  )
}

export default function DemoOne() {
  const [intensity] = useState(1.5)
  const [speed] = useState(1.0)
  const [activeEffect] = useState("mesh")

  return (
    <div className="w-full h-screen bg-black relative overflow-hidden">
      {activeEffect === "mesh" && (
        <InteractiveMeshGradient speed={speed} />
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
            colors={["#000000", "#151515", "#292929", "#a3a3a3"]}
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

      {/* UI Overlay */}
      <div className="absolute inset-0 pointer-events-none">
        {/* Header */}
        <div className="absolute top-8 left-8 pointer-events-auto"></div>

        {/* Effect Controls */}
        <div className="absolute bottom-8 left-8 pointer-events-auto"></div>

        {/* Parameter Controls */}
        <div className="absolute bottom-8 right-8 pointer-events-auto space-y-4"></div>

        {/* Status indicator */}
        <div className="absolute top-8 right-8 pointer-events-auto"></div>
      </div>

      {/* Lighting overlay effects */}
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
