import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  outfile: "dist/codex-transfer.mjs",
  platform: "node",
  target: "node18",
  format: "esm",
  banner: {
    js: "#!/usr/bin/env node\n",
  },
  external: [],
  minify: false,
  sourcemap: false,
});

console.log("✓ Built dist/codex-transfer.mjs");
