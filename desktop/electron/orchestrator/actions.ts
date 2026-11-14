/** Explicit assistant-produced dispatch envelopes work even when a desktop cannot inject new MCP tools. */
export interface DispatchAction { to: string; text: string }
export function extractDispatches(text: string): { text: string; actions: DispatchAction[] } {
  const actions: DispatchAction[] = [];
  const cleaned = text.replace(/<agent-bot-dispatch>\s*([\s\S]*?)\s*<\/agent-bot-dispatch>/g, (whole, json: string) => {
    try {
      const data = JSON.parse(json);
      if (typeof data.to !== 'string' || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 60_000) return whole;
      actions.push({ to: data.to, text: data.text.trim() }); return '';
    } catch { return whole; }
  });
  return { text: cleaned.trim(), actions: actions.slice(0, 8) };
}
