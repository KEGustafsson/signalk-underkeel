/**
 * Object schemas as an admin UI that drops `dependencies` needs them: every branch's fields
 * merged into `properties` (`config-schema.ts`, SCHEMA).
 */

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Two object schemas as one: `b`'s fields after `a`'s, a field in both merged the same way. */
function mergeObjects(a: Json, b: Json): Json {
  const properties: Json = { ...(a.properties as Json) };
  for (const [key, value] of Object.entries(b.properties as Json)) {
    const prev = properties[key];
    if (prev === undefined) {
      properties[key] = value;
    } else if (isObject(prev) && isObject(value) && isObject(prev.properties)) {
      properties[key] = mergeObjects(prev, value);
    }
  }
  const dependencies = { ...(a.dependencies as Json), ...(b.dependencies as Json) };
  return { ...a, properties, ...(Object.keys(dependencies).length ? { dependencies } : {}) };
}

/**
 * The schema with every field shown at once: the fields of every
 * `dependencies` branch merged into `properties`, all but the field that
 * switches the branch, and without showExpert, which then shows nothing.
 */
export function flatten(schema: Json): Json {
  if (!isObject(schema.properties)) {
    return schema;
  }
  const { dependencies, ...rest } = schema;
  let merged: Json = rest;
  for (const [key, dep] of Object.entries(isObject(dependencies) ? dependencies : {})) {
    for (const branch of (isObject(dep) && Array.isArray(dep.oneOf) ? dep.oneOf : []) as Json[]) {
      const { [key]: _switch, ...fields } = (branch.properties ?? {}) as Json;
      merged = mergeObjects(merged, { properties: fields });
    }
  }
  const properties = Object.fromEntries(
    Object.entries(merged.properties as Json)
      .filter(([key]) => key !== "showExpert")
      .map(([key, value]) => [key, isObject(value) ? flatten(value) : value])
  );
  const { dependencies: _left, ...flat } = merged;
  return { ...flat, properties };
}
