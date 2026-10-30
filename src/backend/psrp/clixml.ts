import type { Element } from "@xmldom/xmldom";
import { XmlError, childElements, escapeXml, parseXml } from "../winrm/xml.js";

/*
 * The slice of PowerShell's CLIXML (MS-PSRP 2.2.5) the plugin needs: a reader
 * that turns any server object into plain data, and writers for the few
 * messages the client sends.
 */

// ---------------------------------------------------------------- strings

/** Encodes a string the way PowerShell's serializer does (MS-PSRP 2.2.5.1.1). */
export function encodePsString(value: string): string {
  const escaped = value
    .replace(/_([xX])/g, "_x005F_$1")
    .replace(
      /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g,
      (match) =>
        Array.from(
          { length: match.length },
          (_, i) =>
            `_x${match.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}_`,
        ).join(""),
    );
  return escapeXml(escaped);
}

/** Reverses encodePsString on already XML-decoded text. */
export function decodePsString(value: string): string {
  return value.replace(/_[xX]([0-9a-fA-F]{4})_/g, (_, code: string) =>
    String.fromCharCode(parseInt(code, 16)),
  );
}

// ---------------------------------------------------------------- reading

export interface PsObject {
  kind: "object";
  typeNames: string[];
  toString: string | null;
  /** Extended (<MS>) and adapted (<Props>) members, merged. */
  props: Record<string, PsValue>;
  /** The wrapped primitive of an enum or a primitive with type names. */
  value?: PsValue;
  list?: PsValue[];
  dict?: Array<[PsValue, PsValue]>;
}

export type PsValue =
  null | string | number | boolean | bigint | PsValue[] | PsObject;

export function isPsObject(value: PsValue | undefined): value is PsObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort text for any value, like PowerShell's ToString(). */
export function psToString(value: PsValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(psToString).join(" ");
  if (isPsObject(value)) {
    if (value.toString !== null) return value.toString;
    if (value.value !== undefined) return psToString(value.value);
    if (value.list) return value.list.map(psToString).join(" ");
    return value.typeNames[0] ?? "";
  }
  return String(value);
}

export function prop(
  value: PsValue | undefined,
  ...path: string[]
): PsValue | undefined {
  let current: PsValue | undefined = value;
  for (const name of path) {
    if (!isPsObject(current)) return undefined;
    current = current.props[name];
  }
  return current;
}

export function propString(
  value: PsValue | undefined,
  ...path: string[]
): string | null {
  const found = prop(value, ...path);
  if (found === undefined || found === null) return null;
  return psToString(found);
}

export function propNumber(
  value: PsValue | undefined,
  ...path: string[]
): number | null {
  const found = prop(value, ...path);
  if (typeof found === "number") return found;
  if (typeof found === "bigint") return Number(found);
  if (isPsObject(found) && typeof found.value === "number") return found.value;
  return null;
}

export function propBool(
  value: PsValue | undefined,
  ...path: string[]
): boolean | null {
  const found = prop(value, ...path);
  return typeof found === "boolean" ? found : null;
}

const MAX_DEPTH = 64;
const MAX_NODES = 200_000;

/** A reader for one message: RefIds are scoped to the message they appear in. */
class Reader {
  private readonly objects = new Map<string, PsObject>();
  private readonly typeNames = new Map<string, string[]>();
  private depth = 0;
  private nodes = 0;

  read(element: Element): PsValue {
    if (++this.nodes > MAX_NODES)
      throw new XmlError("CLIXML object is too large");
    if (++this.depth > MAX_DEPTH) throw new XmlError("CLIXML nests too deep");
    try {
      return this.readInner(element);
    } finally {
      this.depth--;
    }
  }

