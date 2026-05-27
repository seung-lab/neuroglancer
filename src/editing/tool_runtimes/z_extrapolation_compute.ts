import type {
  ZExtrapolationCompute,
  PropagateMaskSliceInput,
  PropagateMaskSliceResult,
} from "@zetta-ai/edit-session";

/** v1 stub; throws on every method. Real implementation deferred to v2 per architecture decision. */
export class NgZExtrapolationCompute implements ZExtrapolationCompute {
  async propagateMaskSlice(
    _input: PropagateMaskSliceInput,
  ): Promise<PropagateMaskSliceResult> {
    throw new Error(
      "NgZExtrapolationCompute.propagateMaskSlice not yet implemented (deferred)",
    );
  }
}
