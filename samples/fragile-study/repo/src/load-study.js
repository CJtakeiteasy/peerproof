import { readFile } from "node:fs/promises";

const DATA_PATH = "/Users/original-author/Desktop/lighthouse/data/study.csv";

export async function loadStudyRows() {
  const csv = await readFile(DATA_PATH, "utf8");
  return csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const [id, x, y] = line.split(",");
    return { id, x: Number(x), y: Number(y) };
  });
}
