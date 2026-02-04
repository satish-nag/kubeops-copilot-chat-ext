import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: false,
  minify: true,
  external: [
    "vscode"
    // IMPORTANT: keep vscode external; VS Code provides it at runtime
  ],
  define: {
    "process.env.NODE_ENV": '"production"'
  }
});

console.log("Bundled -> dist/extension.js");