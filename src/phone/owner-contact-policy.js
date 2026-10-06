const REASONS = new Set(["owner_requested_callback", "task_completed", "task_blocked_owner_required", "important_awaited_event", "preview_owner_test"]);

export class OwnerContactPolicyError extends Error {
  constructor(message, code = "owner_contact_policy_invalid", statusCode = 400) { super(message); this.name = "OwnerContactPolicyError"; this.code = code; this.statusCode = statusCode; }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new OwnerContactPolicyError("Owner contact policy limits are invalid.");
  return result;
}
function londonMinute(date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(value.hour) * 60 + Number(value.minute);
}
function inQuietHours(date, quietHours) {
  const parse = (value) => { const [hour, minute] = value.split(":").map(Number); return hour * 60 + minute; };
  const now = londonMinute(date), start = parse(quietHours.start), end = parse(quietHours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function createOwnerContactPolicy({ storage, ownerId, ownerNumber, deploymentEnvironment = "development", clock = () => new Date() } = {}) {
  const preview = deploymentEnvironment === "preview";
  const configured = /^\+44[1-9]\d{8,9}$/.test(String(ownerNumber || ""));
  const read = () => storage.getOwnerContactPolicy(ownerId);
  const publicPolicy = (policy) => ({ configured, preview, enabled: policy?.enabled === true, version: policy?.version || 0, allowedReasons: policy?.allowedReasons || [], quietHours: policy?.quietHours || null, cooldownMinutes: policy?.cooldownMinutes || 0, dailyLimit: policy?.dailyLimit || 0, remainingCalls: policy ? Math.max(0, policy.maximumCalls - policy.usedCalls) : 0, maximumAttempts: 1, expiresAt: policy?.expiresAt || null, pausedAt: policy?.pausedAt || null, revokedAt: policy?.revokedAt || null, updatedAt: policy?.updatedAt || null });

  return Object.freeze({
    configured,
    reasons: Object.freeze([...REASONS]),
    async status() { return publicPolicy(await read()); },
    async configure(input = {}) {
      if (!preview) throw new OwnerContactPolicyError("Owner contact grants are Preview-only in this phase.", "owner_contact_policy_preview_only", 403);
      if (!configured) throw new OwnerContactPolicyError("The verified owner phone contact is not configured server-side.", "owner_contact_number_not_configured", 503);
      const now = clock();
      const enabled = input.enabled === true;
      const allowedReasons = [...new Set((input.allowedReasons || ["preview_owner_test"]).map(String))];
      if (!allowedReasons.length || allowedReasons.some((reason) => !REASONS.has(reason))) throw new OwnerContactPolicyError("An owner contact reason is not allowed.");
      const expiresAt = new Date(input.expiresAt || now.getTime() + 60 * 60_000);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now || expiresAt.getTime() - now.getTime() > 24 * 60 * 60_000) throw new OwnerContactPolicyError("Owner contact policy expiry must be within 24 hours.");
      const maximumCalls = boundedInteger(input.maximumCalls, 2, 1, 5);
      const cooldownMinutes = boundedInteger(input.cooldownMinutes, 10, 1, 240);
      const dailyLimit = boundedInteger(input.dailyLimit, 3, 1, 5);
      const quietHours = input.quietHours && typeof input.quietHours === "object" ? { start: String(input.quietHours.start || "22:00"), end: String(input.quietHours.end || "08:00"), timezone: "Europe/London" } : { start: "22:00", end: "08:00", timezone: "Europe/London" };
      if (![quietHours.start, quietHours.end].every((value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new OwnerContactPolicyError("Quiet hours are invalid.");
      const current = await read();
      const policy = await storage.saveOwnerContactPolicy({ ownerId, version: (current?.version || 0) + 1, enabled, allowedReasons, quietHours, cooldownMinutes, dailyLimit, maximumCalls, usedCalls: 0, expiresAt: expiresAt.toISOString(), pausedAt: null, revokedAt: null });
      await storage.appendActivity({ ownerId, action: enabled ? "owner_contact_policy_enabled" : "owner_contact_policy_saved_disabled", tool: "phone_call_start", status: enabled ? "active" : "disabled", summary: enabled ? "Enabled a bounded Preview owner-contact grant." : "Saved the owner-contact policy without enabling calls.", metadata: { version: policy.version, allowedReasons, maximumCalls, expiresAt: policy.expiresAt, preview: true } });
      return publicPolicy(policy);
    },
    async disable({ revoke = false } = {}) {
      const current = await read();
      if (!current) return publicPolicy(null);
      const timestamp = clock().toISOString();
      const policy = await storage.saveOwnerContactPolicy({ ...current, enabled: false, ...(revoke ? { revokedAt: timestamp } : { pausedAt: timestamp }) });
      await storage.appendActivity({ ownerId, action: revoke ? "owner_contact_policy_revoked" : "owner_contact_policy_paused", tool: "phone_call_start", status: "disabled", summary: revoke ? "Revoked the owner-contact policy." : "Paused the owner-contact policy.", metadata: { version: policy.version } });
      return publicPolicy(policy);
    },
    async authorize({ destination, reason, sourceTaskId = null } = {}) {
      const policy = await read();
      const now = clock();
      if (!preview || !configured || !policy?.enabled || policy.pausedAt || policy.revokedAt || new Date(policy.expiresAt) <= now) return { authorized: false, reason: "inactive" };
      if (destination !== ownerNumber || !REASONS.has(reason) || !policy.allowedReasons.includes(reason)) return { authorized: false, reason: "scope_mismatch" };
      if (inQuietHours(now, policy.quietHours)) return { authorized: false, reason: "quiet_hours" };
      if (reason !== "preview_owner_test" && !sourceTaskId) return { authorized: false, reason: "grounded_source_required" };
      if (reason !== "preview_owner_test") {
        const [task, run] = await Promise.all([storage.getAutonomyTask?.(sourceTaskId, ownerId) || null, storage.getRun?.(sourceTaskId, ownerId) || null]);
        const status = task?.status || run?.status || null;
        const allowed = reason === "task_completed" ? status === "completed"
          : reason === "task_blocked_owner_required" ? ["blocked", "failed", "waiting_for_approval", "waiting_for_owner"].includes(status)
            : reason === "owner_requested_callback" ? Boolean(run)
              : ["completed", "failed", "waiting_for_approval", "waiting_for_owner"].includes(status);
        if (!allowed) return { authorized: false, reason: "grounded_source_invalid" };
      }
      if (policy.usedCalls >= policy.maximumCalls) return { authorized: false, reason: "rate_limit" };
      const calls = await storage.listPhoneCalls(ownerId, { limit: 200 });
      const dayAgo = now.getTime() - 24 * 60 * 60_000;
      const dailyOwnerCalls = calls.filter((call) => call.envelope?.destination === ownerNumber && call.envelope?.ownerContactPolicyVersion && call.attemptCount > 0 && new Date(call.updatedAt).getTime() >= dayAgo).length;
      if (dailyOwnerCalls >= policy.dailyLimit) return { authorized: false, reason: "daily_rate_limit" };
      const latest = calls.find((call) => call.envelope?.ownerContactPolicyVersion === policy.version && call.attemptCount > 0);
      if (latest && now.getTime() - new Date(latest.updatedAt).getTime() < policy.cooldownMinutes * 60_000) return { authorized: false, reason: "cooldown" };
      return { authorized: true, policyVersion: policy.version, destination: ownerNumber, reason, sourceTaskId, expiresAt: policy.expiresAt };
    },
    async consume(version) {
      const result = await storage.consumeOwnerContactPolicy(ownerId, version, clock().toISOString());
      if (!result) throw new OwnerContactPolicyError("Owner contact authority could not be claimed.", "owner_contact_policy_claim_failed", 409);
      return result;
    },
  });
}
