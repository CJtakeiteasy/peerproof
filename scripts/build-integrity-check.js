import path from "node:path";
import { fileURLToPath } from "node:url";
import { admitApplicationBuild } from "../src/build-integrity.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receipt = await admitApplicationBuild(projectRoot);
process.stdout.write(
  `PASS application build · ${receipt.fileCount} governed files · ${receipt.buildManifestSha256}\n`
    + `PASS runtime closure · ${receipt.runtimeClosure.productModuleCount} product modules · ${receipt.runtimeClosure.evaluationModuleCount} policy-evaluation modules\n`
    + `PASS runtime assets · ${receipt.assetClosure.registeredAssetCount} registered assets · ${receipt.assetClosure.registeredPolicyCount} policy bundles\n`,
);
