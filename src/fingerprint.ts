import crypto from "node:crypto";

export function fingerprintJson(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function selectJsonFields(value: unknown, fields?: string[]): unknown {
  if (!fields || fields.length === 0) return value;
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return Object.fromEntries(fields.map((field) => [field, object[field]]));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
