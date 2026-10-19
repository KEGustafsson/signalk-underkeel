import fs from "fs";
import path from "path";

/**
 * A validator for the JSON Schema keywords the navigation-safety schemas
 * use. Any other keyword throws, so a schema can never pass because a
 * keyword was silently ignored.
 */

type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "title", "description"]);
const KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "maxLength",
  "pattern",
  "anyOf",
  "$ref"
]);

export const SCHEMA_DIR = path.resolve(__dirname, "..", "..", "schemas", "navigation-safety");

export class Validator {
  private readonly files = new Map<string, Schema>();

  constructor(dir = SCHEMA_DIR) {
    for (const f of fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json") && n !== "package.json")) {
      this.files.set(f, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Schema);
    }
  }

  names(): string[] {
    return [...this.files.keys()];
  }

  /** Errors for `value` against schema file `name`; empty when valid. */
  validate(name: string, value: unknown): string[] {
    const schema = this.files.get(name);
    if (!schema) {
      throw new Error(`no schema ${name}`);
    }
    const errors: string[] = [];
    this.check(schema, name, value, "$", errors);
    return errors;
  }

  private resolve(ref: string, file: string): { schema: Schema; file: string } {
    const [target, pointer = ""] = ref.split("#");
    const f = target === "" || target === undefined ? file : target;
    let node: unknown = this.files.get(f);
    for (const part of pointer.split("/").filter((p) => p !== "")) {
      node = (node as Record<string, unknown> | undefined)?.[part];
    }
    if (!node) {
      throw new Error(`unresolved $ref ${ref} from ${file}`);
    }
    return { schema: node as Schema, file: f };
  }

  private check(s: Schema, file: string, v: unknown, at: string, errors: string[]): void {
    for (const k of Object.keys(s)) {
      if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) {
        throw new Error(`unsupported keyword ${k} in ${file}`);
      }
    }
    if (typeof s.$ref === "string") {
      const r = this.resolve(s.$ref, file);
      this.check(r.schema, r.file, v, at, errors);
    }
    if (Array.isArray(s.anyOf)) {
      this.anyOf(s.anyOf as Schema[], file, v, at, errors);
    }
    if (s.type !== undefined && !this.typeOk(s.type as string | string[], v)) {
      errors.push(`${at}: expected ${String(s.type)}, got ${JSON.stringify(v)}`);
      return;
    }
    if (s.enum && !(s.enum as unknown[]).includes(v)) {
      errors.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
    }
    if ("const" in s && s.const !== v) {
      errors.push(`${at}: expected ${JSON.stringify(s.const)}`);
    }
    if (typeof v === "number") {
      this.numeric(s, v, at, errors);
    }
    if (typeof v === "string" && typeof s.pattern === "string" && !new RegExp(s.pattern).test(v)) {
      errors.push(`${at}: ${JSON.stringify(v)} does not match ${s.pattern}`);
    }
    if (typeof v === "string" && typeof s.maxLength === "number" && v.length > s.maxLength) {
      errors.push(`${at}: longer than ${s.maxLength} characters`);
    }
    if (Array.isArray(v)) {
      this.array(s, file, v, at, errors);
    } else if (typeof v === "object" && v !== null) {
      this.object(s, file, v as Record<string, unknown>, at, errors);
    }
  }

  /** Each branch is checked on its own; the value passes when one branch has no errors. */
  private anyOf(branches: Schema[], file: string, v: unknown, at: string, errors: string[]): void {
    const failures: string[] = [];
    for (const b of branches) {
      const e: string[] = [];
      this.check(b, file, v, at, e);
      if (e.length === 0) {
        return;
      }
      failures.push(e.join(", "));
    }
    errors.push(`${at}: matches no anyOf branch (${failures.join("; ")})`);
  }

  private typeOk(type: string | string[], v: unknown): boolean {
    const types = Array.isArray(type) ? type : [type];
    return types.some((t) => {
      switch (t) {
        case "null":
          return v === null;
        case "integer":
          return Number.isInteger(v);
        case "number":
          return typeof v === "number" && Number.isFinite(v);
        case "array":
          return Array.isArray(v);
        case "object":
          return typeof v === "object" && v !== null && !Array.isArray(v);
        default:
          return typeof v === t;
      }
    });
  }

  private numeric(s: Schema, v: number, at: string, errors: string[]): void {
    if (typeof s.minimum === "number" && v < s.minimum) {
      errors.push(`${at}: ${v} < ${s.minimum}`);
    }
    if (typeof s.maximum === "number" && v > s.maximum) {
      errors.push(`${at}: ${v} > ${s.maximum}`);
    }
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) {
      errors.push(`${at}: ${v} ≤ ${s.exclusiveMinimum}`);
    }
  }

  private array(s: Schema, file: string, v: unknown[], at: string, errors: string[]): void {
    if (typeof s.minItems === "number" && v.length < s.minItems) {
      errors.push(`${at}: fewer than ${s.minItems} items`);
    }
    if (typeof s.maxItems === "number" && v.length > s.maxItems) {
      errors.push(`${at}: more than ${s.maxItems} items`);
    }
    if (s.items) {
      v.forEach((item, i) => this.check(s.items as Schema, file, item, `${at}[${i}]`, errors));
    }
  }

  private object(
    s: Schema,
    file: string,
    v: Record<string, unknown>,
    at: string,
    errors: string[]
  ): void {
    for (const key of (s.required as string[] | undefined) ?? []) {
      if (!(key in v) || v[key] === undefined) {
        errors.push(`${at}: missing ${key}`);
      }
    }
    const props = (s.properties as Record<string, Schema> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (v[key] !== undefined) {
        this.check(sub, file, v[key], `${at}.${key}`, errors);
      }
    }
  }
}
