import { getAuditLogByActorId } from './AuditLog';
import { getSession } from '../db/queries';
import { getProjectById } from '../config';
import {
  loadOrchestratorConfig,
  resolvePreGrantCapabilities,
} from '../session/orchestrator-config';

type CapabilityProvenance = 'auto' | 'operator' | 'config';

export interface CapabilityGrant {
  capability: string;
  provenance: CapabilityProvenance;
}

/**
 * The session's live-resolved `capability_pre_grants` list (see
 * orchestrator-config.ts#resolvePreGrantCapabilities) — recomputed from the
 * session's current project + sessionType + taskId rather than read off a
 * stored marker, since a pre-grant seeds directly into the same
 * granted_capabilities column an operator/auto grant does (see
 * db/queries.ts#seedGrantedCapabilities) and leaves no other trace. Returns
 * `[]` when the session or its project can't be resolved.
 */
function resolveLivePreGrants(sessionId: string): string[] {
  const session = getSession(sessionId);
  if (!session?.project_id) return [];
  const project = getProjectById(session.project_id);
  if (!project) return [];
  return resolvePreGrantCapabilities(
    loadOrchestratorConfig(project.projectDir),
    session.session_type,
    session.task_id,
  );
}

/**
 * Classify each of a session's granted capabilities as config-, auto-, or
 * operator-approved. A capability present in the session's live-resolved
 * `capability_pre_grants` list is classified as config regardless of audit
 * trail — a pre-grant is seeded at spawn time and never generates a
 * capability_request_disposition entry (see resolveLivePreGrants above).
 * Everything else falls back to the capability_request_disposition audit
 * trail (see routes/stagedIntents.ts resumeCapabilityRequester). A
 * capability with no matching *_approved disposition entry — e.g. granted
 * before this provenance tracking existed — defaults to operator, matching
 * the historical behavior where granted_capabilities was operator-approved
 * only.
 */
export function deriveCapabilityProvenance(
  sessionId: string,
  capabilities: string[],
): CapabilityGrant[] {
  const preGranted = new Set(resolveLivePreGrants(sessionId));
  const provenanceByCapability = new Map<string, CapabilityProvenance>();
  for (const entry of getAuditLogByActorId(sessionId)) {
    if (entry.eventType !== 'capability_request_disposition') continue;
    const payload = entry.payload as {
      capability?: string;
      disposition?: string;
      provenance?: string;
    };
    if (
      payload.disposition !== 'auto_approved' &&
      payload.disposition !== 'operator_approved'
    ) {
      continue;
    }
    if (!payload.capability) continue;
    provenanceByCapability.set(
      payload.capability,
      payload.provenance === 'auto' ? 'auto' : 'operator',
    );
  }

  return capabilities.map((capability) => ({
    capability,
    provenance: preGranted.has(capability)
      ? 'config'
      : (provenanceByCapability.get(capability) ?? 'operator'),
  }));
}
