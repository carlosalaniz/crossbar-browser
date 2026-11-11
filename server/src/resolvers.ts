// SPDX-License-Identifier: AGPL-3.0-only
// Challenge resolver seam (ADR 0001). v1 has one resolver: human takeover.
// A resolver never decides success; the verifier does. kind "login" always goes to a person.
import type { BlockState } from "@crossbar/detect";
import type { InputEvent } from "@crossbar/browser/pool";

/** Narrow by design: the screen, input, and the origin. No CDP, no cookies. */
export interface ResolverSession {
  readonly origin: string;
  stream(onFrame: (jpegBase64: string) => void): Promise<() => Promise<void>>;
  input(ev: InputEvent): Promise<void>;
}

export interface ChallengeResolver {
  readonly id: string;
  /** Human resolvers may take anything; any non-human resolver must refuse kind "login". */
  readonly human: boolean;
  canResolve(block: BlockState): boolean;
  /** Work the challenge. Returning means "I think I'm done"; the verifier decides. */
  resolve(block: BlockState, session: ResolverSession): Promise<void>;
}

export interface Verifier {
  /** True if the block is gone and the expected content is there. */
  verify(block: BlockState): Promise<boolean>;
}

/** Human takeover: a person drives the live view from the web app and taps "I'm done". */
export class HumanTakeoverResolver implements ChallengeResolver {
  readonly id = "human-takeover";
  readonly human = true;
  canResolve(): boolean {
    return true;
  }
  async resolve(): Promise<void> {
    // The web app streams frames and forwards input through the ResolverSession while the ticket is claimed.
  }
}

/** Picks a resolver for a block, enforcing the rules that don't depend on configuration. */
export function chooseResolver(block: BlockState, allowed: ChallengeResolver[]): ChallengeResolver | null {
  for (const r of allowed) {
    if (block.kind === "login" && !r.human) continue;
    if (r.canResolve(block)) return r;
  }
  return null;
}
