import "@paper-design/shaders-react"

declare module "@paper-design/shaders-react" {
  interface MeshGradientProps {
    backgroundColor?: string
    wireframe?: string | boolean
  }

  interface DotOrbitProps {
    dotColor?: string
    intensity?: number
    orbitColor?: string
  }
}
