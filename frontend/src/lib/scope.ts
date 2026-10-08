export function parseTargets(text: string): string[] {
  return text.split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
}

export function parsePorts(text: string): number[] {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) throw new Error("add at least one port");
  return parts.map((part) => {
    const port = Number(part);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${part}`);
    return port;
  });
}
