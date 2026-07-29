import { getAuditLogByActorId } from './AuditLog';

export type CapabilityProvenance = 'auto' | 'operator';

export interface CapabilityGrant {
  capability: string;
  provenance: CapabilityProvenance;
}

/**
 * Classify each of a session's granted capabilities as auto- or
 * operator-approved, derived from its capability_request_disposition audit
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
    provenance: provenanceByCapability.get(capability) ?? 'operator',
  }));
}
