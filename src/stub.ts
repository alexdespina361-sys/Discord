import type { Env } from "./env";

/** Everything lives in one Durable Object: a friend group's worth of summonses is tiny. */
export function bureauStub(env: Env) {
  return env.BUREAU.get(env.BUREAU.idFromName("bureau"));
}
