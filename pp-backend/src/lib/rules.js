// Code-level approval gate — identical to needsApprovalByRule() in pp-command-ronin.html.
// Anything stock/order/pricing/staffing/money-shaped requires the site manager's approval
// regardless of what the caller (human or Ronin) passed.
export const APPROVAL_KEYWORDS = /\b(stock|order|par|price|pricing|menu|roster|shift|staff|wage|pay|invoice|refund|discount|transfer|send|move|supplier|purchase|delete|remove)\b/i;
export function needsApprovalByRule(intent, note) {
  const norm = v => String(v || '').replace(/[_\-]+/g, ' ');
  return APPROVAL_KEYWORDS.test(norm(intent)) || APPROVAL_KEYWORDS.test(norm(note));
}

// Fields a site is allowed to promote. Anything else in a snapshot is rejected (400).
export const SNAPSHOT_KEYS = new Set([
  'venue_id', 'cafe_name', 'timestamp', 'revenue_week', 'gp_pct', 'labour_pct', 'covers_week',
  'stock_out', 'stock_low', 'stock_out_items', 'stock_low_items', 'stock_value', 'loyalty',
  'open_orders', 'menu_items', 'shared_payroll',
]);

// What Command may read about a site — the serializer whitelist.
export function projectSnapshot(row) {
  if (!row) return null;
  return {
    revenue_week: num(row.revenue_week), gp_pct: num(row.gp_pct), labour_pct: num(row.labour_pct),
    covers_week: row.covers_week ?? 0, stock_out: row.stock_out ?? 0, stock_low: row.stock_low ?? 0,
    stock_out_items: row.stock_out_items || [], stock_low_items: row.stock_low_items || [],
    stock_value: num(row.stock_value), open_orders: row.open_orders ?? 0, loyalty: row.loyalty || null,
    received_at: row.received_at,
  };
}
const num = v => (v == null ? 0 : Number(v));
