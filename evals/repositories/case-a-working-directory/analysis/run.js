import { readFile } from "node:fs/promises";

const csv = await readFile("./data/study.csv", "utf8");
process.stdout.write(`${JSON.stringify({ rows: csv.trim().split(/\r?\n/).length - 1 })}\n`);
