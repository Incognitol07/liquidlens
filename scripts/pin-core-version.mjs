// Rewrites @liquidlens/react's `@liquidlens/core: workspace:*` dependency to a real,
// published version range right before `npm publish` runs.
//
// pnpm rewrites `workspace:*` automatically on publish, but trusted publishing
// (OIDC) has to go through `npm publish`, which does not understand the
// workspace protocol. So we pin it ourselves to the latest published core.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pkgPath = fileURLToPath(
  new URL("../packages/react/package.json", import.meta.url),
);
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const coreVersion = execSync("npm view @liquidlens/core version", {
  encoding: "utf8",
}).trim();

if (!/^\d+\.\d+\.\d+/.test(coreVersion)) {
  throw new Error(`Unexpected @liquidlens/core version from npm: "${coreVersion}"`);
}

pkg.dependencies["@liquidlens/core"] = `^${coreVersion}`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`Pinned @liquidlens/core to ^${coreVersion} for publish.`);
