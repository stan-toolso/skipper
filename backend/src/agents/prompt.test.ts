import { describe, expect, it } from "vitest";
import { agentIdentityPrompt, roleRulesPrompt } from "./prompt.js";
import type { Agent } from "./types.js";

const agent = {
  id: "a1",
  projectId: "p1",
  name: "Ben",
  kind: "developer",
  description: "",
  instructions: "",
} as unknown as Agent;

describe("agentIdentityPrompt : comptes git prêtés", () => {
  it("lecture seule stricte : ni push ni pull request", () => {
    const text = agentIdentityPrompt(agent, { name: "Skipper" }, null, {
      githubReadOnly: true,
      githubPullRequests: false,
    });
    expect(text).toContain("Ton compte GitHub est prêté en lecture seule");
    expect(text).toContain("ni pousser une branche ni ouvrir de pull request");
    expect(text).not.toContain("pull requests permises");
  });

  it("lecture seule avec pull requests permises : tasks.pr_open seulement", () => {
    const text = agentIdentityPrompt(agent, { name: "Skipper" }, null, {
      githubReadOnly: true,
      githubPullRequests: true,
      gitlabReadOnly: true,
      gitlabPullRequests: false,
    });
    expect(text).toContain(
      "Ton compte GitHub est prêté en lecture seule, pull requests permises",
    );
    expect(text).toContain("tasks.pr_open");
    expect(text).toContain(
      "Ton compte GitLab est prêté en lecture seule : sur GitLab",
    );
  });

  it("écriture avec fusion permise : tasks.pr_merge fusionne sans demande", () => {
    const text = agentIdentityPrompt(agent, { name: "Skipper" }, null, {
      githubPullRequests: true,
      githubMerge: true,
    });
    expect(text).toContain("Ton compte GitHub est prêté en écriture, fusion permise");
    expect(text).toContain("fusionne directement avec ce compte");
    expect(text).not.toContain("Tu ne fusionnes jamais une pull request de ta propre initiative");
    expect(roleRulesPrompt({ kind: "developer" })).toContain("Tu ne fusionnes jamais");
  });

  it("comptes en écriture : rien à signaler", () => {
    expect(
      agentIdentityPrompt(agent, { name: "Skipper" }, null, {
        githubPullRequests: true,
      }),
    ).not.toContain("lecture seule");
  });
});

describe("agentIdentityPrompt : règles du rôle et prise en main", () => {
  const pm = { ...agent, name: "Chris", kind: "product_manager" } as Agent;

  it("un Product Manager ne livre pas de code et confie le correctif au développeur", () => {
    const text = agentIdentityPrompt(pm, { name: "Skipper" }, null, {});
    expect(text).toContain("Règles de ton rôle");
    expect(text).toContain("tu n'ouvres pas de pull request");
    expect(text).toContain("confie-la tout de suite à l'agent développeur");
    expect(roleRulesPrompt({ kind: "custom" })).toBe("");
  });

  it("prise en main : comptes de la personne, règles du rôle et lecture seule levées", () => {
    const text = agentIdentityPrompt(
      pm,
      { name: "Skipper" },
      null,
      { githubReadOnly: true, githubPullRequests: false },
      { name: "Stan", email: "stan@toolso.io" },
    );
    expect(text).toContain("Stan (stan@toolso.io) a pris la main sur cette session");
    expect(text).not.toContain("Règles de ton rôle");
    expect(text).not.toContain("lecture seule");
  });
});
