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
const wakeUniformNames = [
  "u_wake0",
  "u_wake1",
  "u_wake2",
  "u_wake3",
  "u_wake4",
  "u_wake5",
  "u_wake6",
  "u_wake7",
  "u_wake8",
  "u_wake9",
] as const
const wakeMotionUniformNames = [
  "u_wakeMotion0",
  "u_wakeMotion1",
  "u_wakeMotion2",
  "u_wakeMotion3",
  "u_wakeMotion4",
  "u_wakeMotion5",
  "u_wakeMotion6",
  "u_wakeMotion7",
  "u_wakeMotion8",
  "u_wakeMotion9",
] as const
const emptyWakeUniform: [number, number, number, number] = [0.5, 0.5, 99, 0]
const emptyWakeMotionUniform: [number, number, number, number] = [1, 0, 0, 0]

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

uniform float u_interactionEnabled;
uniform vec4 u_wake0;
uniform vec4 u_wake1;
uniform vec4 u_wake2;
uniform vec4 u_wake3;
uniform vec4 u_wake4;
uniform vec4 u_wake5;
uniform vec4 u_wake6;
uniform vec4 u_wake7;
uniform vec4 u_wake8;
uniform vec4 u_wake9;
uniform vec4 u_wakeMotion0;
uniform vec4 u_wakeMotion1;
uniform vec4 u_wakeMotion2;
uniform vec4 u_wakeMotion3;
uniform vec4 u_wakeMotion4;
uniform vec4 u_wakeMotion5;
uniform vec4 u_wakeMotion6;
uniform vec4 u_wakeMotion7;
uniform vec4 u_wakeMotion8;
uniform vec4 u_wakeMotion9;

in vec2 v_objectUV;
out vec4 fragColor;

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

vec2 curlNoise(vec2 p, vec2 seedOffset) {
  float e = .035;
  float n1 = noise(p + vec2(0., e), seedOffset);
  float n2 = noise(p - vec2(0., e), seedOffset);
  float n3 = noise(p + vec2(e, 0.), seedOffset);
  float n4 = noise(p - vec2(e, 0.), seedOffset);
  return vec2(n1 - n2, n4 - n3) / (2. * e);
}

