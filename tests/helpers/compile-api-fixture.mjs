import { execFileSync } from "node:child_process";
import path from "node:path";

/** Compiles only a fixture's real entrypoints and their imported dependency graph. */
export function compileApiFixture(entries, outDir, root = process.cwd()) {
  execFileSync(path.join(root, "node_modules", ".bin", "tsc"), [
    "--target", "ES2023",
    "--lib", "ES2023",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    "--skipLibCheck",
    "--types", "node",
    "--allowSyntheticDefaultImports",
    "--strict",
    "--rootDir", root,
    "--outDir", outDir,
    ...entries,
  ], { cwd: root });
}
