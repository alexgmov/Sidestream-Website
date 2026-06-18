import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { ShaderBackground } from "@/components/ui/shader-background"

import "./index.css"

const backgroundRoot = document.getElementById("shader-background-root")

if (backgroundRoot) {
  createRoot(backgroundRoot).render(
    <StrictMode>
      <ShaderBackground />
    </StrictMode>,
  )
}