  private readInner(element: Element): PsValue {
    const text = element.textContent ?? "";
    switch (element.localName) {
      case "Nil":
        return null;
      case "S":
      case "URI":
      case "XD":
      case "SBK":
      case "G":
      case "Version":
      case "DT":
      case "TS":
        return decodePsString(text);
      case "Ch":
        return String.fromCharCode(Number(text));
      case "B":
        return text.trim().toLowerCase() === "true";
      case "By":
      case "SB":
      case "U16":
      case "I16":
      case "U32":
      case "I32":
      case "Sg":
      case "Db":
      case "D":
        return Number(text);
      case "U64":
      case "I64": {
        const big = BigInt(text.trim() || "0");
        return big >= BigInt(Number.MIN_SAFE_INTEGER) &&
          big <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(big)
          : big;
      }
      case "BA":
        return text;
      case "SS":
        // Secure strings need a session key the plugin never sets up.
        return "<SecureString>";
      case "Ref": {
        const target = this.objects.get(element.getAttribute("RefId") ?? "");
        return target ?? null;
      }
      case "Obj":
        return this.readObject(element);
      default:
        return decodePsString(text);
    }
  }

  private readObject(element: Element): PsObject {
    const object: PsObject = {
      kind: "object",
      typeNames: [],
      toString: null,
      props: {},
    };
    const refId = element.getAttribute("RefId");
    if (refId) this.objects.set(refId, object);

    for (const child of childElements(element)) {
      switch (child.localName) {
        case "TN": {
          const names = childElements(child).map((t) => t.textContent ?? "");
          const id = child.getAttribute("RefId");
          if (id) this.typeNames.set(id, names);
          object.typeNames = names;
          break;
        }
        case "TNRef":
          object.typeNames =
            this.typeNames.get(child.getAttribute("RefId") ?? "") ?? [];
          break;
        case "ToString":
          object.toString = decodePsString(child.textContent ?? "");
          break;
        case "MS":
        case "Props":
          for (const member of childElements(child)) {
            const name = member.getAttribute("N");
            if (name) object.props[decodePsString(name)] = this.read(member);
          }
          break;
        case "LST":
        case "IE":
        case "QUE":
        case "STK":
          object.list = childElements(child).map((item) => this.read(item));
          break;
        case "DCT":
          object.dict = childElements(child).map((entry) => {
            let key: PsValue = null;
            let value: PsValue = null;
            for (const part of childElements(entry)) {
              if (part.getAttribute("N") === "Key") key = this.read(part);
              else if (part.getAttribute("N") === "Value")
                value = this.read(part);
            }
            return [key, value];
          });
          break;
        default:
          object.value = this.read(child);
      }
    }
    return object;
  }
}

/** Parses the XML of one PSRP message body. */
export function readClixml(xml: string): PsValue {
  const doc = parseXml(xml);
  return new Reader().read(doc.documentElement as unknown as Element);
}

// ---------------------------------------------------------------- writing

const ENUM_TYPES = ["System.Enum", "System.ValueType", "System.Object"];

/** Builds CLIXML with RefIds and TN references numbered like PowerShell does. */
export class ClixmlWriter {
  private objectId = 0;
  private readonly typeIds = new Map<string, number>();

  nextRef(): number {
    return this.objectId++;
  }

  typeNames(names: string[]): string {
    const key = names.join("|");
    const known = this.typeIds.get(key);
    if (known !== undefined) return `<TNRef RefId="${known}" />`;
    const id = this.typeIds.size;
    this.typeIds.set(key, id);
    return `<TN RefId="${id}">${names.map((n) => `<T>${escapeXml(n)}</T>`).join("")}</TN>`;
  }

  enumObj(name: string, type: string, label: string, value: number): string {
    return (
      `<Obj N="${name}" RefId="${this.nextRef()}">${this.typeNames([type, ...ENUM_TYPES])}` +
      `<ToString>${escapeXml(label)}</ToString><I32>${value}</I32></Obj>`
    );
  }
}

export function str(name: string, value: string | null): string {
  return value === null
    ? `<Nil N="${name}" />`
    : `<S N="${name}">${encodePsString(value)}</S>`;
}

export function bool(name: string, value: boolean | null): string {
  return value === null ? `<Nil N="${name}" />` : `<B N="${name}">${value}</B>`;
}

export function i32(name: string, value: number): string {
  return `<I32 N="${name}">${Math.trunc(value)}</I32>`;
}
