// What the models read as data goes in a fenced JSON block. A backtick inside it is written as the JSON escape \u0060,
// which reads the same once parsed: text from a site can then never close the fence and pass for instructions after it.
export const jsonBlock = (label: string, value: unknown): string =>
  `${label}:\n\`\`\`json\n${JSON.stringify(value, null, 1).replace(/`/g, '\\u0060')}\n\`\`\``;
