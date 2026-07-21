import { readFile } from "node:fs/promises";

const csv = await readFile(new URL("../data/study.csv", import.meta.url), "utf8");
process.stdout.write(`${JSON.stringify({ rows: csv.trim().split(/\r?\n/).length - 1 })}\n`);
