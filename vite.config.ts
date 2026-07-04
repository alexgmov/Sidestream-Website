import path from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
        upgrade: path.resolve(__dirname, "upgrade.html"),
        sidestream: path.resolve(
          __dirname,
          "Sidestream front end 2/Sidestream.html",
        ),
      },
    },
  },
})
