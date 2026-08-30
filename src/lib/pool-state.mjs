// One reusable loader for public pool state — every network, every visit.
//
// Guarantees:
//   - cold visitor (no cache): snapshot (66k gz) -> paint <200ms -> tail since snapshot block
//   - warm visitor: freshest of (shipped snapshot, compact cache) by block, no rewind
//   - tip: no event fetch at all when snapshot/cache is at head
//   - offline / RPC down: still paints from snapshot
//
// The shape returned is exactly what the frontend renders, so App.jsx stays thin:
//   { block, fee, feeHistory, entryHist: Map<BigInt,count>, exitHist: Map| null, txBlocks: number[], counts, source, stale? }
// No React, no component branching, fully testable.