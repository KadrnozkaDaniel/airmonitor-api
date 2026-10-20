import { test } from "node:test";
import * as assert from "node:assert/strict";
import { build } from "../../helper";
import { measurementsResponseSchema } from "../../../src/schemas/measurement.schema";

test("GET /mesurements/ - returns measurements matching the schema", async (t) => {
  const app = await build(t);

  const response = await app.inject({
    method: "GET",
    url: "/mesurements/",
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  const body = response.json();

  measurementsResponseSchema.parse(body);

  assert.deepEqual(body, [
    {
      id: 1,
      temperature: 22.5,
      humidity: 48,
    },
  ]);
});
