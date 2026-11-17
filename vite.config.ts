import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  // Audio worklets are loaded as ES modules; the NAM worklet imports the wasm glue code.
  worker: { format: "es" },
});
