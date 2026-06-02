import type {
  CorrespondenceCompute,
  AutoDetectInput,
  AutoDetectResult,
  ApplyWarpInput,
  ApplyWarpResult,
} from "@zettaai/edit-session";

/** v1 stub; throws on every method. Real implementation deferred to v2 per architecture decision. */
export class NgCorrespondenceCompute implements CorrespondenceCompute {
  async autoDetect(_input: AutoDetectInput): Promise<AutoDetectResult> {
    throw new Error(
      "NgCorrespondenceCompute.autoDetect not yet implemented (deferred)",
    );
  }
  async applyWarp(_input: ApplyWarpInput): Promise<ApplyWarpResult> {
    throw new Error(
      "NgCorrespondenceCompute.applyWarp not yet implemented (deferred)",
    );
  }
}
