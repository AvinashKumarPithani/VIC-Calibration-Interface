import assert from "node:assert/strict";
import test from "node:test";
import { ValueRequestGuard } from "./valueRequestGuard.ts";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("a late layer response cannot replace soil_density after switching variables", async () => {
  const guard = new ValueRequestGuard();
  let displayedView = null;
  const load = async (request) => {
    const generation = guard.begin();
    const result = await request;
    if (guard.isCurrent(generation)) displayedView = result;
  };

  const layerRequest = deferred();
  const layerLoad = load(layerRequest.promise);

  // Changing the variable invalidates the outstanding request before the new
  // selection starts loading.
  guard.invalidate();
  const soilDensityRequest = deferred();
  const soilDensityLoad = load(soilDensityRequest.promise);

  soilDensityRequest.resolve({
    variable: "soil_density",
    indices: [[0, 0, 0]],
    values: [2685.0],
  });
  await soilDensityLoad;

  // The older layer response arrives last and must not update the displayed view.
  layerRequest.resolve({ variable: "layer", indices: [[0]], values: [1] });
  await layerLoad;

  assert.deepEqual(displayedView, {
    variable: "soil_density",
    indices: [[0, 0, 0]],
    values: [2685.0],
  });
});
