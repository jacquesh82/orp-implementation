#!/usr/bin/env node
/**
 * Build of the published packages (@optirelay/core, optical, browser):
 * ESM JavaScript + type declarations in dist/, one file per source file.
 *
 * In the monorepo the packages export their TypeScript sources (Vite and
 * Vitest compile them); on npm they export dist/ (`publishConfig` of each
 * package.json, applied by `pnpm publish`). The sources import each other
 * with a `.ts` extension: the specifiers are rewritten to `.js`, including
 * the Worker URL of @optirelay/browser (`new URL("./reader-worker.ts", …)`),
 * which the consumer's bundler then follows.
 *
 * @optirelay/browser also ships the examples/ of the repository, their
 * `workspace:*` dependencies replaced by the published version.
 *
 * Usage: node scripts/build-packages.mjs
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES = ["core", "optical", "browser"];

function files(dir, extension) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}

/** "./x.ts" → "./x.js" in import/export specifiers, dynamic imports and new URL(). */
function rewriteSpecifiers(path) {
  const source = readFileSync(path, "utf8");
  const rewritten = source.replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, "$1$2.js$1");
  if (rewritten !== source) writeFileSync(path, rewritten);
}

for (const name of PACKAGES) {
  const dir = join(root, "packages", name);
  const dist = join(dir, "dist");
  rmSync(dist, { recursive: true, force: true });

  // JavaScript: transpiled file by file (no bundling: the package keeps its
  // modules, the consumer's bundler tree-shakes).
  await build({
    entryPoints: files(join(dir, "src"), ".ts"),
    outdir: dist,
    outbase: join(dir, "src"),
    format: "esm",
    platform: "neutral",
    target: "es2022",
    sourcemap: true,
    logLevel: "warning",
  });

  // Declarations: tsc on src/ only (the tests stay out).
  const tsconfig = join(dir, "tsconfig.build.json");
  writeFileSync(
    tsconfig,
    JSON.stringify({
      extends: "./tsconfig.json",
      compilerOptions: { noEmit: false, emitDeclarationOnly: true, declaration: true, declarationMap: false, sourceMap: false, rootDir: "src", outDir: "dist" },
      include: ["src/**/*.ts"],
    }),
  );
  try {
    execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", tsconfig], { stdio: "inherit" });
  } finally {
    rmSync(tsconfig);
  }

  for (const f of [...files(dist, ".js"), ...files(dist, ".d.ts")]) rewriteSpecifiers(f);
  cpSync(join(root, "LICENSE"), join(dir, "LICENSE"));

  if (name === "browser") {
    const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    const target = join(dir, "examples");
    rmSync(target, { recursive: true, force: true });
    cpSync(join(root, "examples"), target, {
      recursive: true,
      // examples/tsconfig.json extends the monorepo's: not shipped (the
      // Studio keeps its own, standalone).
      filter: (src) => !/node_modules|dist/.test(relative(root, src)) && relative(root, src) !== join("examples", "tsconfig.json"),
    });
    // Range of the minor release (the packages of a release share it, but
    // a patch of one package alone does not bump the others).
    const range = `^${version.split(".").slice(0, 2).join(".")}.0`;
    for (const example of ["hello-world", "secure-hello-world"]) {
      const manifest = join(target, example, "package.json");
      writeFileSync(manifest, readFileSync(manifest, "utf8").replaceAll('"workspace:*"', `"${range}"`));
    }
  }
  console.log(`@optirelay/${name}: dist/ built (${files(dist, ".js").length} modules)`);
}

if (!existsSync(join(root, "packages/browser/examples/README.md"))) throw new Error("examples not copied");
