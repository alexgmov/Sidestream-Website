import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vite"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "index.html"),
        sidestream: path.resolve(
          __dirname,
          "Sidestream front end 2/Sidestream.html",
        ),
      },
    },
  },
})
