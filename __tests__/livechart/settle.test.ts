import { PriorSettler } from "../../src/livechart/settle";
import { Posteriors } from "../../src/livechart/posterior";
import { buildPyramid } from "../../src/spatial/pyramid-build";
import { basin } from "../helpers/synthetic";

/** The background settler of living-chart priors (plan §4.13). */

const store = buildPyramid(basin([22.0, 60.0, 22.1, 60.1], 10), { minZoom: 12, leafZoom: 18 });

test("a cell that comes to wait during a run is settled when the run ends", async () => {
  const posteriors = new Posteriors(store);
  const settled: number[] = [];
  let late = false;
  const settler: PriorSettler = new PriorSettler(
    posteriors,
    () => store,
    () => {
      settled.push(settled.length);
      if (!late) {
        // A sounding in another cell while this run settles the first.
        late = true;
        posteriors.unsettled.add(2);
        settler.soon();
      }
    },
    (m) => {
      throw new Error(m);
    }
  );
  posteriors.unsettled.add(1);
  settler.soon();
  for (let i = 0; i < 10 && posteriors.unsettled.size > 0; i++) {
    await settler.done();
    await new Promise((r) => setImmediate(r));
  }
  expect(posteriors.unsettled.size).toBe(0);
  expect(settled).toHaveLength(2);
});