vec3 wakeContribution(vec2 uv, vec4 wake, vec4 motion, float aspect, float time) {
  if (wake.w <= 0. || wake.z < 0. || wake.z > 2.65) {
    return vec3(0.);
  }

  vec2 center = clamp(wake.xy, vec2(0.), vec2(1.));
  vec2 delta = uv - center;
  vec2 metricDelta = vec2(delta.x * aspect, delta.y);
  float dist = max(length(metricDelta), 1e-4);
  vec2 radial = vec2(metricDelta.x / aspect, metricDelta.y);
  radial /= max(length(radial), 1e-4);
  vec2 tangent = vec2(-radial.y, radial.x);

  vec2 flowDirMetric = vec2(motion.x * aspect, motion.y);
  if (length(flowDirMetric) < 1e-4) {
    flowDirMetric = vec2(1., 0.);
  } else {
    flowDirMetric = normalize(flowDirMetric);
  }
  vec2 flowDirUv = vec2(flowDirMetric.x / aspect, flowDirMetric.y);
  flowDirUv /= max(length(flowDirUv), 1e-4);
  vec2 normalMetric = vec2(-flowDirMetric.y, flowDirMetric.x);
  vec2 normalUv = vec2(normalMetric.x / aspect, normalMetric.y);
  normalUv /= max(length(normalUv), 1e-4);

  float age = wake.z;
  float speed = clamp(motion.z, 0., 1.);
  float seed = motion.w;
  float fadeIn = smoothstep(0., .1, age);
  float fadeOut = 1. - smoothstep(1.25, 2.65, age);
  float fade = fadeIn * fadeOut * wake.w;

  float behind = dot(metricDelta, -flowDirMetric);
  float side = dot(metricDelta, normalMetric);
  float trailLength = .1 + speed * .2 + age * .052;
  float trailWidth = .052 + speed * .06 + age * .042;
  float trail = smoothstep(-.028, .07, behind)
    * exp(-(behind * behind) / max(trailLength * trailLength, 1e-4))
    * exp(-(side * side) / max(trailWidth * trailWidth, 1e-4));
  float coreWidth = .038 + speed * .032 + age * .018;
  float core = exp(-(dist * dist) / max(coreWidth * coreWidth, 1e-4));

  vec2 curl = curlNoise(
    uv * (4.2 + speed * 2.2) + center * 2.7 + vec2(time * .024, -time * .018),
    vec2(seed, seed * .37)
  );
  float roll = sin(time * .72 + age * 4.9 + seed + dist * 8.5);
  float shear = sin(side * 18. + seed + age * 3.4) * trail;

  vec2 offset = -flowDirUv * trail * (.01 + speed * .018)
    + tangent * core * roll * (.009 + speed * .012)
    + normalUv * shear * (.004 + speed * .006)
    + curl * (trail * .008 + core * .004);
  float shade = (core * roll * .18 + shear * .13 + (curl.x + curl.y) * trail * .09) * fade;

  return vec3(offset * fade, shade);
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

  float aspect = max(u_resolution.x / max(u_resolution.y, 1.), .001);
  vec3 wake = wakeContribution(uv, u_wake0, u_wakeMotion0, aspect, u_time)
    + wakeContribution(uv, u_wake1, u_wakeMotion1, aspect, u_time)
    + wakeContribution(uv, u_wake2, u_wakeMotion2, aspect, u_time)
    + wakeContribution(uv, u_wake3, u_wakeMotion3, aspect, u_time)
    + wakeContribution(uv, u_wake4, u_wakeMotion4, aspect, u_time)
    + wakeContribution(uv, u_wake5, u_wakeMotion5, aspect, u_time)
    + wakeContribution(uv, u_wake6, u_wakeMotion6, aspect, u_time)
    + wakeContribution(uv, u_wake7, u_wakeMotion7, aspect, u_time)
    + wakeContribution(uv, u_wake8, u_wakeMotion8, aspect, u_time)
    + wakeContribution(uv, u_wake9, u_wakeMotion9, aspect, u_time);

  uv += wake.xy * u_interactionEnabled;

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
  color = clamp(color + vec3(clamp(wake.z, -.8, .8) * .028 * u_interactionEnabled), vec3(0.), vec3(1.));

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

type PointerWake = {
  x: number
  y: number
  startedAt: number
  strength: number
  dirX: number
  dirY: number
  speed: number
  spin: number
}

function useFluidWake(shaderRef: RefObject<PaperShaderElement | null>) {
  useEffect(() => {
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)")
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let isEnabled = finePointer.matches && !reducedMotion.matches
    let frame = 0
    let lastWakeTime = 0
    let lastWakeX = 0.5
    let lastWakeY = 0.5
    let wakeSpin = 0
    const wakeLifetime = 2650
    const wakes: PointerWake[] = []
    const pointer = {
      x: 0.5,
      y: 0.5,
      lastEventTime: performance.now(),
      hasPointer: false,
    }

    const queueWake = (
      x: number,
      y: number,
      dirX: number,
      dirY: number,
      speed: number,
      startedAt: number,
    ) => {
      wakeSpin += 1.618
      wakes.push({
        x,
        y,
        dirX,
        dirY,
        startedAt,
        speed,
        strength: clamp(0.14 + speed * 0.4, 0.14, 0.54),
        spin: wakeSpin,
      })
      lastWakeTime = startedAt
      lastWakeX = x
      lastWakeY = y

      if (wakes.length > wakeUniformNames.length * 2) {
        wakes.splice(0, wakes.length - wakeUniformNames.length * 2)
      }
    }

    const getWakeUniforms = (now: number) => {
      for (let index = wakes.length - 1; index >= 0; index -= 1) {
        if (now - wakes[index].startedAt > wakeLifetime) {
          wakes.splice(index, 1)
        }
      }

      const uniforms: Record<string, [number, number, number, number]> = {}
      wakeUniformNames.forEach((name, index) => {
        const motionName = wakeMotionUniformNames[index]
        const wake = wakes[wakes.length - 1 - index]
        uniforms[name] = wake
          ? [wake.x, wake.y, Math.max(0, (now - wake.startedAt) / 1000), wake.strength]
          : emptyWakeUniform
        if (motionName) {
          uniforms[motionName] = wake
            ? [wake.dirX, wake.dirY, wake.speed, wake.spin]
            : emptyWakeMotionUniform
        }
      })
      return uniforms
    }

    const setInteractionEnabled = () => {
      shaderRef.current?.paperShaderMount?.setUniforms({
        u_interactionEnabled: isEnabled ? 1 : 0,
      })
    }

    const handleMediaChange = () => {
      isEnabled = finePointer.matches && !reducedMotion.matches
      if (!isEnabled) {
        wakes.length = 0
        pointer.hasPointer = false
      }
      setInteractionEnabled()
    }

    const settleWake = () => {
      pointer.hasPointer = false
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

      if (!pointer.hasPointer) {
        pointer.x = nextX
        pointer.y = nextY
        pointer.lastEventTime = now
        pointer.hasPointer = true
        lastWakeTime = now
        lastWakeX = nextX
        lastWakeY = nextY
        return
      }

      const dt = Math.max(now - pointer.lastEventTime, 16.67)
      const frameScale = 16.67 / dt
      const deltaX = nextX - pointer.x
      const deltaY = nextY - pointer.y
      const movement = Math.hypot(deltaX, deltaY)

      if (movement > 0.0035) {
        const dirX = deltaX / movement
        const dirY = deltaY / movement
        const distanceFromLastWake = Math.hypot(nextX - lastWakeX, nextY - lastWakeY)
        if (now - lastWakeTime > 24 || distanceFromLastWake > 0.016) {
          const sampleCount = Math.min(4, Math.max(1, Math.ceil(distanceFromLastWake / 0.022)))
          const speed = clamp(movement * frameScale * 24, 0.05, 1)
          const wakeStartX = lastWakeX
          const wakeStartY = lastWakeY

          for (let index = 1; index <= sampleCount; index += 1) {
            const progress = index / sampleCount
            queueWake(
              wakeStartX + (nextX - wakeStartX) * progress,
              wakeStartY + (nextY - wakeStartY) * progress,
              dirX,
              dirY,
              speed,
              now - (sampleCount - index) * 14,
            )
          }
        }
      }

      pointer.x = nextX
      pointer.y = nextY
      pointer.lastEventTime = now
    }

    const tick = () => {
      const now = performance.now()
      shaderRef.current?.paperShaderMount?.setUniforms({
        u_interactionEnabled: isEnabled ? 1 : 0,
        ...getWakeUniforms(now),
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
  useFluidWake(shaderRef)

  const uniforms = useMemo(() => {
    const wakeUniforms = wakeUniformNames.reduce<Record<string, [number, number, number, number]>>((uniforms, name, index) => {
      const motionName = wakeMotionUniformNames[index]
      uniforms[name] = emptyWakeUniform
      if (motionName) {
        uniforms[motionName] = emptyWakeMotionUniform
      }
      return uniforms
    }, {})

    return {
      ...meshGradientBaseUniforms,
      u_colors: meshColors.map(hexToRgba),
      u_colorsCount: meshColors.length,
      u_interactionEnabled: 0,
      ...wakeUniforms,
    }
  }, [])

  return (
    <ShaderMount
      ref={shaderRef}
      className="w-full h-full absolute inset-0"
      data-pointer-current="true"
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
