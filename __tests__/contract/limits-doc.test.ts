import fs from "fs";
import path from "path";
import { QUERY_LIMITS } from "../../src/api/query-request";

/**
 * The navigation-safety README is the contract's standalone record of the
 * limits that can refuse a valid request, so its `POST /query` rows must
 * state the values the parser enforces.
 */

const README = fs.readFileSync(
  path.join(__dirname, "..", "..", "schemas", "navigation-safety", "README.md"),
  "utf8"
);
const queryRows = README.split("\n").filter((line) => line.includes("of `POST /query`"));

test.each([
  ["positions", `4..${QUERY_LIMITS.maxPoints} positions`],
  ["box across", `bounding box ≤ ${QUERY_LIMITS.maxPolygonMetres / 1000} km across`],
  ["widened box", `widened by the buffer ≤ ${QUERY_LIMITS.maxAreaKm2} km²`],
  ["vertices × area", `vertices × that widened box ≤ ${QUERY_LIMITS.maxVertexKm2} km²`]
])("the README's query row for %s matches QUERY_LIMITS", (_name, text) => {
  expect(queryRows.some((row) => row.includes(text))).toBe(true);
});
