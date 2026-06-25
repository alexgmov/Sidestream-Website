import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Analytics } from "@vercel/analytics/react"

import DemoOne from "@/components/ui/demo"

import "./index.css"

const backgroundRoot = document.getElementById("shader-background-root")

if (backgroundRoot) {
  createRoot(backgroundRoot).render(
    <StrictMode>
      <DemoOne />
      <Analytics />
    </StrictMode>,
  )
}
