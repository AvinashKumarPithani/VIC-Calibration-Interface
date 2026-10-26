import assert from "node:assert/strict";
import test from "node:test";
import { defaultSelectors, editKey, filterVariablesWithSelection, matchesVariableView, setPendingEdit } from "./netcdfEditorState.ts";
import { ValueRequestGuard } from "./valueRequestGuard.ts";

test("variable switch resets leading dimensions while preserving the final two as grid axes", () => {
  assert.deepEqual(defaultSelectors([3, 73, 45]), [0, null, null]);
  assert.deepEqual(defaultSelectors([2, 3, 4, 5]), [0, 0, null, null]);
  assert.deepEqual(defaultSelectors([6]), [null]);
  assert.deepEqual(defaultSelectors([]), []);
});

test("searching elev cannot visually replace the selected layer option", () => {
  const variables = [
    { name: "layer", dimensions: ["nlayer"], shape: [3], data_type: "int32" },
    { name: "elev", dimensions: ["lat", "lon"], shape: [73, 45], data_type: "float64" },
    { name: "soil_density", dimensions: ["nlayer", "lat", "lon"], shape: [3, 73, 45], data_type: "float64" },
  ];
  const searched = filterVariablesWithSelection(variables, "elev", "layer");
  assert.deepEqual(searched.map((item) => item.name), ["layer", "elev"]);
  assert.equal(searched[0].name, "layer");
  const afterChoosingElev = filterVariablesWithSelection(variables, "elev", "elev");
  assert.deepEqual(afterChoosingElev.map((item) => item.name), ["elev"]);
  assert.deepEqual(afterChoosingElev[0].dimensions, ["lat", "lon"]);
  assert.deepEqual(afterChoosingElev[0].shape, [73, 45]);
});

test("dimension selections and cell edits use explicit full indices", () => {
  const selectors = defaultSelectors([3, 73, 45]);
  selectors[0] = 2;
  assert.deepEqual(selectors, [2, null, null]);
  let pending = new Map();
  pending = setPendingEdit(pending, { variable: "soil_density", indices: [2, 5, 7], value: 2730 }, 2685);
  assert.equal(pending.get(editKey([2, 5, 7])).value, 2730);
  pending = setPendingEdit(pending, { variable: "soil_density", indices: [2, 5, 7], value: 2685 }, 2685);
  assert.equal(pending.size, 0);
});

test("value metadata and cells are accepted only for the selected variable and slice", () => {
  const layer = { variable: "layer", selectors: [null], dimensions: ["nlayer"], shape: [3], indices: [[0], [1], [2]], values: [1, 2, 3] };
  const elev = { variable: "elev", selectors: [null, null], dimensions: ["lat", "lon"], shape: [2, 2], indices: [[0, 0], [0, 1], [1, 0], [1, 1]], values: [0.41, 1.25, 5.75, 8] };
  const soil = { variable: "soil_density", selectors: [1, null, null], dimensions: ["nlayer", "lat", "lon"], shape: [3, 2, 2], indices: [[1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1]], values: [2685, 2685, 2685, 2685] };
  assert.equal(matchesVariableView(layer, "layer", [null]), true);
  assert.equal(matchesVariableView(elev, "elev", [null, null], ["lat", "lon"], [2, 2]), true);
  assert.equal(matchesVariableView(soil, "soil_density", [1, null, null], ["nlayer", "lat", "lon"], [3, 2, 2]), true);
  assert.equal(matchesVariableView(layer, "elev", [null, null]), false);
  assert.equal(matchesVariableView(elev, "soil_density", [1, null, null]), false);
  assert.equal(matchesVariableView(elev, "elev", [null, null], ["nlayer"], [3]), false);
});

test("delayed layer and elev results cannot replace the selected soil_density grid", async () => {
  const guard = new ValueRequestGuard();
  let displayed = null;
  let resolveLayer, resolveElev;
  const layer = new Promise((resolve) => { resolveLayer = resolve; });
  const layerGeneration = guard.begin();
  const layerLoad = layer.then((result) => { if (guard.isCurrent(layerGeneration)) displayed = result; });
  guard.invalidate();
  const elev = new Promise((resolve) => { resolveElev = resolve; });
  const elevGeneration = guard.begin();
  const elevLoad = elev.then((result) => { if (guard.isCurrent(elevGeneration)) displayed = result; });
  guard.invalidate();
  const soilGeneration = guard.begin();
  displayed = { variable: "soil_density", dimensions: ["nlayer", "lat", "lon"], shape: [3, 2, 2], selectors: [0, null, null], indices: [[0, 0, 0]], values: [2685] };
  resolveElev({ variable: "elev", dimensions: ["lat", "lon"], shape: [2, 2], selectors: [null, null], indices: [[0, 0]], values: [0.41] });
  resolveLayer({ variable: "layer", dimensions: ["nlayer"], shape: [3], selectors: [null], indices: [[0]], values: [1] });
  await Promise.all([layerLoad, elevLoad]);
  assert.equal(guard.isCurrent(soilGeneration), true);
  assert.equal(displayed.variable, "soil_density");
  assert.deepEqual(displayed.dimensions, ["nlayer", "lat", "lon"]);
  assert.deepEqual(displayed.values, [2685]);
});
