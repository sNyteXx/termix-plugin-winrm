import { DOMParser, type Document, type Element } from "@xmldom/xmldom";

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

/** Escapes text for an XML element or a double-quoted attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Parses a response document. A server or a man in the middle could send
 * anything, so malformed XML and DOCTYPEs (entity expansion) are refused.
 */
export function parseXml(text: string): Document {
  if (/<!DOCTYPE/i.test(text))
    throw new XmlError("XML with a DOCTYPE is refused");
  let failure: string | null = null;
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== "warning" && !failure) failure = String(message);
    },
  });
  let doc: Document;
  try {
    doc = parser.parseFromString(text.replace(/^\uFEFF/, ""), "text/xml");
  } catch (error) {
    throw new XmlError(`Invalid XML: ${(error as Error).message}`);
  }
  if (failure || !doc.documentElement)
    throw new XmlError(`Invalid XML: ${failure ?? "empty"}`);
  return doc;
}

export function childElements(element: Element): Element[] {
  const out: Element[] = [];
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) out.push(node as Element);
  }
  return out;
}

/** Every descendant with this local name, in document order. */
export function findAll(
  root: Element | Document,
  localName: string,
): Element[] {
  const out: Element[] = [];
  const start = "documentElement" in root ? root.documentElement : root;
  if (!start) return out;
  const walk = (element: Element) => {
    if (element.localName === localName) out.push(element);
    for (const child of childElements(element)) walk(child);
  };
  walk(start);
  return out;
}

export function findFirst(
  root: Element | Document,
  localName: string,
): Element | null {
  return findAll(root, localName)[0] ?? null;
}

export function textOf(element: Element | null): string {
  return element?.textContent ?? "";
}
