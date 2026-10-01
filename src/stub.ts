import type { Env } from "./env";

/** Everything lives in one Durable Object: a friend group's worth of summonses is tiny. */
export function bureauStub(env: Env) {
  return env.BUREAU.get(env.BUREAU.idFromName("bureau"));
}

/** The single live connection to Discord's Gateway, used to hear DMs sent to the bot. */
export function gatewayStub(env: Env) {
  return env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));
}
