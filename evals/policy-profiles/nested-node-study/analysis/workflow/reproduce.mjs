import { readFile } from "node:fs/promises";

const csv = await readFile(new URL("../data/values.csv", import.meta.url), "utf8");
const rows = csv.trim().split(/\r?\n/).slice(1).map((line) => {
  const [id, rawValue] = line.split(",");
  return { id, value: Number(rawValue) };
});
const mean = rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
process.stdout.write(`${JSON.stringify({ schemaVersion: "nested-node-result.v1", rows: rows.length, mean })}\n`);
