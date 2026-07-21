import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const packageMetadata = JSON.parse(readFileSync(packageFile, "utf8"));

export const VERSION = packageMetadata.version;
