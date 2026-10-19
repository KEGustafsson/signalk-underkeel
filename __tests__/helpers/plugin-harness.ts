import type { Delta, ServerAPI } from "@signalk/server-api";
import type { Clock } from "../../src/monitor";

/** A fake Signal K app, router and clock for plugin-level tests. */

interface FakeRes {
  json: (body: unknown) => void;
  send: (body: unknown) => void;
  type: (t: string) => FakeRes;
  status: (code: number) => FakeRes & { end: () => void };
}

type Handler = (
  req: { query?: Record<string, string>; params?: Record<string, string>; body?: unknown },
  res: FakeRes
) => void;

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function fakeClock(start: number): FakeClock {
  let now = start;
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    now: () => now,
    setInterval: (f) => {
      timers.set(next, f);
      return next++;
    },
    clearInterval: (h) => {
      timers.delete(h as number);
    },
    advance(ms: number) {
      now += ms;
      [...timers.values()].forEach((f) => f());
    }
  };
}

/** Matches any of the Signal K paths, where `*` stands for any run of characters. */
function pathPattern(paths: string[]): RegExp {
  const one = (p: string) =>
    p
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
  return new RegExp(`^(?:${paths.map(one).join("|")})$`);
}

/** Delivers the delta's values that one subscription matches, as the server does per subscription. */
function deliver(d: Delta, match: RegExp, cb: (d: Delta) => void): void {
  const updates = d.updates.flatMap((u) => {
    if (!("values" in u)) {
      return [u];
    }
    const values = u.values.filter((v) => match.test(v.path));
    return values.length > 0 ? [{ ...u, values }] : [];
  });
  if (updates.length > 0) {
    cb({ ...d, updates } as Delta);
  }
}

export function fakeApp(dataDir: string, self: Record<string, unknown> = {}) {
  const deltas: Partial<Delta>[] = [];
  const errors: string[] = [];
  const providers: unknown[] = [];
  const subscriptions: { match: RegExp; cb: (d: Delta) => void }[] = [];
  let unsubscribed = 0;
  const subscribed: string[] = [];
  const app = {
    handleMessage: (_id: string, msg: Partial<Delta>) => deltas.push(msg),
    setPluginStatus: () => undefined,
    setPluginError: (msg: string) => errors.push(msg),
    error: (msg: string) => errors.push(msg),
    getDataDirPath: () => dataDir,
    getSelfPath: (p: string) => self[p],
    registerResourceProvider: (p: unknown) => providers.push(p),
    subscriptionmanager: {
      subscribe: (
        cmd: { subscribe: { path: string }[] },
        unsubscribes: (() => void)[],
        _err: unknown,
        cb: (d: Delta) => void
      ) => {
        const paths = cmd.subscribe.map((s) => s.path);
        subscribed.push(...paths);
        const sub = { match: pathPattern(paths), cb };
        subscriptions.push(sub);
        unsubscribes.push(() => {
          unsubscribed++;
          subscriptions.splice(subscriptions.indexOf(sub), 1);
        });
      }
    }
  } as unknown as ServerAPI;
  return {
    app,
    deltas,
    errors,
    providers,
    send: (d: Delta) => subscriptions.forEach((s) => deliver(d, s.match, s.cb)),
    subscribed,
    unsubscribed: () => unsubscribed
  };
}

export function fakeRouter(withAccess = true) {
  const routes = new Map<string, Handler>();
  const levels = new Map<string, string>();
  const add = (method: string) => (p: string, h: Handler) => routes.set(`${method} ${p}`, h);
  const plain = { get: add("GET"), post: add("POST"), delete: add("DELETE") };
  const scoped = (level: string) => {
    const reg = (method: string) => (p: string, h: Handler) => {
      levels.set(`${method} ${p}`, level);
      return add(method)(p, h);
    };
    return { get: reg("GET"), post: reg("POST"), delete: reg("DELETE") };
  };
  const router = withAccess ? { ...plain, access: scoped } : plain;
  const call = (
    p: string,
    query: Record<string, string> = {},
    params: Record<string, string> = {}
  ) => {
    let body: unknown;
    let code = 200;
    let type: string | undefined;
    const res: FakeRes = {
      json: (b) => (body = b),
      send: (b) => (body = b),
      type: (t) => {
        type = t;
        return res;
      },
      status: (c) => {
        code = c;
        return { ...res, end: () => undefined };
      }
    };
    routes.get(`GET ${p}`)?.({ query, params }, res);
    return { code, body, type };
  };
  const del = (p: string, params: Record<string, string>) =>
    new Promise<{ code: number; body: unknown }>((resolve) => {
      let code = 200;
      const res: FakeRes = {
        json: (b) => resolve({ code, body: b }),
        send: (b) => resolve({ code, body: b }),
        type: () => res,
        status: (c) => {
          code = c;
          return { ...res, end: () => resolve({ code, body: undefined }) };
        }
      };
      routes.get(`DELETE ${p}`)?.({ params }, res);
    });
  const post = (p: string, reqBody: unknown) =>
    new Promise<{ code: number; body: unknown }>((resolve) => {
      let code = 200;
      const res: FakeRes = {
        json: (b) => resolve({ code, body: b }),
        send: (b) => resolve({ code, body: b }),
        type: () => res,
        status: (c) => {
          code = c;
          return { ...res, end: () => resolve({ code, body: undefined }) };
        }
      };
      routes.get(`POST ${p}`)?.({ body: reqBody }, res);
    });
  return { router, call, post, del, levels };
}

export function values(deltas: Partial<Delta>[]) {
  return deltas.flatMap((d) => (d.updates ?? []).flatMap((u) => ("values" in u ? u.values : [])));
}

export function lastValue(deltas: Partial<Delta>[], p: string): unknown {
  return values(deltas)
    .filter((v) => v.path === p)
    .pop()?.value;
}

export function notificationCount(deltas: Partial<Delta>[]): number {
  return values(deltas).filter((v) => v.path === "notifications.navigation.underKeel").length;
}

export const T0 = Date.parse("2026-10-17T12:00:00Z");

export function navDelta(lon: number, lat: number, sog: number, at: number): Delta {
  return {
    updates: [
      {
        timestamp: new Date(at).toISOString() as never,
        values: [
          { path: "navigation.position" as never, value: { latitude: lat, longitude: lon } },
          { path: "navigation.courseOverGroundTrue" as never, value: Math.PI / 2 },
          { path: "navigation.speedOverGround" as never, value: sog },
          { path: "navigation.headingTrue" as never, value: Math.PI / 2 }
        ]
      }
    ]
  };
}
