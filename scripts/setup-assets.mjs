import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const wasmDst = new URL("public/wasm/", root);
mkdirSync(wasmDst, { recursive: true });
cpSync(new URL("node_modules/@mediapipe/tasks-vision/wasm", root), wasmDst, { recursive: true });

const MODELS = {
  "hand_landmarker.task":
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  "pose_landmarker_full.task":
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
};
const modelDst = new URL("public/models/", root);
mkdirSync(modelDst, { recursive: true });
for (const [name, url] of Object.entries(MODELS)) {
  const file = new URL(name, modelDst);
  if (existsSync(file)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${name}`);
}
