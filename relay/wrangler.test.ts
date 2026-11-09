import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Limiter { name: string; namespace_id: string }
interface WorkerConfig {
  name?: string;
  routes?: unknown[];
  workers_dev?: boolean;
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  ratelimits?: Limiter[];
  analytics_engine_datasets?: { binding: string; dataset: string }[];
}

const config = Bun.TOML.parse(readFileSync(join(import.meta.dir, "wrangler.toml"), "utf8")) as WorkerConfig & { env?: Record<string, WorkerConfig> };
const staging = config.env?.["staging"] ?? {};

test("the staging Worker gets a workers.dev address only, under a name of its own: never relay.ovis.sh", () => {
  // an environment inherits `routes` unless it names its own, and the top level's is relay.ovis.sh
  expect(staging.routes).toEqual([]);
  expect(staging.workers_dev).toBe(true);
  expect(staging.name).toBeString();
  expect(staging.name).not.toBe(config.name);
});

test("the staging Worker binds what the Worker reads (an environment inherits no binding), with limiters and usage apart from production's", () => {
  expect(staging.durable_objects).toEqual(config.durable_objects!);
  expect(staging.ratelimits?.map((limiter) => limiter.name)).toEqual(config.ratelimits!.map((limiter) => limiter.name));
  const production = new Set(config.ratelimits!.map((limiter) => limiter.namespace_id));
  expect(staging.ratelimits!.filter((limiter) => production.has(limiter.namespace_id))).toEqual([]);
  expect(staging.analytics_engine_datasets?.map((dataset) => dataset.binding)).toEqual(config.analytics_engine_datasets!.map((dataset) => dataset.binding));
  const counted = new Set(config.analytics_engine_datasets!.map((dataset) => dataset.dataset));
  expect(staging.analytics_engine_datasets!.filter((dataset) => counted.has(dataset.dataset))).toEqual([]);
});
