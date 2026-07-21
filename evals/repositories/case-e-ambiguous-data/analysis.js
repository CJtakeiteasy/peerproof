import { readFile } from "node:fs/promises";

const selected = process.argv[2];
if (!selected) throw new Error("A data file argument is required");
const csv = await readFile(selected, "utf8");
process.stdout.write(`${JSON.stringify({ rows: csv.trim().split(/\r?\n/).length - 1 })}\n`);
