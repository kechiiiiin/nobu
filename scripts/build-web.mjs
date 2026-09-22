// web/main.tsx → public/build/*.js（ESM・スキャン部分は別チャンクで遅延読み込み）
// ZXing の wasm は jsDelivr に頼らず public/build/ から配る
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}public/build`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [`${root}web/main.tsx`],
  outdir: out,
  bundle: true,
  splitting: true,
  format: "esm",
  minify: true,
  sourcemap: false,
  target: ["es2020", "safari16"],
  jsx: "automatic",
  jsxImportSource: "preact",
  chunkNames: "chunk-[hash]",
  logLevel: "warning",
});
copyFileSync(`${root}node_modules/zxing-wasm/dist/reader/zxing_reader.wasm`, `${out}/zxing_reader.wasm`);
console.log("web: built public/build/");
