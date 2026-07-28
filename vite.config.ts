import path from "node:path"
import { rmSync } from "node:fs"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const stripLocalOnlyPaidPrototype = {
  name: "strip-local-only-paid-prototype",
  closeBundle() {
    rmSync(path.resolve(__dirname, "dist/mobile-paid-prototype.html"), {
      force: true,
    })
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stripLocalOnlyPaidPrototype],
  resolve: {
    alias: {
      "@": __dirname,
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "index.html"),
        account: path.resolve(__dirname, "account.html"),
        thankYou: path.resolve(__dirname, "thank-you.html"),
        sidestream: path.resolve(
          __dirname,
          "Sidestream front end 2/Sidestream.html",
        ),
      },
    },
  },
})
