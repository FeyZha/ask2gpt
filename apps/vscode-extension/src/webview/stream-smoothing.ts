export function streamingMarkdownFrameStep(current: string, target: string) {
  if (!target.startsWith(current)) return target.length;

  const remaining = target.length - current.length;
  return remaining <= 12
    ? 1
    : remaining <= 96
      ? Math.ceil(remaining / 8)
      : remaining <= 1_024
        ? Math.ceil(remaining / 10)
        : Math.ceil(remaining / 12);
}

export function nextStreamingMarkdown(
  current: string,
  target: string,
  step = streamingMarkdownFrameStep(current, target),
) {
  if (current === target || !target.startsWith(current)) return target;

  let end = Math.min(target.length, current.length + Math.max(1, step));

  // Never expose half of a UTF-16 surrogate pair or CRLF sequence while
  // revealing a received snapshot. Both can otherwise create one-frame
  // replacement glyphs or unstable Markdown line boundaries.
  if (end < target.length) {
    const previousCodeUnit = target.charCodeAt(end - 1);
    const nextCodeUnit = target.charCodeAt(end);
    if (
      (previousCodeUnit >= 0xd800 &&
        previousCodeUnit <= 0xdbff &&
        nextCodeUnit >= 0xdc00 &&
        nextCodeUnit <= 0xdfff) ||
      (previousCodeUnit === 0x0d && nextCodeUnit === 0x0a)
    ) {
      end += 1;
    }
  }

  return target.slice(0, end);
}
