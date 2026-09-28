const ID = /^[A-Za-z0-9_-]{1,128}$/;

const boundedIdentifier = (value) =>
  typeof value === "string" && ID.test(value) ? value : null;

const boundedMessage = (value) => {
  if (typeof value !== "string") return null;
  return value
    .replace(/(?:bearer|token|secret|password|api[-_ ]?key)\s*[:=]?\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 160);
};

const readProviderError = async (response) => {
  const value = await response.json().catch(() => null);
  const source = value?.error && typeof value.error === "object" ? value.error : value;
  return {
    providerError: boundedMessage(source?.message || (typeof value?.error === "string" ? value.error : null)),
    providerErrorCode: boundedIdentifier(source?.code || value?.code),
  };
};

export function resolveVercelPreviewBinding(environment = {}) {
  const explicitProject = environment.NOVA_BRAIN_VERCEL_PROJECT_ID || null;
  const systemProject = environment.VERCEL_PROJECT_ID || null;
  const explicitTeam = environment.NOVA_BRAIN_VERCEL_TEAM_ID || null;
  const systemTeam = environment.VERCEL_TEAM_ID || null;
  const projectBindingMatch = !explicitProject || !systemProject || explicitProject === systemProject;
  const teamBindingMatch = !explicitTeam || !systemTeam || explicitTeam === systemTeam;
  const binding = {
    token: environment.NOVA_BRAIN_VERCEL_TOKEN || null,
    projectId: explicitProject || systemProject,
    teamId: explicitTeam || systemTeam,
    projectBindingMatch,
    teamBindingMatch,
  };
  if (!binding.token || !binding.projectId || !binding.teamId || !projectBindingMatch || !teamBindingMatch) {
    throw Object.assign(new Error("Vercel Preview discovery is not bound to one verified project and team."), {
      code: "deployment_discovery_not_configured",
      retryable: false,
      safeDiagnostics: {
        stage: "configuration",
        upstreamStatus: null,
        providerError: null,
        providerErrorCode: null,
        credentialConfigured: Boolean(binding.token),
        projectBindingMatch,
        teamBindingMatch,
      },
    });
  }
  return binding;
}

const deploymentRecord = (value) => ({
  id: value?.uid || value?.id,
  url: value?.url,
  status: value?.readyState || value?.state,
  target: value?.target,
  sha: value?.gitSource?.sha || value?.meta?.githubCommitSha,
  branch: value?.gitSource?.ref || value?.meta?.githubCommitRef,
});

const providerFailure = async ({response, stage, binding}) => {
  const provider = await readProviderError(response);
  const error = Object.assign(new Error(stage === "discovery" ? "Preview discovery failed." : "Preview verification failed."), {
    code: stage === "discovery" ? "deployment_discovery_failed" : "deployment_verification_failed",
    retryable: response.status === 429 || response.status >= 500,
    safeDiagnostics: {
      stage,
      upstreamStatus: response.status,
      ...provider,
      projectBindingMatch: binding.projectBindingMatch,
      teamBindingMatch: binding.teamBindingMatch,
    },
  });
  throw error;
};

export function createVercelPreviewClient({environment = {}, fetchImpl = globalThis.fetch} = {}) {
  const findPreview = async ({commitSha, branch}) => {
    const binding = resolveVercelPreviewBinding(environment);
    const query = new URLSearchParams({
      projectId: binding.projectId,
      teamId: binding.teamId,
      limit: "100",
      target: "preview",
      sha: commitSha,
      branch,
    });
    const response = await fetchImpl(`https://api.vercel.com/v6/deployments?${query}`, {
      headers: {Authorization: `Bearer ${binding.token}`},
    });
    if (!response.ok) await providerFailure({response, stage: "discovery", binding});
    const values = (await response.json().catch(() => null))?.deployments;
    if (!Array.isArray(values)) {
      throw Object.assign(new Error("Preview discovery returned an invalid response."), {
        code: "deployment_discovery_failed",
        retryable: true,
        safeDiagnostics: {
          stage: "discovery_response",
          upstreamStatus: response.status,
          providerError: "invalid_response",
          providerErrorCode: null,
          projectBindingMatch: binding.projectBindingMatch,
          teamBindingMatch: binding.teamBindingMatch,
        },
      });
    }
    const match = values.map(deploymentRecord).find((value) =>
      value.sha === commitSha && value.branch === branch && value.target !== "production",
    );
    return match || null;
  };

  const verifyDeployment = async ({deploymentId}) => {
    const binding = resolveVercelPreviewBinding(environment);
    const query = new URLSearchParams({teamId: binding.teamId});
    const response = await fetchImpl(`https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}?${query}`, {
      headers: {Authorization: `Bearer ${binding.token}`},
    });
    if (!response.ok) await providerFailure({response, stage: "verification", binding});
    return deploymentRecord(await response.json());
  };

  return Object.freeze({findPreview, verifyDeployment});
}
