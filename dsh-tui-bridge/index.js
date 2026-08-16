/**
 * dsh-tui-bridge — the extension seam as its own brick.
 *
 * All dsh-tui-* bricks inject ["tuiExtensions"]; the service is provided HERE
 * (not inside tui-runner) so the activation graph stays acyclic and
 * dependency-free: bridge activates synchronously first, then bricks, then
 * the TUI runner consumes the same service. This mirrors dsh's composition
 * philosophy — even the seam is a pluggable piece.
 *
 * @module dsh-tui-bridge
 */

import { createExtensions } from "./extensions.js";

export const name = "dsh-tui-bridge";
export const inject = [];

export function apply(ctx) {
  const ext = createExtensions();
  ctx.provide("tuiExtensions", ext);
  ctx.logger.info("[dsh-tui-bridge] tuiExtensions seam ready");
}
