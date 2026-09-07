import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  platform: "browser",
  target: "es2018",
  outfile: "main.js",
  minify: true,
  sourcemap: false,
  banner: { js: "/* Safe WebDAV Sync — source: https://github.com/dmitriymentor/obsidian-safe-webdav-sync */" },
  define: { global: "globalThis" }
});
