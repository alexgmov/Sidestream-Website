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
        mobilePaidPrototype: path.resolve(
          __dirname,
          "generated/mobile-paid-prototype.html",
        ),
        account: path.resolve(__dirname, "account.html"),
        paidThankYou: path.resolve(__dirname, "paid-thank-you.html"),
        thankYou: path.resolve(__dirname, "thank-you.html"),
        sidestream: path.resolve(
          __dirname,
          "Sidestream front end 2/Sidestream.html",
        ),
      },
    },
  },
})
