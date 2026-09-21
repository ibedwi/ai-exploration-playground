import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The frontend lives in web/. Two aliases:
//   @        -> web/src   (app code)
//   @shared  -> shared/   (the event types the server also uses)
export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // allow importing files from outside web/ (i.e. shared/)
    fs: { allow: [fileURLToPath(new URL(".", import.meta.url))] },
  },
});
