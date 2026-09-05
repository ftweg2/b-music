import { addCandidateInteraction, getDatabase } from "./db";
import { replayMutation, recordMutation } from "./apiIdempotency";
import type { CandidateInteraction, InteractionAction } from "./models";

export function recordInteraction(candidateId: number, action: InteractionAction, ownerId: string, key?: string): CandidateInteraction {
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const input = { candidateId, action };
    const operation = "candidate.interaction";
    const replay = replayMutation<CandidateInteraction>(ownerId, operation, key, input);
    const result = replay ?? addCandidateInteraction(candidateId, action, ownerId);
    if (!replay) recordMutation(ownerId, operation, key, input, result);
    db.exec("COMMIT");
    return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
